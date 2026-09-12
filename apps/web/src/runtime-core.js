import encodeQR from 'qr';
import { normalizeReceiveCode } from '../../../packages/core/session.js';
import { createQrScanner } from './scanner.js';
import { createWakeLockController } from './wake-lock.js';
import { estimateEta } from './progress.js';

export const SIGNALING_ORIGIN = (import.meta.env.VITE_SIGNALING_ORIGIN || '').replace(/\/$/, '');
export const REPO_RELEASE = 'https://github.com/Nolane-x/file-qr/releases/latest';
export const CONNECTION_TIMEOUT_MS = 30_000;
export const SIGNAL_RETRY_MS = 1_000;
export const FORCE_WORKER_RELAY = new URLSearchParams(location.search).get('forceRelay') === '1';
const WAKE_STATES = new Set(['connecting', 'sending', 'receiving', 'verifying']);

const STATE_COPY = {
  idle: ['Drop a file.', 'It stays on your device until someone connects. No account. No cloud file storage.'],
  'drag-over': ['Let it go.', 'Drop the file anywhere inside the transfer area.'],
  preparing: ['Preparing.', 'Creating a private 10-minute rendezvous.'],
  ready: ['Ready.', 'Scan the QR or enter the code on the receiving device.'],
  connecting: ['Connecting.', 'Establishing a secure transfer path.'],
  sending: ['Sending.', 'Keep this tab open until the transfer is complete.'],
  receiving: ['Receiving.', 'The file is streaming to this device.'],
  verifying: ['Verifying.', 'Finalizing this transfer.'],
  done: ['Done.', 'The transfer finished.'],
  expired: ['Expired.', 'The 10-minute receive window closed. Drop the file again for a fresh code.'],
  cancelled: ['Cancelled.', 'The transfer session was closed.'],
  failed: ['Couldn’t connect.', 'Retry with the same code while its receive window is still open.'],
  unsupported: ['Windows + Android.', 'This preview intentionally supports Chromium on Windows and Android only.'],
};

const $ = (selector) => document.querySelector(selector);
export const ui = {
  title: $('[data-title]'), description: $('[data-description]'), eyebrow: $('[data-eyebrow]'), status: $('[data-status]'),
  idle: $('[data-view="idle"]'), session: $('[data-view="session"]'), dropzone: $('[data-dropzone]'), fileInput: $('[data-file-input]'),
  receiveForm: $('[data-receive-form]'), codeInput: $('[data-code-input]'), pasteCode: $('[data-paste-code]'), scanQr: $('[data-scan-qr]'),
  scannerPanel: $('[data-scanner]'), scannerVideo: $('[data-scanner-video]'), scannerOverlay: $('[data-scanner-overlay]'), scannerCancel: $('[data-scanner-cancel]'),
  qr: $('[data-qr]'), fileName: $('[data-file-name]'), fileSize: $('[data-file-size]'), code: $('[data-code]'), countdown: $('[data-countdown]'),
  copyCode: $('[data-copy-code]'), copyLink: $('[data-copy-link]'), cancel: $('[data-cancel]'), again: $('[data-again]'),
  progressWrap: $('[data-progress-wrap]'), progressLabel: $('[data-progress-label]'), progressValue: $('[data-progress-value]'), progressBar: $('[data-progress-bar]'),
  rate: $('[data-rate]'), eta: $('[data-eta]'), transferSize: $('[data-transfer-size]'),
};

export function freshAttempt() {
  return {
    id: null,
    peer: null,
    channel: null,
    candidateBuffer: null,
    connectionTimer: null,
    iceRecovery: null,
    relaySocket: null,
    relayTransport: null,
    relayCapability: '',
    transportPolicy: null,
    transportType: 'unknown',
    switchingTransport: false,
    sink: null,
    meta: null,
    startedAt: 0,
    transferred: 0,
    resumeOffset: 0,
    committedBytes: 0,
    streaming: false,
    acknowledged: false,
  };
}

export function freshCurrent(state = 'idle') {
  return {
    state,
    role: null,
    socket: null,
    file: null,
    fileId: '',
    code: '',
    token: '',
    relaySecret: null,
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

export const runtime = { current: freshCurrent() };
export const runtimeHooks = { handleDirectExhausted: null };
export const wakeLock = createWakeLockController({ wakeLockApi: navigator.wakeLock, documentRef: document });
export const scanner = ui.scannerVideo && ui.scannerOverlay
  ? createQrScanner({ video: ui.scannerVideo, overlay: ui.scannerOverlay, preferEnvironment: /Android/i.test(navigator.userAgent) })
  : null;

export function current() { return runtime.current; }

export function stopScanner() {
  scanner?.stop();
  if (ui.scannerPanel) ui.scannerPanel.hidden = true;
  if (ui.scanQr) ui.scanQr.disabled = false;
}

export function setState(state, detail = '') {
  const active = current();
  active.state = state;
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

export function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const value = bytes / (1024 ** index);
  return `${value >= 100 || index === 0 ? value.toFixed(0) : value.toFixed(1)} ${units[index]}`;
}

export function transportLabel(type) {
  if (type === 'direct') return 'Direct';
  if (type === 'relay') return 'Relay';
  if (type === 'worker-relay') return 'Relayed securely';
  return 'Unknown';
}

export function platformSupported() {
  if (['localhost', '127.0.0.1'].includes(location.hostname)) return true;
  const ua = navigator.userAgent;
  const platform = navigator.userAgentData?.platform || navigator.platform || '';
  const windows = /Windows/i.test(platform) || /Windows NT/i.test(ua);
  const android = /Android/i.test(ua);
  const chromium = /Chrome|Chromium|EdgA|Edg\//i.test(ua) && !/OPR\//i.test(ua);
  return (windows || android) && chromium;
}

export function resetProgress() {
  ui.progressWrap.hidden = true;
  ui.progressBar.style.width = '0%';
  ui.progressValue.textContent = '0%';
  ui.progressLabel.textContent = 'Connecting';
  ui.rate.textContent = 'Secure P2P';
  if (ui.eta) ui.eta.textContent = 'Unknown';
  ui.transferSize.textContent = '';
}

export function updateProgress(done, total, label) {
  const active = current();
  ui.progressWrap.hidden = false;
  const ratio = total > 0 ? Math.min(1, done / total) : 0;
  const elapsedMs = Math.max(0, performance.now() - active.attempt.startedAt);
  ui.progressBar.style.width = `${(ratio * 100).toFixed(2)}%`;
  ui.progressValue.textContent = `${Math.round(ratio * 100)}%`;
  ui.progressLabel.textContent = label;
  ui.transferSize.textContent = `${formatBytes(done)} / ${formatBytes(total)}`;
  ui.rate.textContent = elapsedMs && done > 0 ? `${formatBytes(done / (elapsedMs / 1000))}/s` : 'Secure P2P';
  if (ui.eta) ui.eta.textContent = estimateEta(done, total, elapsedMs) || (ratio >= 1 ? 'Complete' : transportLabel(active.attempt.transportType));
}

export function leaseOpen() {
  const active = current();
  return Number.isFinite(active.expiresAt) && active.expiresAt > 0 && Date.now() < active.expiresAt;
}

export function stopTimer() {
  const active = current();
  if (active.timer) clearInterval(active.timer);
  active.timer = null;
}

export function stopConnectionTimer() {
  const active = current();
  if (active.attempt.connectionTimer) clearTimeout(active.attempt.connectionTimer);
  active.attempt.connectionTimer = null;
}

export function stopDirectTransport(attempt = current().attempt) {
  if (!attempt) return;
  if (attempt.connectionTimer) clearTimeout(attempt.connectionTimer);
  attempt.connectionTimer = null;
  attempt.iceRecovery?.dispose?.();
  attempt.iceRecovery = null;
  const channel = attempt.channel;
  const peer = attempt.peer;
  attempt.channel = null;
  attempt.peer = null;
  attempt.candidateBuffer = null;
  try { channel?.close(); } catch { /* no-op */ }
  try { peer?.close(); } catch { /* no-op */ }
}

export async function cleanupAttempt({ discardPartial = false, nextAttempt = null } = {}) {
  const active = current();
  const attempt = active.attempt;
  active.attempt = nextAttempt || freshAttempt();
  if (attempt.connectionTimer) clearTimeout(attempt.connectionTimer);
  attempt.iceRecovery?.dispose?.();
  try { attempt.relayTransport?.close(); } catch { /* no-op */ }
  try { attempt.relaySocket?.close(); } catch { /* no-op */ }
  try { attempt.channel?.close(); } catch { /* no-op */ }
  try { attempt.peer?.close(); } catch { /* no-op */ }
  if (attempt.sink?.abort) {
    try { await attempt.sink.abort({ discard: discardPartial }); } catch { /* best effort */ }
  }
}

export async function cleanupLease({ keepView = false, discardPartial = false } = {}) {
  const active = current();
  stopTimer();
  stopScanner();
  wakeLock.release().catch(() => {});
  if (active.signalRetryTimer) clearTimeout(active.signalRetryTimer);
  const socket = active.socket;
  const preserveState = keepView ? active.state : 'idle';
  const retained = keepView ? {
    file: active.file, fileId: active.fileId, code: active.code, token: active.token,
    relaySecret: active.relaySecret, receiveUrl: active.receiveUrl, expiresAt: active.expiresAt,
    attemptsCompleted: active.attemptsCompleted,
  } : null;
  await cleanupAttempt({ discardPartial });
  runtime.current = freshCurrent(preserveState);
  if (retained) Object.assign(runtime.current, retained);
  try { socket?.close(); } catch { /* no-op */ }
}

export async function failTransfer(detail) {
  const active = current();
  const senderLease = active.role === 'sender' && Boolean(active.file);
  const receiverCanResume = active.role === 'receiver' && leaseOpen() && !active.leaseExpired;
  const transferred = active.attempt.transferred;
  if (senderLease && leaseOpen() && !active.leaseExpired) {
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
    ? `${detail} Partial data is saved locally. Retry the same code to resume in a new attempt.`
    : detail;
  setState('failed', retryCopy);
}

export function startConnectionTimer() {
  const active = current();
  stopConnectionTimer();
  const attemptId = active.attempt.id;
  active.attempt.connectionTimer = setTimeout(() => {
    const latest = current();
    if (latest.state !== 'connecting' || latest.attempt.id !== attemptId) return;
    runtimeHooks.handleDirectExhausted?.('Direct connection timed out after 30 seconds.', attemptId).catch(() => {});
  }, CONNECTION_TIMEOUT_MS);
}

export function startCountdown(expiresAt, onExpire) {
  const active = current();
  stopTimer();
  const tick = () => {
    const left = Math.max(0, expiresAt - Date.now());
    const seconds = Math.ceil(left / 1000);
    ui.countdown.textContent = `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
    if (left <= 0) { stopTimer(); onExpire(); }
  };
  tick();
  active.timer = setInterval(tick, 250);
}

export async function handleLeaseExpiry() {
  const active = current();
  active.leaseExpired = true;
  if (active.attempt.channel?.readyState === 'open') {
    ui.status.textContent = 'The 10-minute receive window is closed. The direct transfer already in progress may finish.';
    return;
  }
  await cleanupLease({ keepView: true, discardPartial: true });
  setState('expired');
}

export async function copyText(value, message) {
  try { await navigator.clipboard.writeText(value); ui.status.textContent = message; }
  catch { ui.status.textContent = 'Copy was blocked by the browser. Select it manually.'; }
}

export function renderSessionMeta(file, code, receiveUrl) {
  ui.fileName.textContent = file?.name || 'Incoming file';
  ui.fileSize.textContent = file ? formatBytes(file.size) : 'Waiting for metadata';
  ui.code.textContent = normalizeReceiveCode(code);
  ui.qr.innerHTML = receiveUrl ? encodeQR(receiveUrl, 'svg', { ecc: 'medium', border: 4, optimize: true }) : '';
}
