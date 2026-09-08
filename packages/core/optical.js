import { crc32 } from './crc32.js';

export const OPTICAL_VERSION = 'FQR1';
export const MIN_OPTICAL_PAYLOAD_BYTES = 32;
export const DEFAULT_OPTICAL_PAYLOAD_BYTES = 420;

function toBase64Url(bytes) {
  if (typeof Buffer !== 'undefined') return Buffer.from(bytes).toString('base64url');
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function fromBase64Url(text) {
  if (typeof Buffer !== 'undefined') return new Uint8Array(Buffer.from(text, 'base64url'));
  const padded = text.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((text.length + 3) % 4);
  const binary = atob(padded);
  return Uint8Array.from(binary, ch => ch.charCodeAt(0));
}

export function encodeOpticalFrames(input, options = {}) {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  const payloadBytes = options.payloadBytes ?? DEFAULT_OPTICAL_PAYLOAD_BYTES;
  if (!Number.isInteger(payloadBytes) || payloadBytes < MIN_OPTICAL_PAYLOAD_BYTES || payloadBytes > 1024) throw new Error('Invalid optical payload size');
  const streamId = String(options.streamId ?? '').toUpperCase();
  if (!/^[A-Z0-9]{8}$/.test(streamId)) throw new Error('streamId must be 8 uppercase alphanumeric characters');
  const total = Math.max(1, Math.ceil(bytes.length / payloadBytes));
  const frames = [];
  for (let sequence = 0; sequence < total; sequence++) {
    const chunk = bytes.slice(sequence * payloadBytes, Math.min(bytes.length, (sequence + 1) * payloadBytes));
    const crc = crc32(chunk).toString(16).padStart(8, '0');
    frames.push(`${OPTICAL_VERSION}|${streamId}|${sequence}|${total}|${crc}|${toBase64Url(chunk)}`);
  }
  return frames;
}

export function decodeOpticalFrame(frame) {
  const parts = String(frame).split('|');
  if (parts.length !== 6 || parts[0] !== OPTICAL_VERSION) throw new Error('Unsupported optical frame');
  const [, streamId, sequenceRaw, totalRaw, crcRaw, payloadRaw] = parts;
  const sequence = Number(sequenceRaw);
  const total = Number(totalRaw);
  if (!/^[A-Z0-9]{8}$/.test(streamId) || !Number.isInteger(sequence) || !Number.isInteger(total) || sequence < 0 || total <= 0 || sequence >= total) {
    throw new Error('Malformed optical frame');
  }
  const payload = fromBase64Url(payloadRaw);
  const expected = Number.parseInt(crcRaw, 16) >>> 0;
  if (!/^[0-9a-fA-F]{8}$/.test(crcRaw) || crc32(payload) !== expected) throw new Error('Optical frame CRC mismatch');
  return { version: OPTICAL_VERSION, streamId, sequence, total, payload };
}

export class OpticalAssembler {
  #streamId = null;
  #total = 0;
  #chunks = new Map();
  #receivedBytes = 0;
  #maxBytes;
  #maxFrames;

  constructor(options = {}) {
    this.#maxBytes = options.maxBytes ?? Number.POSITIVE_INFINITY;
    this.#maxFrames = options.maxFrames ?? Number.POSITIVE_INFINITY;
  }

  accept(frame) {
    const parsed = typeof frame === 'string' ? decodeOpticalFrame(frame) : frame;
    if (parsed.total > this.#maxFrames) throw new Error('Optical stream exceeds frame limit');
    if (this.#streamId && (parsed.streamId !== this.#streamId || parsed.total !== this.#total)) throw new Error('Optical stream mismatch');
    if (this.#chunks.has(parsed.sequence)) return { accepted: false, duplicate: true, received: this.received, total: this.total };
    if (this.#receivedBytes + parsed.payload.byteLength > this.#maxBytes) throw new Error('Optical stream exceeds receive byte limit');
    if (!this.#streamId) {
      this.#streamId = parsed.streamId;
      this.#total = parsed.total;
    }
    this.#chunks.set(parsed.sequence, parsed.payload);
    this.#receivedBytes += parsed.payload.byteLength;
    return { accepted: true, duplicate: false, received: this.received, total: this.total };
  }

  get streamId() { return this.#streamId; }
  get received() { return this.#chunks.size; }
  get total() { return this.#total; }
  get complete() { return this.#total > 0 && this.#chunks.size === this.#total; }
  get progress() { return this.#total ? this.#chunks.size / this.#total : 0; }

  missing() {
    const missing = [];
    for (let i = 0; i < this.#total; i++) if (!this.#chunks.has(i)) missing.push(i);
    return missing;
  }

  bytes() {
    if (!this.complete) throw new Error('Optical stream is incomplete');
    let length = 0;
    for (let i = 0; i < this.#total; i++) length += this.#chunks.get(i).length;
    const out = new Uint8Array(length);
    let offset = 0;
    for (let i = 0; i < this.#total; i++) {
      const chunk = this.#chunks.get(i);
      out.set(chunk, offset);
      offset += chunk.length;
    }
    return out;
  }
}
