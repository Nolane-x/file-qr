import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const packageName = 'com.nolane.fileqr';
const defaultApkPath = path.resolve(process.env.FILE_QR_APK || 'release/FileQR-Android-arm64.apk');
const defaultEvidencePath = path.resolve(
  process.env.FILE_QR_ANDROID_EVIDENCE_PATH || 'android-physical-evidence.json',
);

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function adb(serial, args, { allowFailure = false } = {}) {
  const result = spawnSync('adb', serial ? ['-s', serial, ...args] : args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (result.error) throw result.error;
  if (!allowFailure && result.status !== 0) {
    throw new Error(`adb ${args.join(' ')} failed: ${String(result.stderr || result.stdout).trim()}`);
  }
  return String(result.stdout || '').trim();
}

export function parseAuthorizedDevices(output) {
  return String(output)
    .split(/\r?\n/)
    .slice(1)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [serial, state] = line.split(/\s+/, 2);
      return { serial, state };
    })
    .filter((entry) => entry.state === 'device');
}

export function boundsCenter(xml, label = 'Scan QR') {
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const node = String(xml).match(new RegExp(`<node\\b[^>]*text="${escaped}"[^>]*/?>`))?.[0];
  if (!node) return null;
  const match = node.match(/bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/);
  if (!match) return null;
  const [, x1, y1, x2, y2] = match.map(Number);
  return { x: Math.floor((x1 + x2) / 2), y: Math.floor((y1 + y2) / 2) };
}

function getProp(serial, name) {
  return adb(serial, ['shell', 'getprop', name]);
}

function uiDump(serial) {
  adb(serial, ['shell', 'uiautomator', 'dump', '/sdcard/fileqr-ui.xml']);
  return adb(serial, ['shell', 'cat', '/sdcard/fileqr-ui.xml']);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(predicate, timeoutMs, intervalMs = 500) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const value = await predicate();
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    await sleep(intervalMs);
  }
  if (lastError) throw lastError;
  return null;
}

export async function collectPhysicalAndroidEvidence({
  apkPath = defaultApkPath,
  evidencePath = defaultEvidencePath,
} = {}) {
  if (!fs.existsSync(apkPath)) {
    throw new Error(`Android APK not found: ${apkPath}`);
  }

  const devices = parseAuthorizedDevices(adb('', ['devices', '-l']));
  if (devices.length !== 1) {
    throw new Error(`Physical Android evidence requires exactly one authorized ADB device; found ${devices.length}`);
  }

  const serial = devices[0].serial;
  const qemu = getProp(serial, 'ro.kernel.qemu');
  const hardware = getProp(serial, 'ro.hardware');
  const model = getProp(serial, 'ro.product.model');
  const manufacturer = getProp(serial, 'ro.product.manufacturer');
  const androidRelease = getProp(serial, 'ro.build.version.release');
  const sdk = getProp(serial, 'ro.build.version.sdk');
  const buildFingerprint = getProp(serial, 'ro.build.fingerprint');

  if (qemu === '1' || /goldfish|ranchu|emulator/i.test(hardware)) {
    throw new Error('Physical Android evidence refuses emulator/virtual-device hardware');
  }

  const apkSha256 = sha256(fs.readFileSync(apkPath));
  adb(serial, ['install', '-r', apkPath]);

  let packageDump = adb(serial, ['shell', 'dumpsys', 'package', packageName]);
  if (!packageDump.includes('android.permission.CAMERA')) {
    throw new Error('Installed File QR package does not declare android.permission.CAMERA');
  }

  const versionName = packageDump.match(/versionName=([^\s]+)/)?.[1] || null;
  const versionCode = packageDump.match(/versionCode=(\d+)/)?.[1] || null;

  adb(serial, ['shell', 'pm', 'grant', packageName, 'android.permission.CAMERA']);
  packageDump = adb(serial, ['shell', 'dumpsys', 'package', packageName]);
  const cameraPermissionGranted = /android\.permission\.CAMERA:\s*granted=true/.test(packageDump);
  if (!cameraPermissionGranted) {
    throw new Error('CAMERA runtime permission is not granted after pm grant');
  }

  adb(serial, ['shell', 'am', 'force-stop', packageName]);
  adb(serial, [
    'shell',
    'monkey',
    '-p',
    packageName,
    '-c',
    'android.intent.category.LAUNCHER',
    '1',
  ]);

  const scanButton = await waitFor(async () => boundsCenter(uiDump(serial), 'Scan QR'), 15000, 750);
  if (!scanButton) throw new Error('Could not locate the File QR "Scan QR" control with UIAutomator');

  adb(serial, ['shell', 'input', 'tap', String(scanButton.x), String(scanButton.y)]);

  const appPid = await waitFor(
    async () => adb(serial, ['shell', 'pidof', packageName], { allowFailure: true }),
    10000,
  );
  if (!appPid) throw new Error('File QR process is not running after launching the native scanner');

  const cameraOwnerObserved = Boolean(await waitFor(async () => {
    const cameraDump = adb(serial, ['shell', 'dumpsys', 'media.camera']);
    return cameraDump.includes(packageName) || new RegExp(`\\b${String(appPid).trim()}\\b`).test(cameraDump);
  }, 15000, 750));

  if (!cameraOwnerObserved) {
    throw new Error('Physical camera service never reported File QR as an active camera client');
  }

  adb(serial, ['shell', 'input', 'keyevent', 'KEYCODE_BACK']);

  const appRecovered = Boolean(await waitFor(async () => {
    const pid = adb(serial, ['shell', 'pidof', packageName], { allowFailure: true });
    if (!pid) return false;
    return Boolean(boundsCenter(uiDump(serial), 'Scan QR'));
  }, 12000, 750));

  if (!appRecovered) {
    throw new Error('File QR did not recover to its receive UI after scanner cancellation');
  }

  adb(serial, ['shell', 'am', 'force-stop', packageName], { allowFailure: true });

  const evidence = {
    schemaVersion: 1,
    capturedAt: new Date().toISOString(),
    packageName,
    apkSha256,
    versionName,
    versionCode,
    device: {
      manufacturer,
      model,
      androidRelease,
      sdk,
      hardware,
      emulatorRejected: true,
      deviceSerialHash: sha256(serial),
      buildFingerprintHash: sha256(buildFingerprint),
    },
    cameraPermissionGranted,
    cameraOwnerObserved,
    appRecovered,
    cameraImageryCaptured: false,
  };

  fs.writeFileSync(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`, { mode: 0o600 });
  console.log(`Physical Android camera evidence: PASS -> ${evidencePath}`);
  return evidence;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await collectPhysicalAndroidEvidence();
}
