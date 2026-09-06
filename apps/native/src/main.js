import '../../web/src/main.js';
import './native.css';
import encodeQR from 'qr';
import { QRCanvas, frameLoop, rearCamera } from 'qr/dom.js';
import { encodeOpticalFrames, OpticalAssembler } from '../../../packages/core/optical.js';
import { encodeFileEnvelope, decodeFileEnvelope } from '../../../packages/core/file-envelope.js';

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

let opticalSession = { stop: null, timer: null, camera: null, loop: null };
const OPTICAL_MAX_BYTES = 8 * 1024 * 1024;

function setMode(mode) {
  const optical = mode === 'optical';
  networkButton.setAttribute('aria-pressed', String(!optical));
  opticalButton.setAttribute('aria-pressed', String(optical));
  networkPanel.hidden = optical;
  opticalPanel.hidden = !optical;
  if (!optical) stopOptical();
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

function stopOptical() {
  opticalSession.stop?.();
  if (opticalSession.timer) clearTimeout(opticalSession.timer);
  opticalSession.loop?.();
  opticalSession.camera?.stop?.();
  opticalSession = { stop: null, timer: null, camera: null, loop: null };
  stopButton.hidden = true;
  video.hidden = true;
  overlay.hidden = true;
}

async function startOpticalSend(file) {
  stopOptical();
  stopButton.hidden = false;
  if (file.size > OPTICAL_MAX_BYTES) {
    status.textContent = 'QR Stream v0.1 supports files up to 8 MB; use Network mode for larger files.';
    progress.textContent = 'Too large';
    bar.style.width = '0%';
    stopButton.hidden = true;
    return;
  }
  status.textContent = `Preparing ${file.name}…`;
  const bytes = new Uint8Array(await file.arrayBuffer());
  const envelope = encodeFileEnvelope({ name: file.name, type: file.type }, bytes);
  const frames = encodeOpticalFrames(envelope, { streamId: randomStreamId(), payloadBytes: 900 });
  let index = 0;
  let loop = 1;
  let stopped = false;
  const startedAt = Date.now();
  const maxAgeMs = 10 * 60 * 1000;

  const draw = () => {
    if (stopped) return;
    if (Date.now() - startedAt >= maxAgeMs) {
      stopped = true;
      status.textContent = 'Optical broadcast expired after 10 minutes.';
      stopButton.hidden = true;
      return;
    }
    const frame = frames[index];
    qr.innerHTML = encodeQR(frame, 'svg', { ecc: 'low', border: 3, optimize: true });
    setOpticalProgress(index + 1, frames.length, `Broadcasting ${file.name} · loop ${loop}`);
    index += 1;
    if (index >= frames.length) { index = 0; loop += 1; }
    opticalSession.timer = window.setTimeout(draw, 55);
  };
  opticalSession.stop = () => { stopped = true; };
  draw();
}

async function startOpticalReceive() {
  stopOptical();
  stopButton.hidden = false;
  qr.innerHTML = '';
  video.hidden = false;
  overlay.hidden = false;
  const assembler = new OpticalAssembler();
  let camera;
  try {
    camera = await rearCamera(video);
  } catch (error) {
    status.textContent = `Camera unavailable: ${error?.message || error}`;
    stopButton.hidden = true;
    return;
  }
  opticalSession.camera = camera;
  const canvas = new QRCanvas({ overlay });
  const cancel = frameLoop(() => {
    const decoded = camera.readFrame(canvas);
    if (decoded === undefined) return;
    try {
      const result = assembler.accept(decoded);
      if (result.accepted) setOpticalProgress(result.received, result.total, 'Receiving optical frames… keep the QR inside the camera view.');
      if (!assembler.complete) return;
      cancel();
      camera.stop();
      const file = decodeFileEnvelope(assembler.bytes());
      const blob = new Blob([file.bytes], { type: file.type });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = file.name;
      anchor.click();
      setTimeout(() => URL.revokeObjectURL(url), 30_000);
      setOpticalProgress(assembler.total, assembler.total, `${file.name} received. Saving to this device…`);
      stopButton.hidden = true;
    } catch (error) {
      if (!/Unsupported optical frame/.test(String(error?.message))) status.textContent = error?.message || 'Could not decode this frame.';
    }
  });
  opticalSession.loop = cancel;
}

networkButton.addEventListener('click', () => setMode('network'));
opticalButton.addEventListener('click', () => setMode('optical'));
fileInput.addEventListener('change', () => { const [file] = fileInput.files; if (file) startOpticalSend(file).catch(error => { status.textContent = error?.message || 'Could not start optical transfer.'; }); });
cameraButton.addEventListener('click', () => startOpticalReceive().catch(error => { status.textContent = error?.message || 'Could not open the optical receiver.'; }));
stopButton.addEventListener('click', () => { stopOptical(); status.textContent = 'Optical transfer stopped.'; progress.textContent = '—'; bar.style.width = '0%'; });
setMode('network');
