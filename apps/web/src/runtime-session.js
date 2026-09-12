import { isReceiveCode, normalizeReceiveCode } from '../../../packages/core/session.js';
import { connectSignal, sendSignal } from './signaling.js';
import { buildReceivePayloadUrl, generateRelaySecret } from './receive-payload.js';
import { createTransportPolicy } from './transport-policy.js';
import {
  FORCE_WORKER_RELAY,
  SIGNALING_ORIGIN,
  SIGNAL_RETRY_MS,
  cleanupLease,
  current,
  failTransfer,
  freshAttempt,
  handleLeaseExpiry,
  leaseOpen,
  renderSessionMeta,
  resetProgress,
  setState,
  startCountdown,
  ui,
} from './runtime-core.js';
import { handleRemoteSignal, startReceiverDirectAttempt, startSenderAttempt } from './runtime-direct.js';
import { startRelayAttempt } from './runtime-relay.js';

async function createSession() {
  if (!SIGNALING_ORIGIN) throw new Error('This deployment has no signaling endpoint configured yet.');
  const response = await fetch(`${SIGNALING_ORIGIN}/v1/sessions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{}',
  });
  if (!response.ok) throw new Error('Could not create a transfer session.');
  return response.json();
}

function createFileId() {
  return crypto.randomUUID?.() || `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

export function bindSenderSocket(socket) {
  socket.addEventListener('message', (event) => {
    let message;
    try { message = JSON.parse(event.data); } catch { return; }
    if (message.type === 'peer-ready' && Number.isInteger(message.attemptId)) {
      startSenderAttempt(message.attemptId, message.relayCapability || '')
        .catch((error) => failTransfer(error?.message || 'Could not start the receiver attempt.'));
      return;
    }
    const active = current();
    const { peer, candidateBuffer, id } = active.attempt;
    if (peer && candidateBuffer && Number.isInteger(id)) {
      handleRemoteSignal(peer, socket, event, 'sender', candidateBuffer, id)
        .catch((error) => failTransfer(error?.message || 'Signaling failed.'));
    }
  });

  socket.addEventListener('close', (event) => {
    const active = current();
    if (active.socket !== socket || active.role !== 'sender') return;
    active.socket = null;
    if (event.code === 4000 || !leaseOpen()) {
      active.leaseExpired = true;
      if (active.attempt.channel?.readyState !== 'open') {
        cleanupLease({ keepView: true }).then(() => setState('expired')).catch(() => {});
      }
      return;
    }
    scheduleSenderSignalReconnect();
  });
}

export function scheduleSenderSignalReconnect() {
  const active = current();
  if (active.role !== 'sender' || !leaseOpen() || active.signalRetryTimer || active.reconnecting) return;
  active.signalRetryTimer = setTimeout(() => {
    if (current().signalRetryTimer) current().signalRetryTimer = null;
    ensureSenderSignal().catch(() => {});
  }, SIGNAL_RETRY_MS);
}

export async function ensureSenderSignal() {
  const active = current();
  if (active.role !== 'sender' || !leaseOpen() || active.reconnecting) return;
  if (active.socket?.readyState === WebSocket.OPEN) return;
  active.reconnecting = true;
  let retrySignal = false;
  try {
    const socket = await connectSignal(SIGNALING_ORIGIN, active.code, 'sender', active.token);
    await socket.fileQrConnected;
    if (current().role !== 'sender' || !leaseOpen()) {
      try { socket.close(); } catch { /* no-op */ }
      return;
    }
    current().socket = socket;
    bindSenderSocket(socket);
    if (current().state === 'ready') ui.status.textContent = 'Signaling restored. Code remains available.';
  } catch {
    retrySignal = true;
  } finally {
    current().reconnecting = false;
  }
  if (retrySignal && leaseOpen()) scheduleSenderSignalReconnect();
}

export async function sendFile(file) {
  await cleanupLease();
  resetProgress();
  const active = current();
  active.role = 'sender';
  active.file = file;
  active.fileId = createFileId();
  active.relaySecret = generateRelaySecret();
  setState('preparing', `Preparing ${file.name}…`);

  try {
    const session = await createSession();
    current().code = session.code;
    current().token = session.senderToken;
    current().expiresAt = session.expiresAt;

    const socket = await connectSignal(SIGNALING_ORIGIN, session.code, 'sender', session.senderToken);
    await socket.fileQrConnected;
    current().socket = socket;
    bindSenderSocket(socket);

    const receivePayloadUrl = new URL(buildReceivePayloadUrl(location.href, session.code, current().relaySecret));
    if (FORCE_WORKER_RELAY) receivePayloadUrl.searchParams.set('forceRelay', '1');
    current().receiveUrl = receivePayloadUrl.toString();
    renderSessionMeta(file, session.code, current().receiveUrl);
    setState('ready', 'Waiting for a receiver. Scan the QR for secure relay fallback; the code remains available for the full 10-minute window.');
    startCountdown(session.expiresAt, () => { handleLeaseExpiry().catch(() => {}); });
  } catch (error) {
    await cleanupLease({ keepView: true });
    setState('failed', error?.message || 'Could not prepare this transfer.');
  }
}

export async function receiveFile(rawCode, relaySecret = null) {
  if (!isReceiveCode(rawCode)) {
    ui.status.textContent = 'That receive code is not valid.';
    return;
  }
  const code = normalizeReceiveCode(rawCode);
  if (!SIGNALING_ORIGIN) {
    setState('failed', 'This deployment has no signaling endpoint configured yet.');
    return;
  }

  await cleanupLease({ discardPartial: false });
  resetProgress();
  current().role = 'receiver';
  current().code = code;
  current().relaySecret = relaySecret;
  renderSessionMeta(null, code, '');
  setState('connecting', `Joining ${code}…`);

  try {
    const socket = await connectSignal(SIGNALING_ORIGIN, code, 'receiver');
    current().socket = socket;
    const connected = await socket.fileQrConnected;
    if (!Number.isInteger(connected.attemptId)) throw new Error('Signaling did not provide a receiver attempt id.');
    const attemptId = connected.attemptId;
    current().expiresAt = connected.expiresAt;
    startCountdown(current().expiresAt, () => { handleLeaseExpiry().catch(() => {}); });

    current().attempt = {
      ...freshAttempt(),
      id: attemptId,
      relayCapability: connected.relayCapability || '',
      transportPolicy: createTransportPolicy({ hasRelaySecret: Boolean(relaySecret), forceRelay: FORCE_WORKER_RELAY }),
    };
    const transportStart = current().attempt.transportPolicy.start();

    socket.addEventListener('close', (event) => {
      const latest = current();
      if (latest.socket !== socket || latest.attempt.id !== attemptId) return;
      latest.socket = null;
      if (event.code === 4000 || !leaseOpen()) {
        latest.leaseExpired = true;
        if (latest.attempt.channel?.readyState !== 'open') {
          cleanupLease({ keepView: true, discardPartial: true }).then(() => setState('expired')).catch(() => {});
        }
      }
    });

    if (transportStart.action === 'require-qr-relay-secret') {
      throw new Error('Secure relay requires scanning the sender QR.');
    }
    if (transportStart.action === 'connect-relay') {
      sendSignal(socket, { type: 'attempt-ready', attemptId });
      setState('connecting', 'Trying another connection path…');
      await startRelayAttempt(attemptId);
      return;
    }

    await startReceiverDirectAttempt(socket, attemptId);
    sendSignal(socket, { type: 'attempt-ready', attemptId });
  } catch (error) {
    await cleanupLease({ keepView: true, discardPartial: false });
    setState('failed', error?.message || 'Could not join this transfer.');
  }
}
