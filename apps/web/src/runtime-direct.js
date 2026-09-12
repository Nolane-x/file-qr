import { DEFAULT_CHUNK_SIZE, encodeControlMessage } from '../../../packages/core/transfer.js';
import {
  createIceRecoveryController,
  createPeerConnection,
  createRemoteCandidateBuffer,
  createTransferChannel,
  defaultIceServers,
  detectSelectedCandidateType,
  fetchOptionalIceServers,
} from './webrtc.js';
import { sendSignal } from './signaling.js';
import { createTransportPolicy } from './transport-policy.js';
import {
  FORCE_WORKER_RELAY,
  SIGNALING_ORIGIN,
  cleanupAttempt,
  current,
  failTransfer,
  freshAttempt,
  leaseOpen,
  runtimeHooks,
  setState,
  startConnectionTimer,
  stopConnectionTimer,
  transportLabel,
  ui,
} from './runtime-core.js';
import { bindReceiverChannel, handleSenderChannelMessage } from './runtime-transfer.js';
import { startRelayAttempt } from './runtime-relay.js';

const LIVE_CONNECTION_STATES = new Set(['connecting', 'sending', 'receiving', 'verifying']);

export async function resolveIceServers() {
  const optional = await fetchOptionalIceServers(SIGNALING_ORIGIN, { leaseCode: current().code });
  return [...defaultIceServers(), ...optional];
}

export function attachIce(peer, socket, attemptId) {
  peer.addEventListener('icecandidate', ({ candidate }) => {
    if (candidate) sendSignal(socket, { type: 'candidate', candidate, attemptId });
  });
}

function noteDirectActive() {
  const policy = current().attempt.transportPolicy;
  if (policy?.state === 'connecting-direct') {
    try { policy.directConnected(); } catch { /* stale transition */ }
  }
}

export async function handleDirectExhausted(detail, attemptId) {
  const active = current();
  if (active.attempt.id !== attemptId) return;
  const attempt = active.attempt;
  if (attempt.switchingTransport || attempt.transportType === 'worker-relay') return;
  const policy = attempt.transportPolicy;
  if (!policy) {
    await failTransfer(detail);
    return;
  }
  if (policy.state !== 'connecting-direct' && policy.state !== 'direct') return;

  let transition;
  try {
    transition = policy.directExhausted({ committedBytes: attempt.committedBytes });
  } catch (error) {
    await failTransfer(error?.message || detail);
    return;
  }

  if (transition.action === 'connect-relay') {
    attempt.switchingTransport = true;
    setState('connecting', 'Trying another connection path…');
    try {
      await startRelayAttempt(attemptId);
    } catch (error) {
      await failTransfer(error?.message || 'Secure relay fallback failed.');
    }
    return;
  }
  if (transition.action === 'require-qr-relay-secret') {
    await failTransfer(`${detail} Secure relay fallback requires scanning the sender QR; a typed code cannot silently downgrade confidentiality.`);
    return;
  }
  if (transition.action === 'retry-new-attempt') {
    await failTransfer(`${detail} New bytes were already committed, so same-attempt transport splicing is blocked; resume in a new attempt.`);
    return;
  }
  await failTransfer(detail);
}

runtimeHooks.handleDirectExhausted = handleDirectExhausted;

export function attachConnectionDiagnostics(peer, socket, attemptId, role) {
  const renegotiate = async () => {
    const active = current();
    if (active.attempt.peer !== peer || active.attempt.id !== attemptId) return;
    const offer = await peer.createOffer({ iceRestart: true });
    await peer.setLocalDescription(offer);
    sendSignal(socket, { type: 'description', description: peer.localDescription, attemptId });
  };

  const iceRecovery = createIceRecoveryController(peer, renegotiate, {
    activeRestart: role === 'sender',
    passiveFailureGraceMs: 10_000,
    onExhausted() {
      const active = current();
      if (active.attempt.peer === peer && active.attempt.id === attemptId) {
        handleDirectExhausted('The direct WebRTC path failed after one ICE recovery attempt.', attemptId).catch(() => {});
      }
    },
    onError(error) {
      const active = current();
      if (active.attempt.peer === peer && active.attempt.id === attemptId) {
        handleDirectExhausted(error?.message || 'ICE recovery failed.', attemptId).catch(() => {});
      }
    },
  });
  current().attempt.iceRecovery = iceRecovery;

  peer.addEventListener('connectionstatechange', () => {
    const active = current();
    if (active.attempt.peer !== peer || active.attempt.id !== attemptId) return;
    const state = peer.connectionState;
    if (state === 'connected') {
      iceRecovery.handleState(state).catch(() => {});
      detectSelectedCandidateType(peer).then((type) => {
        const latest = current();
        if (latest.attempt.peer !== peer || latest.attempt.id !== attemptId) return;
        latest.attempt.transportType = type;
        const label = transportLabel(type);
        if (ui.eta) ui.eta.textContent = label;
        if (latest.state === 'connecting') ui.status.textContent = `${label} path established.`;
      }).catch(() => {});
      return;
    }
    if (state === 'disconnected' || state === 'failed') {
      const policy = active.attempt.transportPolicy;
      if (policy && (policy.state === 'connecting-direct' || policy.state === 'direct')) {
        try { policy.directDisconnected(); } catch { /* stale transition */ }
      }
      iceRecovery.handleState(state).catch((error) => {
        handleDirectExhausted(error?.message || 'ICE recovery failed.', attemptId).catch(() => {});
      });
      return;
    }
    if (state === 'closed') {
      iceRecovery.handleState(state).catch(() => {});
      const latest = current();
      if (!latest.attempt.switchingTransport && LIVE_CONNECTION_STATES.has(latest.state)) {
        handleDirectExhausted('The direct WebRTC connection closed before the transfer finished.', attemptId).catch(() => {});
      }
    }
  });
}

export async function handleRemoteSignal(peer, socket, event, role, candidateBuffer, attemptId) {
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

export async function startSenderAttempt(attemptId, relayCapability = '') {
  let active = current();
  if (active.role !== 'sender' || !Number.isInteger(attemptId) || !leaseOpen()) return;
  if (current().attempt.id === attemptId) return;
  await cleanupAttempt({ nextAttempt: { ...freshAttempt(), id: attemptId } });
  if (current().attempt.id !== attemptId) return;
  active = current();
  active.attempt.relayCapability = relayCapability;
  active.attempt.transportPolicy = createTransportPolicy({ hasRelaySecret: Boolean(active.relaySecret), forceRelay: FORCE_WORKER_RELAY });

  const socket = active.socket;
  if (!socket) {
    if (current().attempt.id === attemptId) current().attempt = freshAttempt();
    return;
  }
  const transportStart = active.attempt.transportPolicy.start();
  if (transportStart.action === 'require-qr-relay-secret') {
    await failTransfer('Forced secure relay requires scanning the sender QR.');
    return;
  }
  if (transportStart.action === 'connect-relay') {
    setState('connecting', 'Trying another connection path…');
    await startRelayAttempt(attemptId);
    return;
  }

  const iceServers = await resolveIceServers();
  if (current().attempt.id !== attemptId || current().socket !== socket || !leaseOpen()) return;
  const peer = createPeerConnection({ iceServers });
  const channel = createTransferChannel(peer);
  const candidateBuffer = createRemoteCandidateBuffer(peer);
  Object.assign(current().attempt, { peer, channel, candidateBuffer });
  attachIce(peer, socket, attemptId);
  attachConnectionDiagnostics(peer, socket, attemptId, 'sender');

  channel.addEventListener('open', () => {
    const latest = current();
    if (latest.attempt.id !== attemptId) return;
    noteDirectActive();
    stopConnectionTimer();
    latest.attempt.startedAt = performance.now();
    channel.send(encodeControlMessage('file-offer', {
      fileId: latest.fileId,
      name: latest.file.name,
      size: latest.file.size,
      type: latest.file.type || 'application/octet-stream',
      chunkSize: DEFAULT_CHUNK_SIZE,
    }));
    ui.status.textContent = 'Direct channel open. Waiting for the receiver resume offset…';
  });
  channel.addEventListener('message', (event) => {
    handleSenderChannelMessage(event, attemptId).catch((error) => failTransfer(error?.message || 'The sender control channel failed.'));
  });
  channel.addEventListener('error', () => {
    const latest = current();
    if (latest.attempt.id === attemptId && !latest.attempt.switchingTransport) {
      handleDirectExhausted('The direct data channel failed.', attemptId).catch(() => {});
    }
  });
  channel.addEventListener('close', () => {
    const latest = current();
    if (latest.attempt.id !== attemptId || latest.attempt.acknowledged || latest.attempt.switchingTransport) return;
    if (LIVE_CONNECTION_STATES.has(latest.state)) {
      handleDirectExhausted('The receiver disconnected before confirming the complete file.', attemptId).catch(() => {});
    }
  });

  setState('connecting', 'Receiver found. Negotiating the direct path…');
  startConnectionTimer();
  const offer = await peer.createOffer();
  await peer.setLocalDescription(offer);
  sendSignal(socket, { type: 'description', description: peer.localDescription, attemptId });
}

export async function startReceiverDirectAttempt(socket, attemptId) {
  const iceServers = await resolveIceServers();
  const active = current();
  if (active.role !== 'receiver' || active.socket !== socket || active.attempt.id !== attemptId || !leaseOpen()) {
    throw new Error('The receive lease expired before connection setup completed.');
  }
  const peer = createPeerConnection({ iceServers });
  const candidateBuffer = createRemoteCandidateBuffer(peer);
  Object.assign(active.attempt, { peer, candidateBuffer });
  attachIce(peer, socket, attemptId);
  attachConnectionDiagnostics(peer, socket, attemptId, 'receiver');
  startConnectionTimer();

  peer.addEventListener('datachannel', ({ channel }) => bindReceiverChannel(channel, attemptId));
  socket.addEventListener('message', (event) => {
    handleRemoteSignal(peer, socket, event, 'receiver', candidateBuffer, attemptId)
      .catch((error) => failTransfer(error?.message || 'Signaling failed.'));
  });
}
