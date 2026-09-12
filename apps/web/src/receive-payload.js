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

function fragmentParams(url) {
  return new URLSearchParams(url.hash.startsWith('#') ? url.hash.slice(1) : '');
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
  const fragment = new URLSearchParams();
  fragment.set('receive', normalizedCode);
  fragment.set('relay', relaySecret);
  url.hash = fragment.toString();
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
    if (url.searchParams.has('relay')) return null;

    const fragment = fragmentParams(url);
    const fragmentHasReceive = fragment.has('receive');
    const fragmentHasRelay = fragment.has('relay');
    if (fragmentHasReceive || fragmentHasRelay) {
      if (!fragmentHasReceive) return null;
      const code = normalizeIfValid(fragment.get('receive'));
      if (!code) return null;
      if (!fragmentHasRelay) return { code, relaySecret: null };
      const relaySecret = fragment.get('relay');
      if (!validRelaySecret(relaySecret)) return null;
      return { code, relaySecret };
    }

    const receive = url.searchParams.get('receive');
    const code = receive ? normalizeIfValid(receive) : null;
    return code ? { code, relaySecret: null } : null;
  } catch {
    return null;
  }
}

export function parseReceivePayload(input) {
  return parseReceivePayloadDetails(input)?.code || null;
}
