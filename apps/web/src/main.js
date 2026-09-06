import encodeQR from 'qr';
import './style.css';
import { isReceiveCode, normalizeReceiveCode, compactReceiveCode } from '../../../packages/core/session.js';
import { createPeerConnection, createRemoteCandidateBuffer, createTransferChannel, parseDataChannelMessage, streamFileOverChannel } from './webrtc.js';
import { connectSignal, sendSignal } from './signaling.js';
import { createReceiveSink, downloadReceivedFile } from './storage.js';

const SIGNALING_ORIGIN = (import.meta.env.VITE_SIGNALING_ORIGIN || '').replace(/\/$/, '');
const REPO_RELEASE = 'https://github.com/Nolane-x/file-qr/releases/latest';

const STATE_COPY = {
  idle: ['Drop a file.', 'It stays on your device until someone connects. No account. No cloud file storage.'],
  'drag-over': ['Let it go.', 'Drop the file anywhere inside the transfer area.'],
  preparing: ['Preparing.', 'Creating a private 10-minute rendezvous.'],
  ready: ['Ready.', 'Scan the QR on Android or enter the code on another Windows device.'],
  connecting: ['Connecting.', 'Establishing an encrypted peer-to-peer WebRTC channel.'],
  sending: ['Sending.', 'Keep this tab open until the transfer is complete.'],
  receiving: ['Receiving.', 'The file is streaming directly from the sender.'],
  verifying: ['Verifying.', 'Finalizing the received file on this device.'],
  done: ['Done.', 'The transfer finished. You can start another immediately.'],
  expired: ['Expired.', 'The 10-minute receive window closed. Drop the file again for a fresh code.'],
  cancelled: ['Cancelled.', 'The transfer session was closed.'],
  failed: ['Couldn’t connect.', 'Nothing was uploaded. Try again or use the native app offline.'],
  unsupported: ['Windows + Android.', 'This preview intentionally supports Chromium on Windows and Android only.'],
};

const $ = (selector) => document.querySelector(selector);
const ui = {
  title: $('[data-title]'), description: $('[data-description]'), eyebrow: $('[data-eyebrow]'), status: $('[data-status]'),
  idle: $('[data-view="idle"]'), session: $('[data-view="session"]'), dropzone: $('[data-dropzone]'), fileInput: $('[data-file-input]'),
  receiveForm: $('[data-receive-form]'), codeInput: $('[data-code-input]'), qr: $('[data-qr]'), fileName: $('[data-file-name]'), fileSize: $('[data-file-size]'),
  code: $('[data-code]'), countdown: $('[data-countdown]'), copyCode: $('[data-copy-code]'), copyLink: $('[data-copy-link]'), cancel: $('[data-cancel]'), again: $('[data-again]'),
  progressWrap: $('[data-progress-wrap]'), progressLabel: $('[data-progress-label]'), progressValue: $('[data-progress-value]'), progressBar: $('[data-progress-bar]'), rate: $('[data-rate]'), transferSize: $('[data-transfer-size]'),
};

let current = { state: 'idle', socket: null, peer: null, channel: null, file: null, code: '', token: '', receiveUrl: '', expiresAt: 0, timer: null, sink: null, startedAt: 0, transferred: 0, offerSent: false };

function setState(state, detail = '') {
  current.state = state;
  document.body.dataset.state = state;
  const copy = STATE_COPY[state] || STATE_COPY.failed;
  ui.title.textContent = copy[0];
  ui.description.textContent = copy[1];
  ui.status.textContent = detail || copy[1];
  ui.eyebrow.textContent = state === 'idle' ? 'Direct transfer' : state.replace('-', ' ');
  const showSession = !['idle', 'unsupported'].includes(state);
  ui.idle.hidden = showSession;
  ui.session.hidden = !showSession;
  ui.again.hidden = !['done', 'expired', 'cancelled', 'failed'].includes(state);
  ui.cancel.hidden = ['done', 'expired', 'cancelled', 'failed'].includes(state);
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const value = bytes / (1024 ** index);
  return `${value >= 100 || index === 0 ? value.toFixed(0) : value.toFixed(1)} ${units[index]}`;
}

function formatRate(bytes, elapsedMs) {
  if (!elapsedMs || bytes <= 0) return 'Secure P2P';
  return `${formatBytes(bytes / (elapsedMs / 1000))}/s`;
}

function platformSupported() {
  if (['localhost', '127.0.0.1'].includes(location.hostname)) return true;
  const ua = navigator.userAgent;
  const platform = navigator.userAgentData?.platform || navigator.platform || '';
  const windows = /Windows/i.test(platform) || /Windows NT/i.test(ua);
  const android = /Android/i.test(ua);
  const chromium = /Chrome|Chromium|EdgA|Edg\//i.test(ua) && !/OPR\//i.test(ua);
  return (windows || android) && chromium;
}

function resetProgress() {
  ui.progressWrap.hidden = true;
  ui.progressBar.style.width = '0%';
  ui.progressValue.textContent = '0%';
  ui.progressLabel.textContent = 'Connecting';
  ui.rate.textContent = 'Secure P2P';
  ui.transferSize.textContent = '';
}

function updateProgress(done, total, label) {
  ui.progressWrap.hidden = false;
  const ratio = total > 0 ? Math.min(1, done / total) : 0;
  ui.progressBar.style.width = `${(ratio * 100).toFixed(2)}%`;
  ui.progressValue.textContent = `${Math.round(ratio * 100)}%`;
  ui.progressLabel.textContent = label;
  ui.transferSize.textContent = `${formatBytes(done)} / ${formatBytes(total)}`;
  ui.rate.textContent = formatRate(done, performance.now() - current.startedAt);
}

function stopTimer() {
  if (current.timer) clearInterval(current.timer);
  current.timer = null;
}

function startCountdown(expiresAt, onExpire) {
  stopTimer();
  const tick = () => {
    const left = Math.max(0, expiresAt - Date.now());
    const seconds = Math.ceil(left / 1000);
    ui.countdown.textContent = `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
    if (left <= 0) { stopTimer(); onExpire(); }
  };
  tick();
  current.timer = setInterval(tick, 250);
}

function cleanup({ keepView = false } = {}) {
  stopTimer();
  try { current.channel?.close(); } catch { /* no-op */ }
  try { current.peer?.close(); } catch { /* no-op */ }
  try { current.socket?.close(); } catch { /* no-op */ }
  current.sink?.abort?.().catch?.(() => {});
  const preserve = keepView ? { state: current.state } : {};
  current = { state: preserve.state || 'idle', socket: null, peer: null, channel: null, file: null, code: '', token: '', receiveUrl: '', expiresAt: 0, timer: null, sink: null, startedAt: 0, transferred: 0, offerSent: false };
}

async function copyText(value, message) {
  try { await navigator.clipboard.writeText(value); ui.status.textContent = message; }
  catch { ui.status.textContent = 'Copy was blocked by the browser. Select it manually.'; }
}

function renderSessionMeta(file, code, receiveUrl) {
  ui.fileName.textContent = file?.name || 'Incoming file';
  ui.fileSize.textContent = file ? formatBytes(file.size) : 'Waiting for metadata';
  ui.code.textContent = normalizeReceiveCode(code);
  ui.qr.innerHTML = receiveUrl ? encodeQR(receiveUrl, 'svg', { ecc: 'medium', border: 4, optimize: true }) : '';
}

function attachIce(peer, socket) {
  peer.addEventListener('icecandidate', ({ candidate }) => {
    if (candidate) sendSignal(socket, { type: 'candidate', candidate });
  });
}

async function handleRemoteSignal(peer, socket, event, role, candidateBuffer) {
  let message;
  try { message = JSON.parse(event.data); } catch { return; }
  if (message.type === 'candidate' && message.candidate) {
    try { await candidateBuffer.add(message.candidate); } catch { /* candidate may arrive after closure */ }
    return;
  }
  if (message.type === 'description' && message.description) {
    await peer.setRemoteDescription(message.description);
    await candidateBuffer.flush();
    if (role === 'receiver' && message.description.type === 'offer') {
      const answer = await peer.createAnswer();
      await peer.setLocalDescription(answer);
      sendSignal(socket, { type: 'description', description: peer.localDescription });
    }
  }
}

async function createSession() {
  if (!SIGNALING_ORIGIN) throw new Error('This deployment has no signaling endpoint configured yet.');
  const response = await fetch(`${SIGNALING_ORIGIN}/v1/sessions`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  if (!response.ok) throw new Error('Could not create a transfer session.');
  return response.json();
}

async function sendFile(file) {
  cleanup();
  resetProgress();
  current.file = file;
  setState('preparing', `Preparing ${file.name}…`);
  try {
    const session = await createSession();
    current.code = session.code;
    current.token = session.senderToken;
    current.expiresAt = session.expiresAt;
    const receiveUrl = new URL(location.href);
    receiveUrl.search = '';
    receiveUrl.hash = '';
    receiveUrl.searchParams.set('receive', compactReceiveCode(session.code));
    current.receiveUrl = receiveUrl.toString();
    renderSessionMeta(file, session.code, current.receiveUrl);
    setState('ready', 'Waiting for a receiver. The file has not left this device.');
    startCountdown(session.expiresAt, () => {
      if (current.channel?.readyState === 'open') return;
      cleanup({ keepView: true });
      setState('expired');
    });

    const socket = await connectSignal(SIGNALING_ORIGIN, session.code, 'sender', session.senderToken);
    current.socket = socket;
    const peer = createPeerConnection();
    current.peer = peer;
    const channel = createTransferChannel(peer);
    const candidateBuffer = createRemoteCandidateBuffer(peer);
    current.channel = channel;
    attachIce(peer, socket);

    socket.addEventListener('message', async (event) => {
      let message;
      try { message = JSON.parse(event.data); } catch { return; }
      if (message.type === 'peer-ready' && !current.offerSent) {
        current.offerSent = true;
        setState('connecting', 'Receiver found. Negotiating the direct path…');
        const offer = await peer.createOffer();
        await peer.setLocalDescription(offer);
        sendSignal(socket, { type: 'description', description: peer.localDescription });
        return;
      }
      await handleRemoteSignal(peer, socket, event, 'sender', candidateBuffer);
    });

    channel.addEventListener('open', async () => {
      stopTimer();
      sendSignal(socket, { type: 'session-consumed' });
      setState('sending', `Sending ${file.name} directly to the receiver.`);
      current.startedAt = performance.now();
      await streamFileOverChannel(file, channel, {
        onProgress(done, total) { current.transferred = done; updateProgress(done, total, 'Sending'); },
      });
      updateProgress(file.size, file.size, 'Sent');
      setState('done', 'Transfer complete. The rendezvous is no longer reusable.');
      try { socket.close(); } catch { /* no-op */ }
      try { channel.close(); } catch { /* no-op */ }
    });
    channel.addEventListener('error', () => setState('failed', 'The direct data channel failed. Your file stayed local.'));
  } catch (error) {
    cleanup({ keepView: true });
    setState('failed', error?.message || 'Could not prepare this transfer.');
  }
}

async function receiveFile(rawCode) {
  const code = normalizeReceiveCode(rawCode);
  if (!isReceiveCode(code)) { ui.status.textContent = 'That receive code is not valid.'; return; }
  if (!SIGNALING_ORIGIN) { setState('failed', 'This deployment has no signaling endpoint configured yet.'); return; }
  cleanup();
  resetProgress();
  current.code = code;
  renderSessionMeta(null, code, '');
  setState('connecting', `Joining ${code}…`);

  try {
    const socket = await connectSignal(SIGNALING_ORIGIN, code, 'receiver');
    current.socket = socket;
    const peer = createPeerConnection();
    const candidateBuffer = createRemoteCandidateBuffer(peer);
    current.peer = peer;
    attachIce(peer, socket);
    peer.addEventListener('datachannel', ({ channel }) => {
      current.channel = channel;
      channel.binaryType = 'arraybuffer';
      let meta = null;
      let received = 0;
      let chain = Promise.resolve();
      channel.addEventListener('open', () => { current.startedAt = performance.now(); ui.status.textContent = 'Direct channel open. Waiting for file metadata…'; });
      channel.addEventListener('message', (event) => {
        chain = chain.then(async () => {
          const parsed = parseDataChannelMessage(event.data);
          if (parsed.kind === 'control' && parsed.message.type === 'meta') {
            meta = parsed.message.payload;
            ui.fileName.textContent = meta.name;
            ui.fileSize.textContent = formatBytes(meta.size);
            current.sink = await createReceiveSink(meta);
            received = 0;
            current.startedAt = performance.now();
            setState('receiving', `Receiving ${meta.name} directly from the sender.`);
            updateProgress(0, meta.size, 'Receiving');
            return;
          }
          if (parsed.kind === 'binary') {
            if (!current.sink || !meta) throw new Error('Received file bytes before metadata.');
            await current.sink.write(parsed.bytes);
            received += parsed.bytes.byteLength;
            current.transferred = received;
            updateProgress(received, meta.size, 'Receiving');
            return;
          }
          if (parsed.kind === 'control' && parsed.message.type === 'complete') {
            if (!current.sink || !meta || received !== meta.size) throw new Error('Transfer ended before all bytes arrived.');
            setState('verifying', 'Finalizing the received file…');
            const file = await current.sink.close();
            downloadReceivedFile(file, meta.name);
            await current.sink.cleanup?.();
            current.sink = null;
            updateProgress(meta.size, meta.size, 'Received');
            setState('done', `${meta.name} is ready on this device.`);
            try { socket.close(); } catch { /* no-op */ }
            try { channel.close(); } catch { /* no-op */ }
          }
        }).catch((error) => setState('failed', error?.message || 'The receive stream failed.'));
      });
    });

    socket.addEventListener('message', (event) => handleRemoteSignal(peer, socket, event, 'receiver', candidateBuffer).catch((error) => setState('failed', error?.message || 'Signaling failed.')));
    socket.addEventListener('close', (event) => {
      if (current.state === 'connecting' && event.code === 4000) setState('expired');
    });
  } catch (error) {
    cleanup({ keepView: true });
    setState('failed', error?.message || 'Could not join this transfer.');
  }
}

function reset() {
  cleanup();
  resetProgress();
  ui.qr.innerHTML = '';
  history.replaceState({}, '', location.pathname);
  setState('idle');
}

ui.dropzone.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); ui.fileInput.click(); }
});
ui.fileInput.addEventListener('change', () => { const [file] = ui.fileInput.files; if (file) sendFile(file); });
for (const eventName of ['dragenter', 'dragover']) {
  window.addEventListener(eventName, (event) => { event.preventDefault(); document.body.dataset.dragging = 'true'; if (current.state === 'idle') setState('drag-over'); });
}
for (const eventName of ['dragleave', 'drop']) {
  window.addEventListener(eventName, (event) => { event.preventDefault(); document.body.dataset.dragging = 'false'; if (eventName === 'dragleave' && current.state === 'drag-over') setState('idle'); });
}
window.addEventListener('drop', (event) => { const [file] = event.dataTransfer?.files || []; if (file) sendFile(file); });
ui.receiveForm.addEventListener('submit', (event) => { event.preventDefault(); receiveFile(ui.codeInput.value); });
ui.codeInput.addEventListener('input', () => { ui.codeInput.value = normalizeReceiveCode(ui.codeInput.value); });
ui.copyCode.addEventListener('click', () => copyText(current.code, 'Receive code copied.'));
ui.copyLink.addEventListener('click', () => copyText(current.receiveUrl, 'Receive link copied.'));
ui.cancel.addEventListener('click', () => { cleanup({ keepView: true }); setState('cancelled'); });
ui.again.addEventListener('click', reset);

const receiveParam = new URLSearchParams(location.search).get('receive');
if (!platformSupported()) {
  setState('unsupported', `Use Windows or Android. Native downloads are available at ${REPO_RELEASE}.`);
} else if (receiveParam) {
  receiveFile(receiveParam);
} else {
  setState('idle');
}
