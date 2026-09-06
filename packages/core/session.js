export const SESSION_TTL_MS = 600_000;
export const RECEIVE_CODE_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

function randomBytes(length) {
  const bytes = new Uint8Array(length);
  if (!globalThis.crypto?.getRandomValues) throw new Error('Secure randomness is unavailable');
  globalThis.crypto.getRandomValues(bytes);
  return bytes;
}

export function createReceiveCode(source = randomBytes(7)) {
  const bytes = source instanceof Uint8Array ? source : new Uint8Array(source);
  if (bytes.length < 7) throw new Error('At least 7 random bytes are required');
  let buffer = 0;
  let bits = 0;
  let out = '';
  for (const byte of bytes) {
    buffer = (buffer << 8) | byte;
    bits += 8;
    while (bits >= 5 && out.length < 10) {
      bits -= 5;
      out += RECEIVE_CODE_ALPHABET[(buffer >>> bits) & 31];
      buffer &= (1 << Math.min(bits, 30)) - 1;
    }
    if (out.length === 10) break;
  }
  if (out.length < 10) throw new Error('Insufficient entropy for receive code');
  return `${out.slice(0, 5)}-${out.slice(5)}`;
}

export function normalizeReceiveCode(input) {
  const cleaned = String(input ?? '')
    .toUpperCase()
    .replace(/O/g, '0')
    .replace(/[IL]/g, '1')
    .replace(/[^0-9A-Z]/g, '');
  return cleaned.length > 5 ? `${cleaned.slice(0, 5)}-${cleaned.slice(5, 10)}` : cleaned;
}

export function isReceiveCode(input) {
  const normalized = normalizeReceiveCode(input);
  return /^[0-9A-HJKMNP-TV-Z]{5}-[0-9A-HJKMNP-TV-Z]{5}$/.test(normalized);
}

export function compactReceiveCode(input) {
  const normalized = normalizeReceiveCode(input);
  if (!isReceiveCode(normalized)) throw new Error('Invalid receive code');
  return normalized.replace('-', '');
}
