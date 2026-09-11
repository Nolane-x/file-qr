import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  boundsCenter,
  collectAndroidDeviceFacts,
  collectPhysicalAndroidEvidence,
  parseAuthorizedDevices,
} from '../../scripts/collect-android-physical-evidence.mjs';

function apkFixture(bytes = 'apk-bytes') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fileqr-physical-'));
  const apkPath = path.join(dir, 'FileQR-Android-arm64.apk');
  fs.writeFileSync(apkPath, Buffer.from(bytes));
  return { dir, apkPath };
}

function physicalAdbFixture({ devices, hardware = 'kalama', granted = true } = {}) {
  const calls = [];
  let packageReads = 0;
  const props = new Map([
    ['ro.kernel.qemu', '0'],
    ['ro.hardware', hardware],
    ['ro.product.model', 'Test Phone'],
    ['ro.product.manufacturer', 'Test Maker'],
    ['ro.build.version.release', '16'],
    ['ro.build.version.sdk', '36'],
    ['ro.build.fingerprint', 'secret/raw/fingerprint'],
  ]);
  const deviceOutput = devices ?? 'List of devices attached\nSERIAL-SECRET device product:test model:Phone transport_id:1';
  const adbFn = (serial, args) => {
    calls.push([serial, ...args]);
    if (!serial && args[0] === 'devices') return deviceOutput;
    if (args[0] === 'shell' && args[1] === 'getprop') return props.get(args[2]) || '';
    if (args[0] === 'shell' && args[1] === 'dumpsys' && args[2] === 'package') {
      packageReads += 1;
      const grant = granted && packageReads > 1 ? 'granted=true' : 'granted=false';
      return `versionCode=4 minSdk=24 targetSdk=36\nversionName=0.4.0\nandroid.permission.CAMERA: ${grant}`;
    }
    return '';
  };
  return { adbFn, calls };
}

test('ADB device parsing keeps only authorized device transports', () => {
  const devices = parseAuthorizedDevices(`List of devices attached\nABC123 device product:foo model:Phone transport_id:1\nOFFLINE offline transport_id:2\nDENIED unauthorized transport_id:3\n`);
  assert.deepEqual(devices, [{ serial: 'ABC123', state: 'device' }]);
});

test('UIAutomator Scan QR bounds are converted to a deterministic tap center', () => {
  const xml = '<hierarchy><node index="0" text="Scan QR" resource-id="" class="android.widget.Button" bounds="[100,300][300,380]" /></hierarchy>';
  assert.deepEqual(boundsCenter(xml, 'Scan QR'), { x: 200, y: 340 });
  assert.equal(boundsCenter(xml, 'Missing'), null);
});

test('reusable Android facts independently bind APK and return only sanitized device facts', async () => {
  const { apkPath } = apkFixture('fact-apk-bytes');
  const { adbFn, calls } = physicalAdbFixture();
  const facts = await collectAndroidDeviceFacts({ apkPath, adbFn });

  assert.equal(facts.packageName, 'com.nolane.fileqr');
  assert.equal(facts.apkSha256, createHash('sha256').update(Buffer.from('fact-apk-bytes')).digest('hex'));
  assert.equal(facts.versionName, '0.4.0');
  assert.equal(facts.versionCode, '4');
  assert.equal(facts.cameraPermissionGranted, true);
  assert.deepEqual(
    Object.keys(facts.device).sort(),
    ['androidRelease', 'buildFingerprintHash', 'deviceSerialHash', 'emulatorRejected', 'hardware', 'manufacturer', 'model', 'sdk'].sort(),
  );
  assert.equal(facts.device.manufacturer, 'Test Maker');
  assert.equal(facts.device.model, 'Test Phone');
  assert.equal(facts.device.androidRelease, '16');
  assert.equal(facts.device.sdk, '36');
  assert.equal(facts.device.hardware, 'kalama');
  assert.equal(facts.device.emulatorRejected, true);
  assert.match(facts.device.deviceSerialHash, /^[a-f0-9]{64}$/);
  assert.match(facts.device.buildFingerprintHash, /^[a-f0-9]{64}$/);
  assert.doesNotMatch(JSON.stringify(facts), /SERIAL-SECRET|secret\/raw\/fingerprint/);
  assert.ok(calls.some((entry) => entry[1] === 'install'));
  assert.ok(calls.some((entry) => entry.includes('android.permission.CAMERA')));
});

test('reusable Android facts reject ambiguous device topology and emulator hardware', async () => {
  const { apkPath } = apkFixture();
  const none = physicalAdbFixture({ devices: 'List of devices attached\n' });
  await assert.rejects(() => collectAndroidDeviceFacts({ apkPath, adbFn: none.adbFn }), /exactly one authorized ADB device; found 0/);

  const many = physicalAdbFixture({
    devices: 'List of devices attached\nONE device product:a\nTWO device product:b',
  });
  await assert.rejects(() => collectAndroidDeviceFacts({ apkPath, adbFn: many.adbFn }), /exactly one authorized ADB device; found 2/);

  const emulator = physicalAdbFixture({ hardware: 'ranchu' });
  await assert.rejects(() => collectAndroidDeviceFacts({ apkPath, adbFn: emulator.adbFn }), /refuses emulator\/virtual-device hardware/);
});

test('reusable Android facts require declared and granted camera permission', async () => {
  const { apkPath } = apkFixture();
  const denied = physicalAdbFixture({ granted: false });
  await assert.rejects(() => collectAndroidDeviceFacts({ apkPath, adbFn: denied.adbFn }), /CAMERA runtime permission is not granted/);
});

test('collector produces privacy-safe PASS evidence from a physical-device ADB flow', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fileqr-physical-'));
  const apkPath = path.join(dir, 'FileQR-Android-arm64.apk');
  const evidencePath = path.join(dir, 'android-physical-evidence.json');
  fs.writeFileSync(apkPath, Buffer.from('apk-bytes'));

  const calls = [];
  const uiXml = '<hierarchy><node text="Scan QR" class="android.widget.Button" bounds="[40,100][240,180]" /></hierarchy>';
  const packageDump = 'versionCode=4 minSdk=24 targetSdk=36\nversionName=0.4.0\nandroid.permission.CAMERA: granted=true';
  const props = new Map([
    ['ro.kernel.qemu', '0'],
    ['ro.hardware', 'kalama'],
    ['ro.product.model', 'Test Phone'],
    ['ro.product.manufacturer', 'Test Maker'],
    ['ro.build.version.release', '16'],
    ['ro.build.version.sdk', '36'],
    ['ro.build.fingerprint', 'secret/raw/fingerprint'],
  ]);

  const adbFn = (serial, args) => {
    calls.push([serial, ...args]);
    if (!serial && args[0] === 'devices') {
      return 'List of devices attached\nSERIAL-SECRET device product:test model:Phone transport_id:1';
    }
    if (args[0] === 'shell' && args[1] === 'getprop') return props.get(args[2]) || '';
    if (args[0] === 'shell' && args[1] === 'dumpsys' && args[2] === 'package') return packageDump;
    if (args[0] === 'shell' && args[1] === 'uiautomator') return 'UI hierchary dumped';
    if (args[0] === 'shell' && args[1] === 'cat') return uiXml;
    if (args[0] === 'shell' && args[1] === 'pidof') return '4242';
    if (args[0] === 'shell' && args[1] === 'dumpsys' && args[2] === 'media.camera') {
      return 'Client package: com.nolane.fileqr PID 4242';
    }
    return '';
  };

  const evidence = await collectPhysicalAndroidEvidence({
    apkPath,
    evidencePath,
    adbFn,
    sleepFn: async () => {},
  });

  assert.equal(evidence.cameraPermissionGranted, true);
  assert.equal(evidence.cameraOwnerObserved, true);
  assert.equal(evidence.appRecovered, true);
  assert.equal(evidence.cameraImageryCaptured, false);
  assert.match(evidence.device.deviceSerialHash, /^[a-f0-9]{64}$/);
  assert.match(evidence.device.buildFingerprintHash, /^[a-f0-9]{64}$/);

  const serialized = fs.readFileSync(evidencePath, 'utf8');
  assert.doesNotMatch(serialized, /SERIAL-SECRET/);
  assert.doesNotMatch(serialized, /secret\/raw\/fingerprint/);
  assert.ok(calls.some((entry) => entry.includes('media.camera')));
  assert.ok(calls.some((entry) => entry.includes('KEYCODE_BACK')));
});
