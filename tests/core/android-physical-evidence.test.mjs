import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  boundsCenter,
  collectPhysicalAndroidEvidence,
  parseAuthorizedDevices,
} from '../../scripts/collect-android-physical-evidence.mjs';

test('ADB device parsing keeps only authorized device transports', () => {
  const devices = parseAuthorizedDevices(`List of devices attached\nABC123 device product:foo model:Phone transport_id:1\nOFFLINE offline transport_id:2\nDENIED unauthorized transport_id:3\n`);
  assert.deepEqual(devices, [{ serial: 'ABC123', state: 'device' }]);
});

test('UIAutomator Scan QR bounds are converted to a deterministic tap center', () => {
  const xml = '<hierarchy><node index="0" text="Scan QR" resource-id="" class="android.widget.Button" bounds="[100,300][300,380]" /></hierarchy>';
  assert.deepEqual(boundsCenter(xml, 'Scan QR'), { x: 200, y: 340 });
  assert.equal(boundsCenter(xml, 'Missing'), null);
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
