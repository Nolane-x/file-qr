import { DurableObject } from 'cloudflare:workers';
import { compactReceiveCode, createReceiveCode, isReceiveCode, SESSION_TTL_MS } from '../../../packages/core/session.js';

const JSON_HEADERS = {
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'no-store',
  'access-control-allow-origin': '*',
  'access-control-allow-headers': 'content-type',
  'access-control-allow-methods': 'GET,POST,OPTIONS',
};
const RATE_LIMIT_RETRY_AFTER_SECONDS = 60;

function json(body, init = {}) {
  return new Response(JSON.stringify(body), {
    ...init,
    headers: { ...JSON_HEADERS, ...(init.headers || {}) },
  });
}

function randomToken(bytes = 24) {
  const raw = new Uint8Array(bytes);
  crypto.getRandomValues(raw);
  let binary = '';
  for (const byte of raw) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
}

function roomStub(env, code) {
  return env.SESSIONS.get(env.SESSIONS.idFromName(compactReceiveCode(code)));
}

function turnConfigured(env) {
  return typeof env.TURN_KEY_ID === 'string' && env.TURN_KEY_ID.length > 0
    && typeof env.TURN_KEY_API_TOKEN === 'string' && env.TURN_KEY_API_TOKEN.length > 0;
}

function turnCredentialTtlSeconds(env) {
  const configured = Number(env.TURN_CREDENTIAL_TTL_SECONDS || 3600);
  if (!Number.isFinite(configured)) return 3600;
  return Math.min(172800, Math.max(300, Math.floor(configured)));
}

async function hashedRateLimitKey(scope, value) {
  const encoded = new TextEncoder().encode(`${scope}:${String(value || 'unknown')}`);
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', encoded));
  return [...digest].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function enforceRateLimit(binding, key) {
  if (!binding || typeof binding.limit !== 'function') {
    return json({ error: 'rate-limit-unavailable' }, { status: 503 });
  }
  try {
    const result = await binding.limit({ key });
    if (result?.success === true) return null;
    if (result?.success === false) {
      return json(
        { error: 'rate-limited' },
        { status: 429, headers: { 'retry-after': String(RATE_LIMIT_RETRY_AFTER_SECONDS) } },
      );
    }
  } catch {
    return json({ error: 'rate-limit-unavailable' }, { status: 503 });
  }
  return json({ error: 'rate-limit-unavailable' }, { status: 503 });
}

async function generateTurnCredentials(env) {
  const ttl = turnCredentialTtlSeconds(env);
  const response = await fetch(
    `https://rtc.live.cloudflare.com/v1/turn/keys/${encodeURIComponent(env.TURN_KEY_ID)}/credentials/generate-ice-servers`,
    {
      method: 'POST',
      headers: {
        authorization: `Bearer ${env.TURN_KEY_API_TOKEN}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ ttl }),
    },
  );
  if (!response.ok) return null;
  const body = await response.json();
  if (!Array.isArray(body?.iceServers) || body.iceServers.length === 0) return null;
  return { iceServers: body.iceServers, expiresAt: Date.now() + ttl * 1000 };
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: JSON_HEADERS });

    if (url.pathname === '/health') {
      return json({ ok: true, service: 'file-qr-signaling', ttlMs: Number(env.SESSION_TTL_MS || SESSION_TTL_MS) });
    }

    if (url.pathname === '/v1/turn-credentials' && request.method === 'POST') {
      if (!turnConfigured(env)) return json({ error: 'turn-not-configured' }, { status: 404 });
      let body;
      try {
        body = await request.json();
      } catch {
        return json({ error: 'invalid-request' }, { status: 400 });
      }
      const code = body?.code;
      if (!isReceiveCode(code)) return json({ error: 'session-not-found' }, { status: 404 });

      const authorization = await roomStub(env, code).fetch('https://room.internal/turn-authorize', { method: 'POST' });
      if (!authorization.ok) {
        return json({ error: 'session-expired' }, { status: authorization.status === 410 ? 410 : 404 });
      }

      // SHA-256 keeps the short-lived capability opaque inside the rate-limit counter key.
      const turnRateKey = await hashedRateLimitKey('turn', compactReceiveCode(code));
      const turnRateLimited = await enforceRateLimit(env.TURN_CREDENTIAL_RATE_LIMIT, turnRateKey);
      if (turnRateLimited) return turnRateLimited;

      const credentials = await generateTurnCredentials(env);
      if (!credentials) return json({ error: 'turn-provider-unavailable' }, { status: 502 });
      return json(credentials);
    }

    if (url.pathname === '/v1/sessions' && request.method === 'POST') {
      const actor = request.headers.get('cf-connecting-ip') || 'unknown';
      // SHA-256 avoids using the raw network identifier as the rate-limit counter key.
      const sessionRateKey = await hashedRateLimitKey('session', actor);
      const sessionRateLimited = await enforceRateLimit(env.SESSION_ALLOCATION_RATE_LIMIT, sessionRateKey);
      if (sessionRateLimited) return sessionRateLimited;

      for (let attempt = 0; attempt < 5; attempt += 1) {
        const code = createReceiveCode();
        const senderToken = randomToken();
        const createdAt = Date.now();
        const expiresAt = createdAt + Number(env.SESSION_TTL_MS || SESSION_TTL_MS);
        const response = await roomStub(env, code).fetch('https://room.internal/init', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ code, senderToken, createdAt, expiresAt }),
        });
        if (response.status === 201) {
          return json({ code, senderToken, expiresAt }, { status: 201 });
        }
      }
      return json({ error: 'session-allocation-failed' }, { status: 503 });
    }

    const match = url.pathname.match(/^\/v1\/sessions\/([^/]+)\/connect$/);
    if (match && request.method === 'GET') {
      let code;
      try {
        code = decodeURIComponent(match[1]);
      } catch {
        return json({ error: 'session-not-found' }, { status: 404 });
      }
      if (!isReceiveCode(code)) return json({ error: 'session-not-found' }, { status: 404 });
      return roomStub(env, code).fetch(request);
    }

    return json({ error: 'not-found' }, { status: 404 });
  },
};

export class SessionRoom extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.ctx = ctx;
  }

  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === '/init' && request.method === 'POST') return this.#init(request);
    if (url.pathname === '/turn-authorize' && request.method === 'POST') return this.#authorizeTurn();
    if (url.pathname.endsWith('/connect') && request.method === 'GET') return this.#connect(request);
    return json({ error: 'not-found' }, { status: 404 });
  }

  async #init(request) {
    const existing = await this.ctx.storage.get('session');
    if (existing) return json({ error: 'already-exists' }, { status: 409 });
    const session = await request.json();
    if (!session?.senderToken || !Number.isFinite(session?.expiresAt)) {
      return json({ error: 'invalid-session' }, { status: 400 });
    }
    await this.ctx.storage.put('session', {
      ...session,
      attemptCounter: 0,
      activeAttemptId: null,
      readyAttemptId: null,
    });
    await this.ctx.storage.setAlarm(session.expiresAt);
    return json({ ok: true }, { status: 201 });
  }

  async #authorizeTurn() {
    const session = await this.ctx.storage.get('session');
    if (!session || Date.now() >= session.expiresAt) return json({ error: 'session-expired' }, { status: 410 });
    return json({ ok: true, expiresAt: session.expiresAt });
  }

  async #connect(request) {
    if (request.headers.get('upgrade')?.toLowerCase() !== 'websocket') {
      return json({ error: 'websocket-required' }, { status: 426 });
    }

    let session = await this.ctx.storage.get('session');
    if (!session || Date.now() >= session.expiresAt) return json({ error: 'session-expired' }, { status: 410 });

    const url = new URL(request.url);
    const role = url.searchParams.get('role');
    if (role !== 'sender' && role !== 'receiver') return json({ error: 'invalid-role' }, { status: 400 });
    if (role === 'sender' && url.searchParams.get('token') !== session.senderToken) {
      return json({ error: 'forbidden' }, { status: 403 });
    }
    if (this.ctx.getWebSockets(role).length > 0) {
      return json({ error: `${role}-already-connected` }, { status: 409 });
    }

    let attemptId = null;
    if (role === 'receiver') {
      attemptId = Number(session.attemptCounter || 0) + 1;
      session = {
        ...session,
        attemptCounter: attemptId,
        activeAttemptId: attemptId,
        readyAttemptId: null,
      };
      await this.ctx.storage.put('session', session);
    }

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    this.ctx.acceptWebSocket(server, [role]);
    if (role === 'receiver') server.serializeAttachment({ role, attemptId });
    else server.serializeAttachment({ role });
    server.send(JSON.stringify({
      type: 'connected',
      role,
      expiresAt: session.expiresAt,
      ...(attemptId ? { attemptId } : {}),
    }));

    if (
      role === 'sender'
      && Number.isInteger(session.readyAttemptId)
      && session.readyAttemptId === session.activeAttemptId
    ) {
      server.send(JSON.stringify({ type: 'peer-ready', attemptId: session.activeAttemptId }));
    }

    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws, message) {
    if (typeof message !== 'string') return;
    let payload;
    try {
      payload = JSON.parse(message);
    } catch {
      return;
    }

    const attachment = ws.deserializeAttachment?.() || {};
    const role = attachment.role;
    if (role !== 'sender' && role !== 'receiver') return;

    let session = await this.ctx.storage.get('session');
    if (!session) return;

    if (payload?.type === 'attempt-ready' && role === 'receiver') {
      if (!Number.isInteger(payload.attemptId) || payload.attemptId !== session.activeAttemptId || attachment.attemptId !== session.activeAttemptId) return;
      session = { ...session, readyAttemptId: session.activeAttemptId };
      await this.ctx.storage.put('session', session);
      if (this.ctx.getWebSockets('sender').length) {
        this.#broadcast({ type: 'peer-ready', attemptId: session.activeAttemptId });
      }
      return;
    }

    if (!['description', 'candidate'].includes(payload?.type)) return;
    if (!Number.isInteger(payload.attemptId) || payload.attemptId !== session.activeAttemptId) return;
    if (role === 'receiver' && attachment.attemptId !== session.activeAttemptId) return;

    const target = role === 'sender' ? 'receiver' : 'sender';
    for (const peer of this.ctx.getWebSockets(target)) {
      try { peer.send(message); } catch { /* peer may have just closed */ }
    }
  }

  async webSocketClose(ws, code, reason) {
    const attachment = ws.deserializeAttachment?.() || {};
    const { role, attemptId } = attachment;
    if (role === 'receiver' && Number.isInteger(attemptId)) {
      const session = await this.ctx.storage.get('session');
      if (session?.activeAttemptId === attemptId) {
        await this.ctx.storage.put('session', {
          ...session,
          activeAttemptId: null,
          readyAttemptId: null,
        });
      }
    }
    try { ws.close(code, reason); } catch { /* already closed */ }
  }

  async alarm() {
    for (const ws of this.ctx.getWebSockets()) {
      try { ws.close(4000, 'Session expired'); } catch { /* already closed */ }
    }
    await this.ctx.storage.deleteAll();
  }

  #broadcast(payload) {
    const encoded = JSON.stringify(payload);
    for (const ws of this.ctx.getWebSockets()) {
      try { ws.send(encoded); } catch { /* peer may have just closed */ }
    }
  }
}
