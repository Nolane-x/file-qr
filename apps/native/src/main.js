import '../../web/src/style.css';
import './native.css';
import encodeQR from 'qr';
import { QRCanvas, frameLoop, rearCamera } from 'qr/dom.js';
import { encodeOpticalFrames, MIN_OPTICAL_PAYLOAD_BYTES, OpticalAssembler } from '../../../packages/core/optical.js';
import { FQR2_MAX_FILE_BYTES } from '../../../packages/core/optical-v2.js';
import { encodeFileEnvelope, decodeFileEnvelope } from '../../../packages/core/file-envelope.js';
import { parseReceivePayload } from '../../web/src/receive-payload.js';
import { createAndroidBarcodeScanner } from './android-barcode.js';
import { createFqr2Broadcaster, createFqr2Receiver } from './optical-v2-session.js';

const nativeScanButton = document.querySelector('[data-native-scan]');
const networkStatus = document.querySelector('[data-status]');
const networkCodeInput = document.querySelector('[data-code-input]');
const networkReceiveForm = document.querySelector('[data-receive-form]');
const androidNative = /Android/i.test(navigator.userAgent);

if (androidNative) nativeScanButton?.removeAttribute('data-scan-qr');
await import('../../web/src/main.js');

const networkButton = document.querySelector('[data-mode="network"]');
const opticalButton = document.querySelector('[data-mode="optical"]');
const networkPanel = document.querySelector('[data-network-panel]');
const opticalPanel = document.querySelector('[data-optical-panel]');
const fileInput = document.querySelector('[data-optical-file]');
const cameraButton = document.querySelector('[data-camera]');
const qr = document.querySelector('[data-optical-qr]');
const video = document.querySelector('[data-optical-video]');
const overlay = document.querySelector('[data-optical-overlay]');
const status = document.querySelector('[data-optical-status]');
const progress = document.querySelector('[data-optical-progress]');
const bar = document.querySelector('[data-optical-bar]');
const stopButton = document.querySelector('[data-optical-stop]');
const opticalVersionButtons = [...document.querySelectorAll('[data-optical-version]')];

let opticalSession = { stop: null, timer: null, camera: null, loop: null };
let opticalGeneration = 0;
let opticalSendVersion = 'fqr1';
let cancelNetworkScan = () => Promise.resolve();
const OPTICAL_MAX_BYTES = 8 * 1024 * 1024;
const OPTICAL_RECEIVE_MAX_BYTES = OPTICAL_MAX_BYTES + 1024 * 1024 + 4;
const OPTICAL_RECEIVE_MAX_FRAMES = Math.ceil(OPTICAL_RECEIVE_MAX_BYTES / MIN_OPTICAL_PAYLOAD_BYTES);
const FQR2_FRAME_INTERVAL_MS = 80;

function setMode(mode) {
  const optical = mode === 'optical';
  networkButton.setAttribute('aria-pressed', String(!optical));
  opticalButton.setAttribute('aria-pressed', String(optical));
  networkPanel.hidden = optical;
  opticalPanel.hidden = !optical;
  if (optical) {
    document.querySelector('[data-scanner-cancel]')?.click();
    cancelNetworkScan().catch(() => {});
  } else {
    stopOptical();
  }
}

function randomStreamId() {
  const alphabet = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  return [...bytes].map(byte => alphabet[byte % alphabet.length]).join('');
}

function setOpticalProgress(done, total, label) {
  const ratio = total ? Math.min(1, done / total) : 0;
  bar.style.width = `${ratio * 100}%`;
  progress.textContent = total ? `${done} / ${total}` : '—';
  status.textContent = label;
}

function saveReceivedFile(file, name = file.name || 'file.bin') {
  const url = URL.createObjectURL(file);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = name;
  anchor.rel = 'noopener';
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}

function stopOptical() {
  opticalGeneration += 1;
  try {
    const stopped = opticalSession.stop?.();
    if (stopped?.catch) stopped.catch(() => {});
  } catch { /* best-effort shutdown */ }
  if (opticalSession.timer) clearTimeout(opticalSession.timer);
  opticalSession.loop?.();
  opticalSession.camera?.stop?.();
  opticalSession = { stop: null, timer: null, camera: null, loop: null };
  stopButton.hidden = true;
  video.hidden = true;
  overlay.hidden = true;
}

async function startFqr1Send(file) {
  stopOptical();
  const generation = opticalGeneration;
  stopButton.hidden = false;
  if (file.size > OPTICAL_MAX_BYTES) {
    status.textContent = 'QR Stream v0.1 supports files up to 8 MB; select v0.2 experimental or use Network mode.';
    progress.textContent = 'Too large';
    bar.style.width = '0%';
    stopButton.hidden = true;
    return;
  }
  status.textContent = `Preparing ${file.name}…`;
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (generation !== opticalGeneration) return;
  const envelope = encodeFileEnvelope({ name: file.name, type: file.type }, bytes);
  const frames = encodeOpticalFrames(envelope, { streamId: randomStreamId(), payloadBytes: 900 });
  let index = 0;
  let loop = 1;
  let stopped = false;
  const startedAt = Date.now();
  const maxAgeMs = 10 * 60 * 1000;

  const draw = () => {
    if (stopped || generation !== opticalGeneration) return;
    if (Date.now() - startedAt >= maxAgeMs) {
      stopped = true;
      status.textContent = 'Optical broadcast expired after 10 minutes.';
      stopButton.hidden = true;
      return;
    }
    const frame = frames[index];
    qr.innerHTML = encodeQR(frame, 'svg', { ecc: 'low', border: 3, optimize: true });
    setOpticalProgress(index + 1, frames.length, `QR Stream v0.1 · broadcasting ${file.name} · loop ${loop}`);
    index += 1;
    if (index >= frames.length) { index = 0; loop += 1; }
    opticalSession.timer = window.setTimeout(draw, 55);
  };
  opticalSession.stop = () => { stopped = true; };
  draw();
}

async function startFqr2Send(file) {
  stopOptical();
  const generation = opticalGeneration;
  stopButton.hidden = false;
  if (file.size > FQR2_MAX_FILE_BYTES) {
    status.textContent = 'QR Stream v0.2 experimental currently supports files up to 64 MB; use Network mode for larger files.';
    progress.textContent = 'Too large';
    bar.style.width = '0%';
    stopButton.hidden = true;
    return;
  }

  const delay = () => new Promise(resolve => window.setTimeout(resolve, FQR2_FRAME_INTERVAL_MS));
  const broadcaster = createFqr2Broadcaster(file, {
    emitFrame: async (frame, info) => {
      if (generation !== opticalGeneration) return;
      qr.innerHTML = encodeQR(frame, 'svg', { ecc: 'low', border: 3, optimize: true });
      setOpticalProgress(
        info.blockIndex + 1,
        info.manifest.blockCount,
        `QR Stream v0.2 experimental · block ${info.blockIndex + 1}/${info.manifest.blockCount} · cycle ${info.cycle + 1}`,
      );
      await delay();
    },
    yieldControl: async () => {},
  });
  opticalSession.stop = () => broadcaster.stop();
  status.textContent = `Preparing QR Stream v0.2 for ${file.name}…`;
  await broadcaster.run();
}

async function startOpticalSend(file) {
  if (opticalSendVersion === 'fqr2') return startFqr2Send(file);
  return startFqr1Send(file);
}

async function startOpticalReceive() {
  stopOptical();
  const generation = opticalGeneration;
  stopButton.hidden = false;
  qr.innerHTML = '';
  video.hidden = false;
  overlay.hidden = false;
  const fqr1Assembler = new OpticalAssembler({
    maxBytes: OPTICAL_RECEIVE_MAX_BYTES,
    maxFrames: OPTICAL_RECEIVE_MAX_FRAMES,
  });
  const fqr2Receiver = createFqr2Receiver();
  let fqr2AcceptBusy = false;
  let camera;
  try {
    camera = await rearCamera(video);
  } catch (error) {
    status.textContent = `Camera unavailable: ${error?.message || error}`;
    stopButton.hidden = true;
    return;
  }
  if (generation !== opticalGeneration) {
    camera.stop();
    return;
  }
  opticalSession.camera = camera;
  opticalSession.stop = () => fqr2Receiver.stop({ discard: false });
  const canvas = new QRCanvas({ overlay });

  function finishFqr1() {
    cancel();
    camera.stop();
    const file = decodeFileEnvelope(fqr1Assembler.bytes());
    saveReceivedFile(new Blob([file.bytes], { type: file.type }), file.name);
    setOpticalProgress(fqr1Assembler.total, fqr1Assembler.total, `${file.name} received with QR Stream v0.1. Saving to this device…`);
    stopButton.hidden = true;
  }

  function routeFqr2Frame(decoded) {
    if (fqr2AcceptBusy) return;
    fqr2AcceptBusy = true;
    Promise.resolve(fqr2Receiver.accept(decoded))
      .then(result => {
        if (generation !== opticalGeneration) return;
        if (result?.reason === 'manifest-required' || result?.reason === 'other-block-active' || result?.reason === 'block-complete') return;
        const blockCount = result?.blockCount ?? fqr2Receiver.manifest?.blockCount ?? 0;
        const completedBlocks = result?.completedBlocks ?? fqr2Receiver.completedBlocks;
        const activeBlock = fqr2Receiver.activeBlockIndex;
        const solved = fqr2Receiver.activeSolvedSymbols;
        const source = fqr2Receiver.activeSourceSymbols;
        const label = activeBlock === null
          ? `QR Stream v0.2 experimental · ${completedBlocks}/${blockCount || '—'} verified blocks`
          : `QR Stream v0.2 experimental · block ${activeBlock + 1}/${blockCount} · ${solved}/${source} symbols solved`;
        setOpticalProgress(completedBlocks, blockCount, label);
        if (result?.complete && result.file) {
          cancel();
          camera.stop();
          saveReceivedFile(result.file, result.file.name);
          setOpticalProgress(blockCount, blockCount, `${result.file.name} received with QR Stream v0.2. Saving to this device…`);
          stopButton.hidden = true;
        }
      })
      .catch(error => {
        if (generation === opticalGeneration) status.textContent = error?.message || 'Could not decode this FQR2 frame.';
      })
      .finally(() => {
        if (generation === opticalGeneration) fqr2AcceptBusy = false;
      });
  }

  const cancel = frameLoop(() => {
    const decoded = camera.readFrame(canvas);
    if (decoded === undefined || generation !== opticalGeneration) return;
    if (decoded.startsWith('FQR2|')) {
      routeFqr2Frame(decoded);
      return;
    }
    if (decoded.startsWith('FQR1|')) {
      try {
        const result = fqr1Assembler.accept(decoded);
        if (result.accepted) setOpticalProgress(result.received, result.total, 'QR Stream v0.1 · receiving frames… keep the QR inside the camera view.');
        if (fqr1Assembler.complete) finishFqr1();
      } catch (error) {
        status.textContent = error?.message || 'Could not decode this FQR1 frame.';
      }
    }
  });
  opticalSession.loop = cancel;
}

if (androidNative && nativeScanButton && networkReceiveForm && networkCodeInput) {
  const androidScanner = createAndroidBarcodeScanner();
  let scanning = false;

  cancelNetworkScan = async () => {
    if (!scanning) return;
    try { await androidScanner.cancel(); } catch { /* native scanner may already be closing */ }
  };

  nativeScanButton.addEventListener('click', async () => {
    if (scanning) return;
    scanning = true;
    nativeScanButton.disabled = true;
    if (networkStatus) networkStatus.textContent = 'Opening native QR scanner…';
    try {
      const payload = await androidScanner.scanQr();
      const code = parseReceivePayload(payload);
      if (!code) {
        if (networkStatus) networkStatus.textContent = 'Not a File QR receive code. Scan again or type the code.';
        networkCodeInput.focus();
        return;
      }
      networkCodeInput.value = code;
      networkReceiveForm.requestSubmit();
    } catch (error) {
      if (networkStatus) networkStatus.textContent = error?.message || 'Camera scanning is unavailable. Type the receive code instead.';
      networkCodeInput.focus();
    } finally {
      scanning = false;
      nativeScanButton.disabled = false;
    }
  });
}

for (const button of opticalVersionButtons) {
  button.addEventListener('click', () => {
    if (opticalSession.stop || opticalSession.camera || opticalSession.loop) stopOptical();
    opticalSendVersion = button.dataset.opticalVersion === 'fqr2' ? 'fqr2' : 'fqr1';
    for (const candidate of opticalVersionButtons) candidate.setAttribute('aria-pressed', String(candidate === button));
    if (opticalSendVersion === 'fqr2') {
      status.textContent = 'QR Stream v0.2 experimental selected. Bounded-memory fountain recovery is enabled for offline sending.';
    } else {
      status.textContent = 'QR Stream v0.1 compatibility mode selected.';
    }
  });
}

networkButton.addEventListener('click', () => setMode('network'));
opticalButton.addEventListener('click', () => setMode('optical'));
fileInput.addEventListener('change', () => {
  const [file] = fileInput.files;
  if (file) startOpticalSend(file).catch(error => {
    status.textContent = error?.message || 'Could not start optical transfer.';
    stopButton.hidden = true;
  });
});
cameraButton.addEventListener('click', () => startOpticalReceive().catch(error => {
  status.textContent = error?.message || 'Could not open the optical receiver.';
}));
stopButton.addEventListener('click', () => {
  stopOptical();
  status.textContent = 'Optical transfer stopped.';
  progress.textContent = '—';
  bar.style.width = '0%';
});
setMode('network');
