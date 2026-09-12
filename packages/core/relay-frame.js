export const RELAY_PROTOCOL_VERSION = 1;
export const RELAY_MAX_PLAINTEXT_BYTES = 64 * 1024;
export const RELAY_MAX_FRAME_BYTES = 70 * 1024;
export const RELAY_FRAME_HEADER_BYTES = 14;
export const RELAY_GCM_TAG_BYTES = 16;

const KIND_TO_ID = Object.freeze({ data: 1, control: 2, ack: 3, abort: 4 });
const ID_TO_KIND = Object.freeze(Object.fromEntries(Object.entries(KIND_TO_ID).map(([name, id]) => [id, name])));

function asBytes(value, label) {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  throw new TypeError(`${label} must be binary data`);
}

function assertUint32(value, label, { positive = false } = {}) {
  if (!Number.isSafeInteger(value) || value < (positive ? 1 : 0) || value > 0xffff_ffff) {
    throw new RangeError(`Invalid relay ${label}`);
  }
}

function kindId(kind) {
  const id = KIND_TO_ID[kind];
  if (!id) throw new Error('Invalid relay frame kind');
  return id;
}

function assertPlaintextLength(value) {
  if (!Number.isSafeInteger(value) || value < 0 || value > RELAY_MAX_PLAINTEXT_BYTES) {
    throw new RangeError('Relay plaintext size exceeds limit');
  }
}

export function encodeRelayFrameHeader({ attemptId, sequence, kind, plaintextLength }) {
  assertUint32(attemptId, 'attempt', { positive: true });
  assertUint32(sequence, 'sequence');
  assertPlaintextLength(plaintextLength);
  const header = new Uint8Array(RELAY_FRAME_HEADER_BYTES);
  const view = new DataView(header.buffer);
  header[0] = RELAY_PROTOCOL_VERSION;
  header[1] = kindId(kind);
  view.setUint32(2, attemptId, false);
  view.setUint32(6, sequence, false);
  view.setUint32(10, plaintextLength, false);
  return header;
}

export function encodeRelayFrame({ attemptId, sequence, kind, plaintextLength, ciphertext }) {
  const body = asBytes(ciphertext, 'Relay ciphertext');
  const header = encodeRelayFrameHeader({ attemptId, sequence, kind, plaintextLength });
  if (body.byteLength !== plaintextLength + RELAY_GCM_TAG_BYTES) {
    throw new Error('Relay ciphertext length does not match declared plaintext length');
  }
  const total = header.byteLength + body.byteLength;
  if (total > RELAY_MAX_FRAME_BYTES) throw new RangeError('Relay frame size exceeds limit');
  const frame = new Uint8Array(total);
  frame.set(header, 0);
  frame.set(body, header.byteLength);
  return frame;
}

export function parseRelayFrame(input, expectedAttemptId = null) {
  const frame = asBytes(input, 'Relay frame');
  if (frame.byteLength > RELAY_MAX_FRAME_BYTES) throw new RangeError('Relay frame size exceeds limit');
  if (frame.byteLength < RELAY_FRAME_HEADER_BYTES + RELAY_GCM_TAG_BYTES) {
    throw new Error('Relay frame ciphertext length is invalid');
  }
  const header = frame.slice(0, RELAY_FRAME_HEADER_BYTES);
  if (header[0] !== RELAY_PROTOCOL_VERSION) throw new Error('Unsupported relay protocol version');
  const kind = ID_TO_KIND[header[1]];
  if (!kind) throw new Error('Invalid relay frame kind');
  const view = new DataView(header.buffer, header.byteOffset, header.byteLength);
  const attemptId = view.getUint32(2, false);
  const sequence = view.getUint32(6, false);
  const plaintextLength = view.getUint32(10, false);
  assertUint32(attemptId, 'attempt', { positive: true });
  assertPlaintextLength(plaintextLength);
  if (expectedAttemptId !== null && attemptId !== expectedAttemptId) throw new Error('Relay frame attempt mismatch');
  const ciphertext = frame.slice(RELAY_FRAME_HEADER_BYTES);
  if (ciphertext.byteLength !== plaintextLength + RELAY_GCM_TAG_BYTES) {
    throw new Error('Relay ciphertext length does not match declared plaintext length');
  }
  return { version: RELAY_PROTOCOL_VERSION, attemptId, sequence, kind, plaintextLength, header, ciphertext };
}
