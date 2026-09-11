import { isReceiveCode, normalizeReceiveCode } from '../../../packages/core/session.js';

const RELAY_SECRET_BYTES = 32;
const RELAY_SECRET_PATTERN = /^[A-Za-z0-9_-]{43}$/;

function normalizeIfValid(value) {
  return isReceiveCode(value) ? normalizeReceiveCode(value) : null;
}

function bytesToBase64Url(bytes) {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
}

function validRelaySecret(value) {
  if (typeof value !== 'string' || !RELAY_SECRET_PATTERN.test(value)) return false;
  try {
    const base64 = value.replaceAll('-', '+').replaceAll('_', '/') + '=';
    const binary = atob(base64);
    if (binary.length !== RELAY_SECRET_BYTES) return false;
    const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
    return bytesToBase64Url(bytes) === value;
  } catch {
    return false;
  }
}

export function generateRelaySecret(fillRandom = (bytes) => crypto.getRandomValues(bytes)) {
  const bytes = new Uint8Array(RELAY_SECRET_BYTES);
  fillRandom(bytes);
  return bytesToBase64Url(bytes);
}

export function buildReceivePayloadUrl(baseUrl, code, relaySecret) {
  const normalizedCode = normalizeIfValid(code);
  if (!normalizedCode) throw new Error('Invalid receive code');
  if (!validRelaySecret(relaySecret)) throw new Error('Invalid relay secret');
  const url = new URL(baseUrl);
  url.search = '';
  url.hash = '';
  url.searchParams.set('receive', normalizedCode);
  url.searchParams.set('relay', relaySecret);
  return url.toString();
}

export function parseReceivePayloadDetails(input) {
  const raw = String(input ?? '').trim();
  if (!raw) return null;

  if (/^[0-9A-Za-z\s-]+$/.test(raw)) {
    const compact = raw.replace(/[^0-9A-Za-z]/g, '');
    if (compact.length === 10) {
      const code = normalizeIfValid(raw);
      return code ? { code, relaySecret: null } : null;
    }
  }

  try {
    const url = new URL(raw);
    const receive = url.searchParams.get('receive');
    const code = receive ? normalizeIfValid(receive) : null;
    if (!code) return null;
    if (!url.searchParams.has('relay')) return { code, relaySecret: null };
    const relaySecret = url.searchParams.get('relay');
    if (!validRelaySecret(relaySecret)) return null;
    return { code, relaySecret };
  } catch {
    return null;
  }
}

export function parseReceivePayload(input) {
  return parseReceivePayloadDetails(input)?.code || null;
}
