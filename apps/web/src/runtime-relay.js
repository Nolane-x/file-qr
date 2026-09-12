import { DEFAULT_CHUNK_SIZE } from '../../../packages/core/transfer.js';
import { connectRelay } from './signaling.js';
import { createRelayCryptoContext } from './relay-crypto.js';
import { createWorkerRelayTransport } from './relay-transport.js';
import {
  current,
  failTransfer,
  leaseOpen,
  setState,
  stopConnectionTimer,
  stopDirectTransport,
  ui,
} from './runtime-core.js';
import {
  controlEnvelope,
  handleReceiverRelayControl,
  handleSenderRelayControl,
  receiveTransferBytes,
} from './runtime-transfer.js';

export async function startRelayAttempt(attemptId) {
  let active = current();
  if (active.attempt.id !== attemptId || !leaseOpen()) return;
  const attempt = active.attempt;
  const { role, relaySecret } = active;
  if (!relaySecret || !attempt.relayCapability) {
    throw new Error('Secure relay fallback requires scanning the sender QR.');
  }
  if (role !== 'sender' && role !== 'receiver') throw new Error('Invalid relay role');

  stopConnectionTimer();
  attempt.switchingTransport = true;
  stopDirectTransport(attempt);
  if (role === 'receiver' && attempt.sink?.abort) {
    await attempt.sink.abort({ discard: false });
    attempt.sink = null;
    attempt.meta = null;
  }

  const outboundDirection = role === 'sender' ? 'sender-to-receiver' : 'receiver-to-sender';
  const inboundDirection = role === 'sender' ? 'receiver-to-sender' : 'sender-to-receiver';
  const sendCrypto = await createRelayCryptoContext({
    relaySecret,
    code: active.code,
    attemptId,
    direction: outboundDirection,
  });
  active = current();
  if (active.attempt.id !== attemptId || !leaseOpen()) return;

  const remaining = role === 'sender'
    ? Math.max(0, active.file.size - validateKnownResumeOffset(active.attempt.resumeOffset, active.file.size))
    : null;
  const socket = await connectRelay(active.role === role ? activeSignalingOrigin() : '', active.code, {
    role,
    attemptId,
    capability: active.attempt.relayCapability,
    remaining,
    noncePrefix: sendCrypto.noncePrefix,
  });
  active = current();
  if (active.attempt.id !== attemptId || !leaseOpen()) {
    try { socket.close(); } catch { /* no-op */ }
    return;
  }
  active.attempt.relaySocket = socket;
  const { peerNoncePrefix } = await socket.fileQrRelayReady;
  active = current();
  if (active.attempt.id !== attemptId || !leaseOpen()) {
    try { socket.close(); } catch { /* no-op */ }
    return;
  }

  const receiveCrypto = await createRelayCryptoContext({
    relaySecret,
    code: active.code,
    attemptId,
    direction: inboundDirection,
    noncePrefix: peerNoncePrefix,
  });

  const relayTransport = createWorkerRelayTransport({
    socket,
    role,
    sendCrypto,
    receiveCrypto,
    async onData(bytes) {
      if (current().attempt.id !== attemptId) return;
      await receiveTransferBytes(bytes, attemptId);
    },
    async onControl(value) {
      const latest = current();
      if (latest.attempt.id !== attemptId) return;
      if (role === 'sender') await handleSenderRelayControl(value, attemptId);
      else await handleReceiverRelayControl(value, attemptId);
    },
    onError(error) {
      const latest = current();
      if (latest.attempt.id !== attemptId || latest.attempt.acknowledged) return;
      failTransfer(error?.message || 'Secure relay failed.').catch(() => {});
    },
  });

  active = current();
  if (active.attempt.id !== attemptId) {
    relayTransport.close();
    return;
  }
  active.attempt.relayTransport = relayTransport;
  active.attempt.transportType = 'worker-relay';
  active.attempt.switchingTransport = false;
  stopConnectionTimer();
  try { active.attempt.transportPolicy?.relayConnected(); } catch { /* stale transition */ }
  if (ui.eta) ui.eta.textContent = 'Relayed securely';
  ui.status.textContent = 'Relayed securely. Encrypted file data is forwarding through the Worker without file storage.';

  if (role === 'sender') {
    await relayTransport.sendControl(controlEnvelope('file-offer', {
      fileId: active.fileId,
      name: active.file.name,
      size: active.file.size,
      type: active.file.type || 'application/octet-stream',
      chunkSize: DEFAULT_CHUNK_SIZE,
    }));
  }
}

function validateKnownResumeOffset(offset, size) {
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > size) return 0;
  return offset;
}

function activeSignalingOrigin() {
  const configured = (import.meta.env.VITE_SIGNALING_ORIGIN || '').replace(/\/$/, '');
  if (!configured) throw new Error('This deployment has no signaling endpoint configured yet.');
  return configured;
}
