const CAPABILITY_BYTES = 32;
const CAPABILITY_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const HASH_PATTERN = /^[0-9a-f]{64}$/;
const MAX_RELAY_ATTEMPTS_PER_LEASE = 4;

function toBase64Url(bytes) {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
}

function toHex(bytes) {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

export async function hashRelayCapability(capability) {
  if (typeof capability !== 'string' || !CAPABILITY_PATTERN.test(capability)) {
    throw new Error('Invalid relay capability');
  }
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(capability));
  return toHex(new Uint8Array(digest));
}

export async function issueRelayCapability(fillRandom = (bytes) => crypto.getRandomValues(bytes)) {
  const raw = new Uint8Array(CAPABILITY_BYTES);
  fillRandom(raw);
  const capability = toBase64Url(raw);
  return { capability, capabilityHash: await hashRelayCapability(capability) };
}

export function createRelayCapabilityState(attemptId, senderHash, receiverHash) {
  if (!Number.isSafeInteger(attemptId) || attemptId <= 0) throw new Error('Invalid relay attempt id');
  if (!HASH_PATTERN.test(senderHash) || !HASH_PATTERN.test(receiverHash)) throw new Error('Invalid relay capability hash');
  return { attemptId, senderHash, receiverHash };
}

function deny(status, error) {
  return { ok: false, status, error };
}

export function validateRelayAdmission(session, { role, attemptId, capabilityHash, now = Date.now() } = {}) {
  if (!session || !Number.isFinite(session.expiresAt) || now >= session.expiresAt) return deny(410, 'session-expired');
  if (role !== 'sender' && role !== 'receiver') return deny(400, 'invalid-relay-role');
  if (!Number.isSafeInteger(attemptId) || attemptId <= 0 || attemptId !== session.activeAttemptId) {
    return deny(409, 'stale-relay-attempt');
  }

  const state = session.relayCapabilities;
  if (!state || state.attemptId !== attemptId) return deny(409, 'relay-capability-unavailable');
  const expected = role === 'sender' ? state.senderHash : state.receiverHash;
  if (!HASH_PATTERN.test(String(capabilityHash || '')) || capabilityHash !== expected) {
    return deny(403, 'invalid-relay-capability');
  }

  const count = Number.isSafeInteger(session.relayAttemptCount) && session.relayAttemptCount >= 0
    ? session.relayAttemptCount
    : 0;
  if (count >= MAX_RELAY_ATTEMPTS_PER_LEASE && session.relayStartedAttemptId !== attemptId) {
    return deny(429, 'relay-attempt-limit');
  }
  return { ok: true, status: 200, error: null };
}

export { MAX_RELAY_ATTEMPTS_PER_LEASE };
