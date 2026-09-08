import encodeQR from 'qr';
import './style.css';
import { isReceiveCode, normalizeReceiveCode, compactReceiveCode } from '../../../packages/core/session.js';
import { DEFAULT_CHUNK_SIZE, encodeControlMessage, validateResumeOffset } from '../../../packages/core/transfer.js';
import { createIceRecoveryController, createPeerConnection, createRemoteCandidateBuffer, createTransferChannel, defaultIceServers, detectSelectedCandidateType, fetchOptionalIceServers, parseDataChannelMessage, streamFileOverChannel, waitForBufferedAmountLow } from './webrtc.js';
import { connectSignal, sendSignal } from './signaling.js';
import { createReceiveSink, downloadReceivedFile } from './storage.js';
import { parseReceivePayload } from './receive-payload.js';
import { createQrScanner } from './scanner.js';
import { createWakeLockController } from './wake-lock.js';
import { estimateEta } from './progress.js';

const SIGNALING_ORIGIN = (import.meta.env.VITE_SIGNALING_ORIGIN || '').replace(/\/$/, '');
const REPO_RELEASE = 'https://github.com/Nolane-x/file-qr/releases/latest';
const CONNECTION_TIMEOUT_MS = 30_000;
const SIGNAL_RETRY_MS = 1_000;
const WAKE_STATES = new Set(['connecting', 'sending', 'receiving', 'verifying']);
const LIVE_CONNECTION_STATES = new Set(['connecting', 'sending', 'receiving', 'verifying']);

const STATE_COPY = {
  idle: ['Drop a file.', 'It stays on your device until someone connects. No account. No cloud file storage.'],
  'drag-over': ['Let it go.', 'Drop the file anywhere inside the transfer area.'],
  preparing: ['Preparing.', 'Creating a private 10-minute rendezvous.'],
  ready: ['Ready.', 'Scan the QR or enter the code on the receiving device.'],
  connecting: ['Connecting.', 'Establishing an encrypted peer-to-peer WebRTC channel.'],
  sending: ['Sending.', 'Keep this tab open until the transfer is complete.'],
  receiving: ['Receiving.', 'The file is streaming directly from the sender.'],
  verifying: ['Verifying.', 'Finalizing this transfer.'],
  done: ['Done.', 'The transfer finished.'],
  expired: ['Expired.', 'The 10-minute receive window closed. Drop the file again for a fresh code.'],
  cancelled: ['Cancelled.', 'The transfer session was closed.'],
  failed: ['Couldn’t connect.', 'Retry with the same code while its receive window is still open.'],
  unsupported: ['Windows + Android.', 'This preview intentionally supports Chromium on Windows and Android only.'],
};

const $ = (selector) => document.querySelector(selector);
const ui = {
  title: $('[data-title]'), description: $('[data-description]'), eyebrow: $('[data-eyebrow]'), status: $('[data-status]'),
  idle: $('[data-view="idle"]'), session: $('[data-view="session"]'), dropzone: $('[data-dropzone]'), fileInput: $('[data-file-input]'),
  receiveForm: $('[data-receive-form]'), codeInput: $('[data-code-input]'), pasteCode: $('[data-paste-code]'), scanQr: $('[data-scan-qr]'),
  scannerPanel: $('[data-scanner]'), scannerVideo: $('[data-scanner-video]'), scannerOverlay: $('[data-scanner-overlay]'), scannerCancel: $('[data-scanner-cancel]'),
  qr: $('[data-qr]'), fileName: $('[data-file-name]'), fileSize: $('[data-file-size]'), code: $('[data-code]'), countdown: $('[data-countdown]'),
  copyCode: $('[data-copy-code]'), copyLink: $('[data-copy-link]'), cancel: $('[data-cancel]'), again: $('[data-again]'),
  progressWrap: $('[data-progress-wrap]'), progressLabel: $('[data-progress-label]'), progressValue: $('[data-progress-value]'), progressBar: $('[data-progress-bar]'),
  rate: $('[data-rate]'), eta: $('[data-eta]'), transferSize: $('[data-transfer-size]'),
};

function freshAttempt() {
  return {
    id: null,
    peer: null,
    channel: null,
    candidateBuffer: null,
    connectionTimer: null,
    iceRecovery: null,
    transportType: 'unknown',
    sink: null,
    meta: null,
    startedAt: 0,
    transferred: 0,
    streaming: false,
    acknowledged: false,
  };
}

function freshCurrent(state = 'idle') {
  return {
    state,
    role: null,
    socket: null,
    file: null,
    fileId: '',
    code: '',
    token: '',
    receiveUrl: '',
    expiresAt: 0,
    timer: null,
    signalRetryTimer: null,
    reconnecting: false,
    attemptsCompleted: 0,
    leaseExpired: false,
    attempt: freshAttempt(),
  };
}

let current = freshCurrent();
const wakeLock = createWakeLockController({ wakeLockApi: navigator.wakeLock, documentRef: document });
const scanner = ui.scannerVideo && ui.scannerOverlay
  ? createQrScanner({
      video: ui.scannerVideo,
      overlay: ui.scannerOverlay,
      preferEnvironment: /Android/i.test(navigator.userAgent),
    })
  : null;

function stopScanner() {
  scanner?.stop();
  if (ui.scannerPanel) ui.scannerPanel.hidden = true;
  if (ui.scanQr) ui.scanQr.disabled = false;
}

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
  if (showSession) stopScanner();
  wakeLock.sync(WAKE_STATES.has(state)).catch(() => {});
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

function transportLabel(type) {
  if (type === 'direct') return 'Direct';
  if (type === 'relay') return 'Relay';
  return 'Unknown';
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
  if (ui.eta) ui.eta.textContent = 'Unknown';
  ui.transferSize.textContent = '';
}

function updateProgress(done, total, label) {
  ui.progressWrap.hidden = false;
  const ratio = total > 0 ? Math.min(1, done / total) : 0;
  const elapsedMs = Math.max(0, performance.now() - current.attempt.startedAt);
  ui.progressBar.style.width = `${(ratio * 100).toFixed(2)}%`;
  ui.progressValue.textContent = `${Math.round(ratio * 100)}%`;
  ui.progressLabel.textContent = label;
  ui.transferSize.textContent = `${formatBytes(done)} / ${formatBytes(total)}`;
  ui.rate.textContent = formatRate(Math.max(0, done), elapsedMs);
  if (ui.eta) ui.eta.textContent = estimateEta(done, total, elapsedMs) || (ratio >= 1 ? 'Complete' : transportLabel(current.attempt.transportType));
}

function leaseOpen() {
  return Number.isFinite(current.expiresAt) && current.expiresAt > 0 && Date.now() < current.expiresAt;
}

function stopTimer() {
  if (current.timer) clearInterval(current.timer);
  current.timer = null;
}

function stopConnectionTimer() {
  if (current.attempt.connectionTimer) clearTimeout(current.attempt.connectionTimer);
  current.attempt.connectionTimer = null;
}

async function cleanupAttempt({ discardPartial = false, nextAttempt = null } = {}) {
  const attempt = current.attempt;
  current.attempt = nextAttempt || freshAttempt();
  if (attempt.connectionTimer) clearTimeout(attempt.connectionTimer);
  attempt.iceRecovery?.dispose?.();
  try { attempt.channel?.close(); } catch { /* no-op */ }
  try { attempt.peer?.close(); } catch { /* no-op */ }
  if (attempt.sink?.abort) {
    try { await attempt.sink.abort({ discard: discardPartial }); } catch { /* best effort */ }
  }
}

async function cleanupLease({ keepView = false, discardPartial = false } = {}) {
  stopTimer();
  stopScanner();
  wakeLock.release().catch(() => {});
  if (current.signalRetryTimer) clearTimeout(current.signalRetryTimer);

  const socket = current.socket;
  const preserveState = keepView ? current.state : 'idle';
  const retained = keepView ? {
    file: current.file,
    fileId: current.fileId,
    code: current.code,
    token: current.token,
    receiveUrl: current.receiveUrl,
    expiresAt: current.expiresAt,
    attemptsCompleted: current.attemptsCompleted,
  } : null;

  await cleanupAttempt({ discardPartial });
  current = freshCurrent(preserveState);
  if (retained) Object.assign(current, retained);
  try { socket?.close(); } catch { /* no-op */ }
}

async function failTransfer(detail) {
  const senderLease = current.role === 'sender' && Boolean(current.file);
  const receiverCanResume = current.role === 'receiver' && leaseOpen() && !current.leaseExpired;
  const transferred = current.attempt.transferred;
  if (senderLease && leaseOpen() && !current.leaseExpired) {
    await cleanupAttempt();
    resetProgress();
    setState('ready', `${detail} Code remains available; scan the same QR again before the timer reaches 00:00.`);
    return;
  }
  if (senderLease) {
    await cleanupLease({ keepView: true });
    setState('expired', `${detail} The 10-minute receive window has closed.`);
    return;
  }

  await cleanupLease({ keepView: true, discardPartial: !receiverCanResume });
  const retryCopy = receiverCanResume && transferred > 0
    ? `${detail} Partial data is saved locally. Retry the same code to resume.`
    : detail;
  setState('failed', retryCopy);
}

function startConnectionTimer() {
  stopConnectionTimer();
  const attemptId = current.attempt.id;
  current.attempt.connectionTimer = setTimeout(() => {
    if (current.state !== 'connecting' || current.attempt.id !== attemptId) return;
    failTransfer('Direct connection timed out after 30 seconds.').catch(() => {});
  }, CONNECTION_TIMEOUT_MS);
}

function startCountdown(expiresAt, onExpire) {
  stopTimer();
  const tick = () => {
    const left = Math.max(0, expiresAt - Date.now());
    const seconds = Math.ceil(left / 1000);
    ui.countdown.textContent = `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
    if (left <= 0) {
      stopTimer();
      onExpire();
    }
  };
  tick();
  current.timer = setInterval(tick, 250);
}

async function handleLeaseExpiry() {
  current.leaseExpired = true;
  if (current.attempt.channel?.readyState === 'open') {
    ui.status.textContent = 'The 10-minute receive window is closed. The transfer already in progress may finish.';
    return;
  }
  await cleanupLease({ keepView: true, discardPartial: true });
  setState('expired');
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

function attachIce(peer, socket, attemptId) {
  peer.addEventListener('icecandidate', ({ candidate }) => {
    if (candidate) sendSignal(socket, { type: 'candidate', candidate, attemptId });
  });
}

function attachConnectionDiagnostics(peer, socket, attemptId, role) {
  const renegotiate = async () => {
    if (current.attempt.peer !== peer || current.attempt.id !== attemptId) return;
    const offer = await peer.createOffer({ iceRestart: true });
    await peer.setLocalDescription(offer);
    sendSignal(socket, { type: 'description', description: peer.localDescription, attemptId });
  };

  const iceRecovery = createIceRecoveryController(peer, renegotiate, {
    activeRestart: role === 'sender',
    passiveFailureGraceMs: 10_000,
    onExhausted() {
      if (current.attempt.peer === peer && current.attempt.id === attemptId) {
        failTransfer('The WebRTC path failed after one ICE recovery attempt.').catch(() => {});
      }
    },
    onError(error) {
      if (current.attempt.peer === peer && current.attempt.id === attemptId) {
        failTransfer(error?.message || 'ICE recovery failed.').catch(() => {});
      }
    },
  });
  current.attempt.iceRecovery = iceRecovery;

  peer.addEventListener('connectionstatechange', () => {
    if (current.attempt.peer !== peer || current.attempt.id !== attemptId) return;
    const state = peer.connectionState;
    if (state === 'connected') {
      stopConnectionTimer();
      iceRecovery.handleState(state).catch(() => {});
      detectSelectedCandidateType(peer).then((type) => {
        if (current.attempt.peer !== peer || current.attempt.id !== attemptId) return;
        current.attempt.transportType = type;
        const label = transportLabel(type);
        if (ui.eta) ui.eta.textContent = label;
        if (current.state === 'connecting') ui.status.textContent = `${label} path established.`;
      }).catch(() => {});
      return;
    }
    if (state === 'disconnected' || state === 'failed') {
      iceRecovery.handleState(state).catch((error) => {
        failTransfer(error?.message || 'ICE recovery failed.').catch(() => {});
      });
      return;
    }
    if (state === 'closed') {
      iceRecovery.handleState(state).catch(() => {});
      if (LIVE_CONNECTION_STATES.has(current.state)) {
        failTransfer('The direct WebRTC connection closed before the transfer finished.').catch(() => {});
      }
    }
  });
}

async function handleRemoteSignal(peer, socket, event, role, candidateBuffer, attemptId) {
  let message;
  try { message = JSON.parse(event.data); } catch { return; }
  if (message.attemptId !== attemptId) return;
  if (message.type === 'candidate' && message.candidate) {
    try { await candidateBuffer.add(message.candidate); } catch { /* candidate may arrive after closure */ }
    return;
  }
  if (message.type === 'description' && message.description) {
    await peer.setRemoteDescription(message.description);
    await candidateBuffer.flush();
    if (message.description.type === 'offer') {
      const answer = await peer.createAnswer();
      await peer.setLocalDescription(answer);
      sendSignal(socket, { type: 'description', description: peer.localDescription, attemptId });
    }
  }
}

async function createSession() {
  if (!SIGNALING_ORIGIN) throw new Error('This deployment has no signaling endpoint configured yet.');
  const response = await fetch(`${SIGNALING_ORIGIN}/v1/sessions`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  if (!response.ok) throw new Error('Could not create a transfer session.');
  return response.json();
}

function createFileId() {
  return crypto.randomUUID?.() || `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

async function resolveIceServers() {
  const optional = await fetchOptionalIceServers(SIGNALING_ORIGIN, { leaseCode: current.code });
  return [...defaultIceServers(), ...optional];
}

async function handleSenderChannelMessage(event, attemptId) {
  if (current.role !== 'sender' || current.attempt.id !== attemptId) return;
  const parsed = parseDataChannelMessage(event.data);
  if (parsed.kind !== 'control') return;
  const { type, payload } = parsed.message;

  if (type === 'resume-request') {
    if (payload.fileId !== current.fileId || current.attempt.streaming) return;
    const offset = validateResumeOffset(payload.offset, current.file.size);
    current.attempt.streaming = true;
    current.attempt.transferred = offset;
    current.attempt.startedAt = performance.now();
    setState('sending', offset > 0
      ? `Resuming ${current.file.name} from ${formatBytes(offset)}.`
      : `Sending ${current.file.name} directly to the receiver.`);
    updateProgress(offset, current.file.size, offset > 0 ? 'Resuming' : 'Sending');
    try {
      await streamFileOverChannel(current.file, current.attempt.channel, {
        fileId: current.fileId,
        offset,
        onProgress(done, total) {
          if (current.attempt.id !== attemptId) return;
          current.attempt.transferred = done;
          updateProgress(done, total, 'Sending');
        },
      });
      if (current.attempt.id === attemptId) {
        setState('verifying', 'All bytes sent. Waiting for the receiver to confirm the completed file.');
      }
    } catch (error) {
      await failTransfer(error?.message || 'The send stream failed.');
    }
    return;
  }

  if (type === 'complete-ack') {
    if (payload.fileId !== current.fileId || payload.size !== current.file.size) return;
    current.attempt.acknowledged = true;
    current.attempt.transferred = current.file.size;
    updateProgress(current.file.size, current.file.size, 'Sent');
    current.attemptsCompleted += 1;
    const completedCount = current.attemptsCompleted;
    await cleanupAttempt();
    resetProgress();
    if (leaseOpen() && !current.leaseExpired) {
      setState('ready', `${current.file.name} sent successfully (${completedCount}). Code remains available for another receiver until 00:00.`);
    } else {
      await cleanupLease({ keepView: true });
      setState('done', `${current.file.name} sent successfully. The 10-minute receive window is now closed.`);
    }
  }
}

async function startSenderAttempt(attemptId) {
  if (current.role !== 'sender' || !Number.isInteger(attemptId) || !leaseOpen()) return;
  if (current.attempt.id === attemptId) return;
  await cleanupAttempt({ nextAttempt: { ...freshAttempt(), id: attemptId } });
  if (current.attempt.id !== attemptId) return;

  const socket = current.socket;
  if (!socket) {
    if (current.attempt.id === attemptId) current.attempt = freshAttempt();
    return;
  }
  const iceServers = await resolveIceServers();
  if (current.attempt.id !== attemptId || current.socket !== socket || !leaseOpen()) return;
  const peer = createPeerConnection({ iceServers });
  const channel = createTransferChannel(peer);
  const candidateBuffer = createRemoteCandidateBuffer(peer);
  current.attempt = { ...current.attempt, peer, channel, candidateBuffer };
  attachIce(peer, socket, attemptId);
  attachConnectionDiagnostics(peer, socket, attemptId, 'sender');

  channel.addEventListener('open', () => {
    if (current.attempt.id !== attemptId) return;
    stopConnectionTimer();
    current.attempt.startedAt = performance.now();
    channel.send(encodeControlMessage('file-offer', {
      fileId: current.fileId,
      name: current.file.name,
      size: current.file.size,
      type: current.file.type || 'application/octet-stream',
      chunkSize: DEFAULT_CHUNK_SIZE,
    }));
    ui.status.textContent = 'Direct channel open. Waiting for the receiver resume offset…';
  });
  channel.addEventListener('message', (event) => {
    handleSenderChannelMessage(event, attemptId).catch((error) => failTransfer(error?.message || 'The sender control channel failed.'));
  });
  channel.addEventListener('error', () => {
    if (current.attempt.id === attemptId) failTransfer('The data channel failed. Code remains available while the timer is open.').catch(() => {});
  });
  channel.addEventListener('close', () => {
    if (current.attempt.id !== attemptId || current.attempt.acknowledged) return;
    if (LIVE_CONNECTION_STATES.has(current.state)) {
      failTransfer('The receiver disconnected before confirming the complete file.').catch(() => {});
    }
  });

  setState('connecting', 'Receiver found. Negotiating the direct path…');
  startConnectionTimer();
  const offer = await peer.createOffer();
  await peer.setLocalDescription(offer);
  sendSignal(socket, { type: 'description', description: peer.localDescription, attemptId });
}

function bindSenderSocket(socket) {
  socket.addEventListener('message', (event) => {
    let message;
    try { message = JSON.parse(event.data); } catch { return; }
    if (message.type === 'peer-ready' && Number.isInteger(message.attemptId)) {
      startSenderAttempt(message.attemptId).catch((error) => failTransfer(error?.message || 'Could not start the receiver attempt.'));
      return;
    }
    const { peer, candidateBuffer, id } = current.attempt;
    if (peer && candidateBuffer && Number.isInteger(id)) {
      handleRemoteSignal(peer, socket, event, 'sender', candidateBuffer, id).catch((error) => failTransfer(error?.message || 'Signaling failed.'));
    }
  });

  socket.addEventListener('close', (event) => {
    if (current.socket !== socket || current.role !== 'sender') return;
    current.socket = null;
    if (event.code === 4000 || !leaseOpen()) {
      current.leaseExpired = true;
      if (current.attempt.channel?.readyState !== 'open') {
        cleanupLease({ keepView: true }).then(() => setState('expired')).catch(() => {});
      }
      return;
    }
    scheduleSenderSignalReconnect();
  });
}

function scheduleSenderSignalReconnect() {
  if (current.role !== 'sender' || !leaseOpen() || current.signalRetryTimer || current.reconnecting) return;
  current.signalRetryTimer = setTimeout(() => {
    current.signalRetryTimer = null;
    ensureSenderSignal().catch(() => {});
  }, SIGNAL_RETRY_MS);
}

async function ensureSenderSignal() {
  if (current.role !== 'sender' || !leaseOpen() || current.reconnecting) return;
  if (current.socket?.readyState === WebSocket.OPEN) return;
  current.reconnecting = true;
  let retrySignal = false;
  try {
    const socket = await connectSignal(SIGNALING_ORIGIN, current.code, 'sender', current.token);
    await socket.fileQrConnected;
    if (current.role !== 'sender' || !leaseOpen()) {
      try { socket.close(); } catch { /* no-op */ }
      return;
    }
    current.socket = socket;
    bindSenderSocket(socket);
    if (current.state === 'ready') ui.status.textContent = 'Signaling restored. Code remains available.';
  } catch {
    retrySignal = true;
  } finally {
    current.reconnecting = false;
  }
  if (retrySignal && leaseOpen()) scheduleSenderSignalReconnect();
}

async function sendFile(file) {
  await cleanupLease();
  resetProgress();
  current.role = 'sender';
  current.file = file;
  current.fileId = createFileId();
  setState('preparing', `Preparing ${file.name}…`);

  try {
    const session = await createSession();
    current.code = session.code;
    current.token = session.senderToken;
    current.expiresAt = session.expiresAt;

    const socket = await connectSignal(SIGNALING_ORIGIN, session.code, 'sender', session.senderToken);
    await socket.fileQrConnected;
    current.socket = socket;
    bindSenderSocket(socket);

    const receiveUrl = new URL(location.href);
    receiveUrl.search = '';
    receiveUrl.hash = '';
    receiveUrl.searchParams.set('receive', compactReceiveCode(session.code));
    current.receiveUrl = receiveUrl.toString();
    renderSessionMeta(file, session.code, current.receiveUrl);
    setState('ready', 'Waiting for a receiver. This code stays available for the full 10-minute window.');
    startCountdown(session.expiresAt, () => { handleLeaseExpiry().catch(() => {}); });
  } catch (error) {
    await cleanupLease({ keepView: true });
    setState('failed', error?.message || 'Could not prepare this transfer.');
  }
}

function validateFileOffer(payload) {
  if (!payload || typeof payload.fileId !== 'string' || !payload.fileId) throw new Error('Invalid file offer identity');
  if (typeof payload.name !== 'string' || !payload.name) throw new Error('Invalid file offer name');
  if (!Number.isSafeInteger(payload.size) || payload.size < 0) throw new Error('Invalid file offer size');
  return {
    fileId: payload.fileId,
    name: payload.name,
    size: payload.size,
    type: payload.type || 'application/octet-stream',
    chunkSize: payload.chunkSize || DEFAULT_CHUNK_SIZE,
  };
}

function bindReceiverChannel(channel, socket, attemptId) {
  if (current.attempt.id !== attemptId) return;
  current.attempt.channel = channel;
  channel.binaryType = 'arraybuffer';
  let chain = Promise.resolve();

  channel.addEventListener('open', () => {
    if (current.attempt.id !== attemptId) return;
    stopConnectionTimer();
    current.attempt.startedAt = performance.now();
    ui.status.textContent = 'Direct channel open. Waiting for file offer…';
  });

  channel.addEventListener('message', (event) => {
    chain = chain.then(async () => {
      if (current.attempt.id !== attemptId) return;
      const parsed = parseDataChannelMessage(event.data);

      if (parsed.kind === 'control' && parsed.message.type === 'file-offer') {
        const meta = validateFileOffer(parsed.message.payload);
        current.attempt.meta = meta;
        ui.fileName.textContent = meta.name;
        ui.fileSize.textContent = formatBytes(meta.size);
        const sink = await createReceiveSink(meta, { leaseCode: current.code, fileId: meta.fileId });
        current.attempt.sink = sink;
        current.attempt.transferred = sink.offset;
        current.attempt.startedAt = performance.now();
        setState('receiving', sink.offset > 0
          ? `Resuming ${meta.name} from ${formatBytes(sink.offset)}.`
          : `Receiving ${meta.name} directly from the sender.`);
        updateProgress(sink.offset, meta.size, sink.offset > 0 ? 'Resuming' : 'Receiving');
        channel.send(encodeControlMessage('resume-request', { fileId: meta.fileId, offset: sink.offset }));
        return;
      }

      if (parsed.kind === 'binary') {
        const { sink, meta } = current.attempt;
        if (!sink || !meta) throw new Error('Received file bytes before file offer.');
        await sink.write(parsed.bytes);
        current.attempt.transferred = sink.offset;
        updateProgress(sink.offset, meta.size, 'Receiving');
        return;
      }

      if (parsed.kind === 'control' && parsed.message.type === 'transfer-complete') {
        const { sink, meta } = current.attempt;
        if (!sink || !meta) throw new Error('Transfer completed before file offer.');
        if (parsed.message.payload.fileId !== meta.fileId || parsed.message.payload.size !== meta.size) throw new Error('Transfer completion identity mismatch.');
        if (sink.offset !== meta.size) throw new Error('Transfer ended before all bytes arrived.');
        setState('verifying', 'Finalizing the received file…');
        const file = await sink.close();
        channel.send(encodeControlMessage('complete-ack', { fileId: meta.fileId, size: meta.size }));
        try { await waitForBufferedAmountLow(channel, 1); } catch { /* ack was already queued */ }
        downloadReceivedFile(file, meta.name);
        await sink.cleanup?.();
        current.attempt.sink = null;
        updateProgress(meta.size, meta.size, 'Received');
        const detail = `${meta.name} is ready on this device.`;
        await cleanupLease({ keepView: true });
        setState('done', detail);
      }
    }).catch((error) => failTransfer(error?.message || 'The receive stream failed.'));
  });

  channel.addEventListener('error', () => {
    if (current.attempt.id === attemptId) failTransfer('The receive data channel failed before the file completed.').catch(() => {});
  });
  channel.addEventListener('close', () => {
    if (current.attempt.id !== attemptId || !LIVE_CONNECTION_STATES.has(current.state)) return;
    failTransfer('The sender connection closed before the file completed.').catch(() => {});
  });
}

async function receiveFile(rawCode) {
  const code = normalizeReceiveCode(rawCode);
  if (!isReceiveCode(code)) { ui.status.textContent = 'That receive code is not valid.'; return; }
  if (!SIGNALING_ORIGIN) { setState('failed', 'This deployment has no signaling endpoint configured yet.'); return; }

  await cleanupLease({ discardPartial: false });
  resetProgress();
  current.role = 'receiver';
  current.code = code;
  renderSessionMeta(null, code, '');
  setState('connecting', `Joining ${code}…`);

  try {
    const socket = await connectSignal(SIGNALING_ORIGIN, code, 'receiver');
    current.socket = socket;
    const connected = await socket.fileQrConnected;
    if (!Number.isInteger(connected.attemptId)) throw new Error('Signaling did not provide a receiver attempt id.');
    const attemptId = connected.attemptId;
    current.expiresAt = connected.expiresAt;
    startCountdown(current.expiresAt, () => { handleLeaseExpiry().catch(() => {}); });

    const iceServers = await resolveIceServers();
    if (current.role !== 'receiver' || current.socket !== socket || !leaseOpen()) throw new Error('The receive lease expired before connection setup completed.');
    const peer = createPeerConnection({ iceServers });
    const candidateBuffer = createRemoteCandidateBuffer(peer);
    current.attempt = { ...freshAttempt(), id: attemptId, peer, candidateBuffer };
    attachIce(peer, socket, attemptId);
    attachConnectionDiagnostics(peer, socket, attemptId, 'receiver');
    startConnectionTimer();

    peer.addEventListener('datachannel', ({ channel }) => bindReceiverChannel(channel, socket, attemptId));
    socket.addEventListener('message', (event) => {
      handleRemoteSignal(peer, socket, event, 'receiver', candidateBuffer, attemptId)
        .catch((error) => failTransfer(error?.message || 'Signaling failed.'));
    });
    socket.addEventListener('close', (event) => {
      if (current.socket !== socket || current.attempt.id !== attemptId) return;
      current.socket = null;
      if (event.code === 4000 || !leaseOpen()) {
        current.leaseExpired = true;
        if (current.attempt.channel?.readyState !== 'open') {
          cleanupLease({ keepView: true, discardPartial: true }).then(() => setState('expired')).catch(() => {});
        }
      }
    });

    sendSignal(socket, { type: 'attempt-ready', attemptId });
  } catch (error) {
    await cleanupLease({ keepView: true, discardPartial: false });
    setState('failed', error?.message || 'Could not join this transfer.');
  }
}

async function onScannedPayload(payload) {
  const code = parseReceivePayload(payload);
  if (!code) {
    ui.status.textContent = 'Not a File QR receive code.';
    if (ui.scannerPanel && !ui.scannerPanel.hidden && scanner) {
      try { await scanner.start(onScannedPayload); }
      catch (error) { stopScanner(); ui.status.textContent = `Camera unavailable: ${error?.message || error}`; }
    }
    return;
  }
  if (ui.codeInput) ui.codeInput.value = code;
  stopScanner();
  await receiveFile(code);
}

async function startScanner() {
  if (!scanner || !navigator.mediaDevices?.getUserMedia) {
    ui.status.textContent = 'Camera scanning is unavailable in this browser. Enter the code instead.';
    return;
  }
  stopScanner();
  ui.scannerPanel.hidden = false;
  ui.scanQr.disabled = true;
  ui.status.textContent = 'Opening camera…';
  try {
    await scanner.start(onScannedPayload);
    ui.status.textContent = 'Camera ready. Point it at a File QR receive code.';
  } catch (error) {
    stopScanner();
    ui.status.textContent = `Camera unavailable: ${error?.message || error}`;
  }
}

async function pasteReceivePayload() {
  try {
    if (!navigator.clipboard?.readText) throw new Error('Clipboard read is unavailable.');
    const payload = await navigator.clipboard.readText();
    const code = parseReceivePayload(payload);
    if (!code) {
      ui.status.textContent = 'Clipboard does not contain a File QR receive code.';
      ui.codeInput?.focus();
      return;
    }
    ui.codeInput.value = code;
    await receiveFile(code);
  } catch (error) {
    ui.status.textContent = error?.message || 'Paste was blocked by the browser.';
    ui.codeInput?.focus();
  }
}

async function reset() {
  await cleanupLease({ discardPartial: true });
  resetProgress();
  ui.qr.innerHTML = '';
  history.replaceState({}, '', location.pathname);
  setState('idle');
}

ui.dropzone.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); ui.fileInput.click(); }
});
ui.fileInput.addEventListener('change', () => { const [file] = ui.fileInput.files; if (file) sendFile(file).catch(() => {}); });
for (const eventName of ['dragenter', 'dragover']) {
  window.addEventListener(eventName, (event) => { event.preventDefault(); document.body.dataset.dragging = 'true'; if (current.state === 'idle') setState('drag-over'); });
}
for (const eventName of ['dragleave', 'drop']) {
  window.addEventListener(eventName, (event) => { event.preventDefault(); document.body.dataset.dragging = 'false'; if (eventName === 'dragleave' && current.state === 'drag-over') setState('idle'); });
}
window.addEventListener('drop', (event) => { const [file] = event.dataTransfer?.files || []; if (file) sendFile(file).catch(() => {}); });
ui.receiveForm.addEventListener('submit', (event) => { event.preventDefault(); receiveFile(ui.codeInput.value).catch(() => {}); });
ui.codeInput.addEventListener('input', () => { ui.codeInput.value = normalizeReceiveCode(ui.codeInput.value); });
ui.pasteCode?.addEventListener('click', () => { pasteReceivePayload().catch(() => {}); });
ui.scanQr?.addEventListener('click', () => { startScanner().catch(() => {}); });
ui.scannerCancel?.addEventListener('click', () => { stopScanner(); ui.status.textContent = 'Camera scan cancelled. Enter a code or scan again.'; });
ui.copyCode.addEventListener('click', () => copyText(current.code, 'Receive code copied.'));
ui.copyLink.addEventListener('click', () => copyText(current.receiveUrl, 'Receive link copied.'));
ui.cancel.addEventListener('click', () => {
  cleanupLease({ keepView: true, discardPartial: true }).then(() => setState('cancelled')).catch(() => {});
});
ui.again.addEventListener('click', () => { reset().catch(() => {}); });
window.addEventListener('pagehide', () => { cleanupLease({ discardPartial: false }).catch(() => {}); wakeLock.destroy(); });

if (ui.scanQr && (!scanner || !navigator.mediaDevices?.getUserMedia)) ui.scanQr.hidden = true;

const receiveParam = new URLSearchParams(location.search).get('receive');
if (!platformSupported()) {
  setState('unsupported', `Use Windows or Android. Native downloads are available at ${REPO_RELEASE}.`);
} else if (receiveParam) {
  const code = parseReceivePayload(receiveParam);
  if (code) receiveFile(code).catch(() => {});
  else { setState('idle'); ui.status.textContent = 'That receive link is not valid.'; }
} else {
  setState('idle');
}