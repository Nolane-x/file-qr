import { chunkRanges, encodeControlMessage, decodeControlMessage, DEFAULT_CHUNK_SIZE, validateResumeOffset } from '../../../packages/core/transfer.js';

export function defaultIceServers() {
  return [
    { urls: ['stun:stun.cloudflare.com:3478'] },
    { urls: ['stun:stun.l.google.com:19302'] },
  ];
}

export const DEFAULT_ICE_SERVERS = defaultIceServers();

function normalizeTurnIceServer(server) {
  if (!server || typeof server !== 'object') return null;
  const rawUrls = Array.isArray(server.urls) ? server.urls : [server.urls];
  const urls = rawUrls.filter((url) => typeof url === 'string' && /^(?:turn|turns):/i.test(url));
  if (!urls.length || typeof server.username !== 'string' || typeof server.credential !== 'string') return null;
  return { urls, username: server.username, credential: server.credential };
}

export async function fetchOptionalIceServers(signalingOrigin, options = {}) {
  const origin = String(signalingOrigin || '').replace(/\/$/, '');
  const leaseCode = String(options.leaseCode || '').trim();
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  if (!origin || !leaseCode || typeof fetchImpl !== 'function') return [];

  const timeoutMs = Number.isFinite(options.timeoutMs) ? Math.max(1, options.timeoutMs) : 2_500;
  const controller = typeof AbortController === 'function' ? new AbortController() : null;
  const timeout = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;
  try {
    const response = await fetchImpl(`${origin}/v1/turn-credentials`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code: leaseCode }),
      ...(controller ? { signal: controller.signal } : {}),
    });
    if (!response.ok) return [];
    const body = await response.json();
    if (!Array.isArray(body?.iceServers) || !Number.isFinite(body?.expiresAt) || body.expiresAt <= Date.now()) return [];
    return body.iceServers.map(normalizeTurnIceServer).filter(Boolean);
  } catch {
    return [];
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

export function createIceRecoveryController(peer, renegotiate, options = {}) {
  if (!peer || typeof peer.restartIce !== 'function') throw new TypeError('peer.restartIce is required');
  if (typeof renegotiate !== 'function') throw new TypeError('renegotiate must be a function');

  const graceMs = Number.isFinite(options.graceMs) ? Math.max(0, options.graceMs) : 5_000;
  const passiveFailureGraceMs = Number.isFinite(options.passiveFailureGraceMs)
    ? Math.max(0, options.passiveFailureGraceMs)
    : 10_000;
  const activeRestart = options.activeRestart !== false;
  const schedule = options.schedule || ((fn, ms) => setTimeout(fn, ms));
  const cancel = options.cancel || ((id) => clearTimeout(id));
  let graceTimer = null;
  let restartUsed = false;
  let restartPromise = null;
  let exhausted = false;
  let disposed = false;

  function clearGraceTimer() {
    if (graceTimer === null) return;
    cancel(graceTimer);
    graceTimer = null;
  }

  function schedulePassiveFailure() {
    if (graceTimer !== null || exhausted || disposed) return;
    graceTimer = schedule(() => {
      graceTimer = null;
      if (disposed || exhausted) return;
      exhausted = true;
      options.onExhausted?.();
    }, passiveFailureGraceMs);
  }

  async function hardFailure() {
    if (disposed) return 'disposed';
    clearGraceTimer();
    if (restartPromise) return restartPromise;
    if (!activeRestart) {
      schedulePassiveFailure();
      return 'waiting';
    }
    if (restartUsed) {
      if (!exhausted) {
        exhausted = true;
        options.onExhausted?.();
      }
      return 'exhausted';
    }

    restartUsed = true;
    peer.restartIce();
    restartPromise = Promise.resolve().then(renegotiate).then(() => 'restarted');
    try {
      return await restartPromise;
    } finally {
      restartPromise = null;
    }
  }

  async function handleState(state) {
    if (disposed) return 'disposed';
    if (state === 'connected' || state === 'completed') {
      clearGraceTimer();
      return 'connected';
    }
    if (state === 'disconnected') {
      if (graceTimer === null && !restartUsed) {
        graceTimer = schedule(() => {
          graceTimer = null;
          Promise.resolve(hardFailure()).catch((error) => options.onError?.(error));
        }, graceMs);
      }
      return 'waiting';
    }
    if (state === 'failed') {
      if (!activeRestart) {
        schedulePassiveFailure();
        return 'waiting';
      }
      return hardFailure();
    }
    if (state === 'closed') {
      clearGraceTimer();
      return 'closed';
    }
    return 'ignored';
  }

  return {
    handleState,
    dispose() {
      if (disposed) return;
      disposed = true;
      clearGraceTimer();
    },
    get restartUsed() { return restartUsed; },
  };
}

function statsValues(report) {
  if (!report) return [];
  if (typeof report.values === 'function') return [...report.values()];
  if (typeof report.forEach === 'function') {
    const values = [];
    report.forEach((value) => values.push(value));
    return values;
  }
  return Object.values(report);
}

function statById(report, id) {
  if (!id || !report) return null;
  if (typeof report.get === 'function') return report.get(id) || null;
  return statsValues(report).find((entry) => entry?.id === id) || null;
}

export async function detectSelectedCandidateType(peer) {
  if (!peer || typeof peer.getStats !== 'function') return 'unknown';
  let report;
  try {
    report = await peer.getStats();
  } catch {
    return 'unknown';
  }

  const values = statsValues(report);
  const transport = values.find((entry) => entry?.type === 'transport' && entry.selectedCandidatePairId);
  let pair = statById(report, transport?.selectedCandidatePairId);
  if (!pair) {
    pair = values.find((entry) => entry?.type === 'candidate-pair' && (
      entry.selected === true || (entry.nominated === true && entry.state === 'succeeded')
    ));
  }
  if (!pair) return 'unknown';

  const local = statById(report, pair.localCandidateId);
  const remote = statById(report, pair.remoteCandidateId);
  if (local?.candidateType === 'relay' || remote?.candidateType === 'relay') return 'relay';
  if (local?.candidateType || remote?.candidateType) return 'direct';
  return 'unknown';
}

export function waitForBufferedAmountLow(channel, threshold) {
  if (channel.readyState !== 'open') return Promise.reject(new Error('Data channel is not open'));
  if (channel.bufferedAmount <= threshold) return Promise.resolve();
  channel.bufferedAmountLowThreshold = Math.max(1, Math.floor(threshold / 2));
  return new Promise((resolve, reject) => {
    const onLow = () => { cleanup(); resolve(); };
    const onClose = () => { cleanup(); reject(new Error('Data channel closed')); };
    const cleanup = () => {
      channel.removeEventListener?.('bufferedamountlow', onLow);
      channel.removeEventListener?.('close', onClose);
    };
    channel.addEventListener('bufferedamountlow', onLow, { once: true });
    channel.addEventListener?.('close', onClose, { once: true });
  });
}

export async function sendByteChunks(bytes, channel, options = {}) {
  const chunkSize = options.chunkSize ?? DEFAULT_CHUNK_SIZE;
  const highWaterMark = options.highWaterMark ?? 4 * 1024 * 1024;
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let sent = 0;
  for (const [start, end] of chunkRanges(view.byteLength, chunkSize)) {
    if (channel.bufferedAmount > highWaterMark) await waitForBufferedAmountLow(channel, highWaterMark);
    const chunk = view.slice(start, end);
    channel.send(chunk.buffer);
    sent = end;
    options.onProgress?.(sent, view.byteLength);
  }
}

export async function streamFileOverChannel(file, channel, options = {}) {
  const chunkSize = options.chunkSize ?? DEFAULT_CHUNK_SIZE;
  const highWaterMark = options.highWaterMark ?? 4 * 1024 * 1024;
  const offset = validateResumeOffset(options.offset ?? 0, file.size);
  const fileId = String(options.fileId || '');
  if (!fileId) throw new Error('fileId is required for resumable transfer');

  for (const [relativeStart, relativeEnd] of chunkRanges(file.size - offset, chunkSize)) {
    if (channel.bufferedAmount > highWaterMark) {
      await waitForBufferedAmountLow(channel, highWaterMark);
    }
    const start = offset + relativeStart;
    const end = offset + relativeEnd;
    const buffer = await file.slice(start, end).arrayBuffer();
    channel.send(buffer);
    options.onProgress?.(end, file.size);
  }
  channel.send(encodeControlMessage('transfer-complete', { fileId, size: file.size }));
}

export function createPeerConnection({ iceServers = defaultIceServers() } = {}) {
  return new RTCPeerConnection({ iceServers });
}

export function createTransferChannel(peer) {
  const channel = peer.createDataChannel('file-qr', { ordered: true });
  channel.binaryType = 'arraybuffer';
  return channel;
}

export function parseDataChannelMessage(data) {
  if (typeof data === 'string') return { kind: 'control', message: decodeControlMessage(data) };
  if (data instanceof ArrayBuffer) return { kind: 'binary', bytes: new Uint8Array(data) };
  if (ArrayBuffer.isView(data)) return { kind: 'binary', bytes: new Uint8Array(data.buffer, data.byteOffset, data.byteLength) };
  throw new Error('Unsupported data-channel payload');
}

export function waitForIceGatheringComplete(peer, timeoutMs = 8_000) {
  if (peer.iceGatheringState === 'complete') return Promise.resolve();
  return new Promise(resolve => {
    const timeout = setTimeout(done, timeoutMs);
    function done() {
      clearTimeout(timeout);
      peer.removeEventListener('icegatheringstatechange', onChange);
      resolve();
    }
    function onChange() { if (peer.iceGatheringState === 'complete') done(); }
    peer.addEventListener('icegatheringstatechange', onChange);
  });
}

export function createRemoteCandidateBuffer(peer) {
  const pending = [];
  return {
    async add(candidate) {
      if (peer.remoteDescription) return peer.addIceCandidate(candidate);
      pending.push(candidate);
    },
    async flush() {
      while (pending.length) await peer.addIceCandidate(pending.shift());
    },
    get size() { return pending.length; },
  };
}
