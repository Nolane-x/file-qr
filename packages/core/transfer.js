export const FILE_QR_PROTOCOL_VERSION = 1;
export const DEFAULT_CHUNK_SIZE = 64 * 1024;

export function* chunkRanges(totalBytes, chunkSize = DEFAULT_CHUNK_SIZE) {
  if (!Number.isSafeInteger(totalBytes) || totalBytes < 0) throw new Error('Invalid byte length');
  if (!Number.isSafeInteger(chunkSize) || chunkSize <= 0) throw new Error('Invalid chunk size');
  for (let start = 0; start < totalBytes; start += chunkSize) {
    yield [start, Math.min(start + chunkSize, totalBytes)];
  }
}

export function encodeControlMessage(type, payload = {}) {
  if (!type || typeof type !== 'string') throw new Error('Control message type is required');
  return JSON.stringify({ v: FILE_QR_PROTOCOL_VERSION, type, payload });
}

export function decodeControlMessage(raw) {
  const message = typeof raw === 'string' ? JSON.parse(raw) : raw;
  if (!message || message.v !== FILE_QR_PROTOCOL_VERSION || typeof message.type !== 'string') {
    throw new Error('Unsupported File QR control message');
  }
  return { v: message.v, type: message.type, payload: message.payload ?? {} };
}
