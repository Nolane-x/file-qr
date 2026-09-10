import { compactReceiveCode, isReceiveCode, SESSION_TTL_MS } from '../../../packages/core/session.js';

const RATE_LIMIT_RETRY_AFTER_SECONDS = 60;
const JSON_HEADERS = {
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'no-store',
  'access-control-allow-origin': '*',
  'access-control-allow-headers': 'content-type',
  'access-control-allow-methods': 'GET,POST,OPTIONS',
};

function defaultJson(body, init = {}) {
  return new Response(JSON.stringify(body), {
    ...init,
    headers: { ...JSON_HEADERS, ...(init.headers || {}) },
  });
}

async function hashedRateLimitKey(scope, value) {
  const encoded = new TextEncoder().encode(`${scope}:${String(value || 'unknown')}`);
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', encoded));
  return [...digest].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function enforceRateLimit(binding, key, jsonImpl) {
  if (!binding || typeof binding.limit !== 'function') {
    return jsonImpl({ error: 'rate-limit-unavailable' }, { status: 503 });
  }
  try {
    const result = await binding.limit({ key });
    if (result?.success === true) return null;
    if (result?.success === false) {
      return jsonImpl(
        { error: 'rate-limited' },
        { status: 429, headers: { 'retry-after': String(RATE_LIMIT_RETRY_AFTER_SECONDS) } },
      );
    }
  } catch {
    return jsonImpl({ error: 'rate-limit-unavailable' }, { status: 503 });
  }
  return jsonImpl({ error: 'rate-limit-unavailable' }, { status: 503 });
}

function defaultTurnConfigured(env) {
  return typeof env.TURN_KEY_ID === 'string' && env.TURN_KEY_ID.length > 0
    && typeof env.TURN_KEY_API_TOKEN === 'string' && env.TURN_KEY_API_TOKEN.length > 0;
}

function defaultRoomStub(env, code) {
  return env.SESSIONS.get(env.SESSIONS.idFromName(compactReceiveCode(code)));
}

export async function handleSessionAllocation(request, env, dependencies = {}) {
  const jsonImpl = dependencies.jsonImpl || defaultJson;
  const actor = dependencies.actor ?? request.headers.get('cf-connecting-ip') ?? 'unknown';
  const rateLimitBinding = dependencies.rateLimitBinding ?? env.SESSION_ALLOCATION_RATE_LIMIT;
  const sessionRateKey = await hashedRateLimitKey('session', actor);
  const rateLimited = await enforceRateLimit(rateLimitBinding, sessionRateKey, jsonImpl);
  if (rateLimited) return rateLimited;

  const createReceiveCodeImpl = dependencies.createReceiveCodeImpl;
  const randomTokenImpl = dependencies.randomTokenImpl;
  const initRoomImpl = dependencies.initRoomImpl;
  const nowImpl = dependencies.nowImpl || Date.now;

  // These dependencies are always supplied by the Worker entrypoint. Missing
  // admission dependencies fail closed rather than allocating partial state.
  if (
    typeof createReceiveCodeImpl !== 'function'
    || typeof randomTokenImpl !== 'function'
    || typeof initRoomImpl !== 'function'
  ) {
    return jsonImpl({ error: 'session-allocation-failed' }, { status: 503 });
  }

  for (let attempt = 0; attempt < 5; attempt += 1) {
    const code = createReceiveCodeImpl();
    const senderToken = randomTokenImpl();
    const createdAt = nowImpl();
    const expiresAt = createdAt + Number(env.SESSION_TTL_MS || SESSION_TTL_MS);
    const response = await initRoomImpl(code, { code, senderToken, createdAt, expiresAt });
    if (response.status === 201) {
      return jsonImpl({ code, senderToken, expiresAt }, { status: 201 });
    }
  }
  return jsonImpl({ error: 'session-allocation-failed' }, { status: 503 });
}

export async function handleTurnCredentials(request, env, dependencies = {}) {
  const jsonImpl = dependencies.jsonImpl || defaultJson;
  const turnConfiguredImpl = dependencies.turnConfiguredImpl || (() => defaultTurnConfigured(env));
  if (!turnConfiguredImpl()) return jsonImpl({ error: 'turn-not-configured' }, { status: 404 });

  let body;
  try {
    body = await request.json();
  } catch {
    return jsonImpl({ error: 'invalid-request' }, { status: 400 });
  }
  const code = body?.code;
  if (!isReceiveCode(code)) return jsonImpl({ error: 'session-not-found' }, { status: 404 });

  const authorizeTurnImpl = dependencies.authorizeTurnImpl
    || ((receiveCode) => defaultRoomStub(env, receiveCode).fetch('https://room.internal/turn-authorize', { method: 'POST' }));
  const authorization = await authorizeTurnImpl(code);
  if (!authorization.ok) {
    return jsonImpl({ error: 'session-expired' }, { status: authorization.status === 410 ? 410 : 404 });
  }

  const compactCodeImpl = dependencies.compactCodeImpl || compactReceiveCode;
  const rateLimitBinding = dependencies.rateLimitBinding ?? env.TURN_CREDENTIAL_RATE_LIMIT;
  const turnRateKey = await hashedRateLimitKey('turn', compactCodeImpl(code));
  const rateLimited = await enforceRateLimit(rateLimitBinding, turnRateKey, jsonImpl);
  if (rateLimited) return rateLimited;

  const generateTurnCredentialsImpl = dependencies.generateTurnCredentialsImpl;
  if (typeof generateTurnCredentialsImpl !== 'function') {
    return jsonImpl({ error: 'turn-provider-unavailable' }, { status: 502 });
  }
  const credentials = await generateTurnCredentialsImpl();
  if (!credentials) return jsonImpl({ error: 'turn-provider-unavailable' }, { status: 502 });
  return jsonImpl(credentials);
}
