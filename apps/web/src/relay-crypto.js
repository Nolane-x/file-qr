import { compactReceiveCode } from '../../../packages/core/session.js';
import {
  RELAY_MAX_PLAINTEXT_BYTES,
  encodeRelayFrame,
  encodeRelayFrameHeader,
  parseRelayFrame,
} from '../../../packages/core/relay-frame.js';

const SECRET_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const DIRECTIONS = new Set(['sender-to-receiver', 'receiver-to-sender']);
const encoder = new TextEncoder();
const HKDF_SALT = encoder.encode('file-qr-worker-relay-hkdf-salt-v1');

function bytes(value, label) {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  throw new TypeError(`${label} must be binary data`);
}

function decodeSecret(value) {
  if (typeof value !== 'string' || !SECRET_PATTERN.test(value)) throw new Error('Invalid relay secret');
  const binary = atob(value.replaceAll('-', '+').replaceAll('_', '/') + '=');
  if (binary.length !== 32) throw new Error('Invalid relay secret length');
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

function validateDirection(direction) {
  if (!DIRECTIONS.has(direction)) throw new Error('Invalid relay traffic direction');
}

function validateAttempt(attemptId) {
  if (!Number.isSafeInteger(attemptId) || attemptId <= 0 || attemptId > 0xffff_ffff) {
    throw new Error('Invalid relay attempt id');
  }
}

function validatePrefix(prefix) {
  const normalized = bytes(prefix, 'Relay nonce prefix');
  if (normalized.byteLength !== 8) throw new Error('Relay nonce prefix must be exactly 8 bytes');
  return normalized.slice();
}

function makeNonce(prefix, sequence) {
  const nonce = new Uint8Array(12);
  nonce.set(prefix, 0);
  new DataView(nonce.buffer).setUint32(8, sequence, false);
  return nonce;
}

function concat(left, right) {
  const output = new Uint8Array(left.byteLength + right.byteLength);
  output.set(left, 0);
  output.set(right, left.byteLength);
  return output;
}

function aadFor(header, code, direction) {
  return concat(header, encoder.encode(`|${compactReceiveCode(code)}|${direction}`));
}

export async function deriveRelayTrafficKey({ relaySecret, code, attemptId, direction }) {
  validateAttempt(attemptId);
  validateDirection(direction);
  const compactCode = compactReceiveCode(code);
  const baseKey = await crypto.subtle.importKey('raw', decodeSecret(relaySecret), 'HKDF', false, ['deriveKey']);
  const info = encoder.encode(`file-qr-worker-relay/v1|${compactCode}|${attemptId}|${direction}`);
  return crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: HKDF_SALT, info },
    baseKey,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

export async function createRelayCryptoContext({
  relaySecret,
  code,
  attemptId,
  direction,
  noncePrefix = null,
  initialSequence = 0,
}) {
  validateAttempt(attemptId);
  validateDirection(direction);
  if (!Number.isSafeInteger(initialSequence) || initialSequence < 0 || initialSequence > 0xffff_ffff) {
    throw new Error('Invalid relay sequence');
  }
  const prefix = noncePrefix === null
    ? (() => {
        const out = new Uint8Array(8);
        crypto.getRandomValues(out);
        return out;
      })()
    : validatePrefix(noncePrefix);
  const key = await deriveRelayTrafficKey({ relaySecret, code, attemptId, direction });
  let sendSequence = initialSequence;
  let receiveSequence = initialSequence;

  return {
    noncePrefix: prefix.slice(),
    get nextSequence() { return sendSequence; },
    get expectedSequence() { return receiveSequence; },
    async encrypt(kind, input) {
      if (sendSequence >= 0xffff_ffff) throw new Error('Relay sequence exhausted before nonce wrap');
      const plaintext = bytes(input, 'Relay plaintext');
      if (plaintext.byteLength > RELAY_MAX_PLAINTEXT_BYTES) throw new Error('Relay plaintext size exceeds limit');
      const sequence = sendSequence;
      const header = encodeRelayFrameHeader({ attemptId, sequence, kind, plaintextLength: plaintext.byteLength });
      const ciphertext = new Uint8Array(await crypto.subtle.encrypt(
        {
          name: 'AES-GCM',
          iv: makeNonce(prefix, sequence),
          additionalData: aadFor(header, code, direction),
          tagLength: 128,
        },
        key,
        plaintext,
      ));
      const frame = encodeRelayFrame({
        attemptId,
        sequence,
        kind,
        plaintextLength: plaintext.byteLength,
        ciphertext,
      });
      sendSequence += 1;
      return frame;
    },
    async decrypt(frame) {
      const parsed = parseRelayFrame(frame, attemptId);
      if (parsed.sequence !== receiveSequence) {
        throw new Error(`Relay sequence mismatch: expected ${receiveSequence}, received ${parsed.sequence}`);
      }
      let plaintext;
      try {
        plaintext = new Uint8Array(await crypto.subtle.decrypt(
          {
            name: 'AES-GCM',
            iv: makeNonce(prefix, parsed.sequence),
            additionalData: aadFor(parsed.header, code, direction),
            tagLength: 128,
          },
          key,
          parsed.ciphertext,
        ));
      } catch (error) {
        throw new Error('Relay decryption or authentication failed', { cause: error });
      }
      if (plaintext.byteLength !== parsed.plaintextLength) throw new Error('Relay decrypted length mismatch');
      receiveSequence += 1;
      return { kind: parsed.kind, sequence: parsed.sequence, plaintext };
    },
  };
}
