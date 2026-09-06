import { QRCanvas, frameLoop, rearCamera, selfieCamera } from 'qr/dom.js';

export function createQrScanner({
  video,
  overlay,
  preferEnvironment = false,
  cameraApi = { rearCamera, selfieCamera },
  frameLoopFn = frameLoop,
  QRCanvasClass = QRCanvas,
} = {}) {
  let camera = null;
  let cancelLoop = null;
  let active = false;
  let delivered = false;

  function stop() {
    active = false;
    const cancel = cancelLoop;
    cancelLoop = null;
    try { cancel?.(); } catch { /* no-op */ }
    const openCamera = camera;
    camera = null;
    try { openCamera?.stop?.(); } catch { /* no-op */ }
  }

  async function start(onDecode) {
    stop();
    delivered = false;
    const openCamera = preferEnvironment ? cameraApi.rearCamera : cameraApi.selfieCamera;
    if (typeof openCamera !== 'function') throw new Error('Camera scanning is unavailable on this device.');
    camera = await openCamera(video);
    const canvas = new QRCanvasClass({ overlay });
    active = true;
    cancelLoop = frameLoopFn(() => {
      if (!active || delivered || !camera) return;
      const decoded = camera.readFrame(canvas);
      if (decoded === undefined) return;
      delivered = true;
      stop();
      onDecode?.(decoded);
    });
  }

  return {
    start,
    stop,
    get active() { return active; },
  };
}
