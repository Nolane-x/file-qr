import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const moduleUrl = new URL('../../apps/native/src/android-barcode.js', import.meta.url);

async function loadAdapter() {
  assert.ok(fs.existsSync(moduleUrl), 'Android barcode adapter should exist');
  return import(`${moduleUrl.href}?test=${Date.now()}-${Math.random()}`);
}

test('Android barcode adapter requests camera permission then scans QR only with the back camera', async () => {
  const { createAndroidBarcodeScanner } = await loadAdapter();
  const invokes = [];
  let permissionRequests = 0;
  const scanner = createAndroidBarcodeScanner({
    checkPermissionsFn: async (plugin) => {
      assert.equal(plugin, 'barcode-scanner');
      return { camera: 'prompt' };
    },
    requestPermissionsFn: async (plugin) => {
      assert.equal(plugin, 'barcode-scanner');
      permissionRequests += 1;
      return { camera: 'granted' };
    },
    invokeFn: async (command, args) => {
      invokes.push({ command, args });
      return { content: 'https://fileqr.nolane-file.workers.dev/?receive=0123456789', format: 'QR_CODE' };
    },
  });

  const payload = await scanner.scanQr();
  assert.equal(permissionRequests, 1);
  assert.equal(payload, 'https://fileqr.nolane-file.workers.dev/?receive=0123456789');
  assert.deepEqual(invokes, [{
    command: 'plugin:barcode-scanner|scan',
    args: { cameraDirection: 'back', formats: ['QR_CODE'] },
  }]);
});

test('Android barcode adapter refuses scanning when camera permission remains denied', async () => {
  const { createAndroidBarcodeScanner } = await loadAdapter();
  let invokes = 0;
  const scanner = createAndroidBarcodeScanner({
    checkPermissionsFn: async () => ({ camera: 'denied' }),
    requestPermissionsFn: async () => ({ camera: 'denied' }),
    invokeFn: async () => { invokes += 1; },
  });

  await assert.rejects(() => scanner.scanQr(), /Camera permission denied/i);
  assert.equal(invokes, 0);
});

test('Android barcode adapter can cancel an active native scan', async () => {
  const { createAndroidBarcodeScanner } = await loadAdapter();
  const calls = [];
  const scanner = createAndroidBarcodeScanner({
    checkPermissionsFn: async () => ({ camera: 'granted' }),
    requestPermissionsFn: async () => ({ camera: 'granted' }),
    invokeFn: async (command, args) => { calls.push({ command, args }); },
  });

  await scanner.cancel();
  assert.deepEqual(calls, [{ command: 'plugin:barcode-scanner|cancel', args: undefined }]);
});
