import { crc32 } from './crc32.js';

export const FQR2_VERSION = 'FQR2';
export const FQR2_BLOCK_BYTES = 64 * 1024;
export const FQR2_DEFAULT_SYMBOL_BYTES = 768;
export const FQR2_MIN_SYMBOL_BYTES = 256;
export const FQR2_MAX_SYMBOL_BYTES = 900;
export const FQR2_MAX_SOURCE_SYMBOLS = 256;
export const FQR2_MAX_FILE_BYTES = 64 * 1024 * 1024;
export const FQR2_MAX_BLOCKS = 1024;
export const FQR2_MAX_METADATA_BYTES = 2048;
export const FQR2_MAX_SEQ_NUM = 0xffffffff;
export const FQR2_MAX_FRAME_TEXT = 8192;

const STREAM_ID_RE = /^[0-9A-HJKMNP-TV-Z]{12}$/;
const SHA256_RE = /^[0-9a-f]{64}$/;
const CRC32_RE = /^[0-9a-f]{8}$/;
const BASE64URL_RE = /^[A-Za-z0-9_-]*$/;
const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });

function requireFrameText(frame) {
  const text = String(frame);
  if (text.length === 0 || text.length > FQR2_MAX_FRAME_TEXT) throw new Error('FQR2 frame exceeds text limit');
  return text;
}

function requireStreamId(value) {
  const streamId = String(value ?? '');
  if (!STREAM_ID_RE.test(streamId)) throw new Error('Malformed FQR2 stream ID');
  return streamId;
}

function requireSha256(value) {
  const hash = String(value ?? '');
  if (!SHA256_RE.test(hash)) throw new Error('Malformed FQR2 SHA-256 hash');
  return hash;
}

function parseUint(text, label, max, { min = 0 } = {}) {
  if (!/^(0|[1-9][0-9]*)$/.test(String(text))) throw new Error(`Malformed FQR2 ${label}`);
  const value = Number(text);
  if (!Number.isSafeInteger(value) || value < min || value > max) throw new Error(`FQR2 ${label} exceeds limit`);
  return value;
}

function toBase64Url(bytes) {
  const input = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  if (typeof Buffer !== 'undefined') return Buffer.from(input).toString('base64url');
  let binary = '';
  for (const byte of input) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function fromBase64Url(text, maxBytes, label) {
  const raw = String(text ?? '');
  if (!BASE64URL_RE.test(raw)) throw new Error(`Malformed FQR2 ${label}`);
  if (raw.length > Math.ceil(maxBytes * 4 / 3) + 4) throw new Error(`FQR2 ${label} exceeds limit`);
  let bytes;
  try {
    if (typeof Buffer !== 'undefined') bytes = new Uint8Array(Buffer.from(raw, 'base64url'));
    else {
      const padded = raw.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((raw.length + 3) % 4);
      const binary = atob(padded);
      bytes = Uint8Array.from(binary, char => char.charCodeAt(0));
    }
  } catch {
    throw new Error(`Malformed FQR2 ${label}`);
  }
  if (bytes.byteLength > maxBytes || toBase64Url(bytes) !== raw) throw new Error(`Malformed FQR2 ${label}`);
  return bytes;
}

function crcHex(bytes) {
  return crc32(bytes).toString(16).padStart(8, '0');
}

function requireSymbolBytes(value) {
  if (!Number.isInteger(value) || value < FQR2_MIN_SYMBOL_BYTES || value > FQR2_MAX_SYMBOL_BYTES) {
    throw new Error('FQR2 symbol size exceeds limit');
  }
  return value;
}

function requireFileSize(value) {
  if (!Number.isSafeInteger(value) || value < 0 || value > FQR2_MAX_FILE_BYTES) throw new Error('FQR2 file size exceeds limit');
  return value;
}

function expectedBlockCount(fileSize) {
  return Math.max(1, Math.ceil(fileSize / FQR2_BLOCK_BYTES));
}

export function expectedBlockGeometry(manifest, blockIndex) {
  if (!manifest || manifest.blockBytes !== FQR2_BLOCK_BYTES) throw new Error('FQR2 manifest geometry mismatch');
  const index = Number(blockIndex);
  if (!Number.isInteger(index) || index < 0 || index >= manifest.blockCount) throw new Error('FQR2 block index exceeds limit');
  const symbolBytes = requireSymbolBytes(manifest.symbolBytes);
  if (manifest.fileSize === 0) return { blockLength: 0, k: 1 };
  const start = index * FQR2_BLOCK_BYTES;
  const blockLength = Math.min(FQR2_BLOCK_BYTES, manifest.fileSize - start);
  const k = Math.max(1, Math.ceil(blockLength / symbolBytes));
  if (k > FQR2_MAX_SOURCE_SYMBOLS) throw new Error('FQR2 source symbol count exceeds limit');
  return { blockLength, k };
}

export function encodeFqr2Manifest(input) {
  const streamId = requireStreamId(input?.streamId);
  const fileSize = requireFileSize(input?.fileSize);
  const symbolBytes = requireSymbolBytes(input?.symbolBytes ?? FQR2_DEFAULT_SYMBOL_BYTES);
  const blockCount = expectedBlockCount(fileSize);
  if (blockCount > FQR2_MAX_BLOCKS) throw new Error('FQR2 block count exceeds limit');
  const metadata = encoder.encode(JSON.stringify({
    name: String(input?.name || 'file.bin'),
    type: String(input?.type || 'application/octet-stream'),
  }));
  if (metadata.byteLength > FQR2_MAX_METADATA_BYTES) throw new Error('FQR2 metadata exceeds limit');
  return [
    FQR2_VERSION, 'M', streamId, String(fileSize), String(FQR2_BLOCK_BYTES), String(symbolBytes), String(blockCount),
    crcHex(metadata), toBase64Url(metadata),
  ].join('|');
}

export function decodeFqr2Manifest(frame) {
  const parts = requireFrameText(frame).split('|');
  if (parts.length !== 9 || parts[0] !== FQR2_VERSION || parts[1] !== 'M') throw new Error('Unsupported FQR2 manifest');
  const streamId = requireStreamId(parts[2]);
  const fileSize = parseUint(parts[3], 'file size', FQR2_MAX_FILE_BYTES);
  const blockBytes = parseUint(parts[4], 'block size', FQR2_BLOCK_BYTES, { min: 1 });
  const symbolBytes = parseUint(parts[5], 'symbol size', FQR2_MAX_SYMBOL_BYTES, { min: FQR2_MIN_SYMBOL_BYTES });
  const blockCount = parseUint(parts[6], 'block count', FQR2_MAX_BLOCKS, { min: 1 });
  if (blockBytes !== FQR2_BLOCK_BYTES || blockCount !== expectedBlockCount(fileSize)) throw new Error('FQR2 manifest geometry mismatch');
  if (!CRC32_RE.test(parts[7])) throw new Error('Malformed FQR2 metadata CRC32');
  const metadataBytes = fromBase64Url(parts[8], FQR2_MAX_METADATA_BYTES, 'metadata');
  if (crcHex(metadataBytes) !== parts[7]) throw new Error('FQR2 metadata CRC mismatch');
  let metadata;
  try { metadata = JSON.parse(decoder.decode(metadataBytes)); }
  catch { throw new Error('Malformed FQR2 metadata'); }
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) throw new Error('Malformed FQR2 metadata');
  const keys = Object.keys(metadata).sort();
  if (keys.length !== 2 || keys[0] !== 'name' || keys[1] !== 'type' || typeof metadata.name !== 'string' || typeof metadata.type !== 'string') {
    throw new Error('Malformed FQR2 metadata');
  }
  const manifest = { version: FQR2_VERSION, streamId, fileSize, blockBytes, symbolBytes, blockCount, name: metadata.name, type: metadata.type };
  expectedBlockGeometry(manifest, blockCount - 1);
  return manifest;
}

export function encodeFqr2Part(input) {
  const streamId = requireStreamId(input?.streamId);
  const blockIndex = input?.blockIndex;
  if (!Number.isInteger(blockIndex) || blockIndex < 0 || blockIndex >= FQR2_MAX_BLOCKS) throw new Error('FQR2 block index exceeds limit');
  const seqNum = input?.seqNum;
  if (!Number.isInteger(seqNum) || seqNum < 1 || seqNum > FQR2_MAX_SEQ_NUM) throw new Error('FQR2 sequence number exceeds limit');
  const seqLen = input?.seqLen;
  if (!Number.isInteger(seqLen) || seqLen < 1 || seqLen > FQR2_MAX_SOURCE_SYMBOLS) throw new Error('FQR2 source symbol count exceeds limit');
  const blockLength = input?.blockLength;
  if (!Number.isInteger(blockLength) || blockLength < 0 || blockLength > FQR2_BLOCK_BYTES) throw new Error('FQR2 block length exceeds limit');
  const blockSha256 = requireSha256(input?.blockSha256);
  const payload = input?.payload instanceof Uint8Array ? input.payload : new Uint8Array(input?.payload ?? 0);
  if (payload.byteLength < FQR2_MIN_SYMBOL_BYTES || payload.byteLength > FQR2_MAX_SYMBOL_BYTES) throw new Error('FQR2 payload symbol size exceeds limit');
  return [FQR2_VERSION, 'P', streamId, String(blockIndex), String(seqNum), String(seqLen), String(blockLength), blockSha256, crcHex(payload), toBase64Url(payload)].join('|');
}

export function decodeFqr2Part(frame, manifest = null) {
  const parts = requireFrameText(frame).split('|');
  if (parts.length !== 10 || parts[0] !== FQR2_VERSION || parts[1] !== 'P') throw new Error('Unsupported FQR2 part');
  const streamId = requireStreamId(parts[2]);
  const blockIndex = parseUint(parts[3], 'block index', FQR2_MAX_BLOCKS - 1);
  const seqNum = parseUint(parts[4], 'sequence number', FQR2_MAX_SEQ_NUM, { min: 1 });
  const seqLen = parseUint(parts[5], 'source symbol count', FQR2_MAX_SOURCE_SYMBOLS, { min: 1 });
  const blockLength = parseUint(parts[6], 'block length', FQR2_BLOCK_BYTES);
  const blockSha256 = requireSha256(parts[7]);
  if (!CRC32_RE.test(parts[8])) throw new Error('Malformed FQR2 part CRC32');
  const payload = fromBase64Url(parts[9], FQR2_MAX_SYMBOL_BYTES, 'part payload');
  if (payload.byteLength < FQR2_MIN_SYMBOL_BYTES) throw new Error('FQR2 payload symbol size exceeds limit');
  if (crcHex(payload) !== parts[8]) throw new Error('FQR2 part CRC mismatch');
  if (manifest) {
    if (manifest.streamId !== streamId) throw new Error('FQR2 stream mismatch');
    const geometry = expectedBlockGeometry(manifest, blockIndex);
    if (seqLen !== geometry.k || blockLength !== geometry.blockLength) throw new Error('FQR2 part geometry mismatch');
    if (payload.byteLength !== manifest.symbolBytes) throw new Error('FQR2 payload symbol size mismatch');
  }
  return { version: FQR2_VERSION, streamId, blockIndex, seqNum, seqLen, blockLength, blockSha256, payload };
}

export async function sha256Hex(bytes) {
  const input = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', input));
  return [...digest].map(byte => byte.toString(16).padStart(2, '0')).join('');
}
