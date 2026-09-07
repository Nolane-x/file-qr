import { checkPermissions, invoke, requestPermissions } from '@tauri-apps/api/core';

function cameraState(value) {
  if (typeof value === 'string') return value;
  return value?.camera;
}

export function createAndroidBarcodeScanner({
  invokeFn = invoke,
  checkPermissionsFn = checkPermissions,
  requestPermissionsFn = requestPermissions,
} = {}) {
  async function ensureCameraPermission() {
    let state = cameraState(await checkPermissionsFn('barcode-scanner'));
    if (state === 'granted') return;

    if (state === 'prompt' || state === 'prompt-with-rationale' || !state) {
      state = cameraState(await requestPermissionsFn('barcode-scanner'));
    }

    if (state !== 'granted') {
      throw new Error('Camera permission denied. Enable camera access for File QR in Android settings.');
    }
  }

  async function scanQr() {
    await ensureCameraPermission();
    const result = await invokeFn('plugin:barcode-scanner|scan', {
      cameraDirection: 'back',
      formats: ['QR_CODE'],
    });
    return result?.content || '';
  }

  async function cancel() {
    await invokeFn('plugin:barcode-scanner|cancel');
  }

  return { scanQr, cancel };
}
