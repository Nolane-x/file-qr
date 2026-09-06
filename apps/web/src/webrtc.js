import { chunkRanges, encodeControlMessage, decodeControlMessage, DEFAULT_CHUNK_SIZE } from '../../../packages/core/transfer.js';

export const DEFAULT_ICE_SERVERS = [{ urls: 'stun:stun.l.google.com:19302' }];

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
  channel.send(encodeControlMessage('meta', { name: file.name, size: file.size, type: file.type || 'application/octet-stream', chunkSize }));
  let sent = 0;
  for (const [start, end] of chunkRanges(file.size, chunkSize)) {
    if (channel.bufferedAmount > (options.highWaterMark ?? 4 * 1024 * 1024)) {
      await waitForBufferedAmountLow(channel, options.highWaterMark ?? 4 * 1024 * 1024);
    }
    const buffer = await file.slice(start, end).arrayBuffer();
    channel.send(buffer);
    sent = end;
    options.onProgress?.(sent, file.size);
  }
  channel.send(encodeControlMessage('complete', { size: file.size }));
}

export function createPeerConnection(options = {}) {
  return new RTCPeerConnection({ iceServers: options.iceServers ?? DEFAULT_ICE_SERVERS });
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
