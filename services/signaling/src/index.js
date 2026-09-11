import { DurableObject } from 'cloudflare:workers';
import { compactReceiveCode, createReceiveCode, isReceiveCode, SESSION_TTL_MS } from '../../../packages/core/session.js';
import { clampTurnCredentialTtlSeconds, handleSessionAllocation, handleTurnCredentials } from './resource-routes.js';
import { parseClientSignalingMessage } from './signaling-message.js';

const JSON_HEADERS = {
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'no-store',
  'access-control-allow-origin': '*',
  'access-control-allow-headers': 'content-type',
  'access-control-allow-methods': 'GET,POST,OPTIONS',
};

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

async function generateTurnCredentials(env, { leaseExpiresAt } = {}) {
  const now = Date.now();
  const ttl = clampTurnCredentialTtlSeconds(env.TURN_CREDENTIAL_TTL_SECONDS || 3600, leaseExpiresAt, now);
  if (ttl <= 0) return null;
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
  return { iceServers: body.iceServers, expiresAt: now + ttl * 1000 };
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: JSON_HEADERS });

    if (url.pathname === '/health') {
      return json({ ok: true, service: 'file-qr-signaling', ttlMs: Number(env.SESSION_TTL_MS || SESSION_TTL_MS) });
    }

    if (url.pathname === '/v1/turn-credentials' && request.method === 'POST') {
      return handleTurnCredentials(request, env, {
        jsonImpl: json,
        turnConfiguredImpl: () => turnConfigured(env),
        authorizeTurnImpl: (code) => roomStub(env, code).fetch('https://room.internal/turn-authorize', { method: 'POST' }),
        // SHA-256 in the route module keeps the live capability opaque inside the limiter key.
        compactCodeImpl: (code) => compactReceiveCode(code),
        rateLimitBinding: env.TURN_CREDENTIAL_RATE_LIMIT,
        generateTurnCredentialsImpl: (options) => generateTurnCredentials(env, options),
      });
    }

    if (url.pathname === '/v1/sessions' && request.method === 'POST') {
      const actor = request.headers.get('cf-connecting-ip') || 'unknown';
      // SHA-256 in the route module avoids using the raw network identifier as the limiter key.
      return handleSessionAllocation(request, env, {
        jsonImpl: json,
        actor,
        rateLimitBinding: env.SESSION_ALLOCATION_RATE_LIMIT,
        createReceiveCodeImpl: () => createReceiveCode(),
        randomTokenImpl: () => randomToken(),
        initRoomImpl: (code, session) => roomStub(env, code).fetch('https://room.internal/init', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(session),
        }),
      });
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
    const payload = parseClientSignalingMessage(message);
    if (!payload) return;

    const attachment = ws.deserializeAttachment?.() || {};
    const role = attachment.role;
    if (role !== 'sender' && role !== 'receiver') return;

    let session = await this.ctx.storage.get('session');
    if (!session) return;

    if (payload.type === 'attempt-ready' && role === 'receiver') {
      if (payload.attemptId !== session.activeAttemptId || attachment.attemptId !== session.activeAttemptId) return;
      session = { ...session, readyAttemptId: session.activeAttemptId };
      await this.ctx.storage.put('session', session);
      if (this.ctx.getWebSockets('sender').length) {
        this.#broadcast({ type: 'peer-ready', attemptId: session.activeAttemptId });
      }
      return;
    }

    if (payload.attemptId !== session.activeAttemptId) return;
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
