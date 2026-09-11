import { DurableObject } from 'cloudflare:workers';
import { compactReceiveCode, createReceiveCode, isReceiveCode, SESSION_TTL_MS } from '../../../packages/core/session.js';
import { clampTurnCredentialTtlSeconds, handleSessionAllocation, handleTurnCredentials } from './resource-routes.js';
import { parseClientSignalingMessage } from './signaling-message.js';
import {
  createRelayCapabilityState,
  deriveSenderRelayCapability,
  hashRelayCapability,
  issueRelayCapability,
  validateRelayAdmission,
} from './relay-authority.js';
import {
  RELAY_IDLE_TIMEOUT_MS,
  RELAY_MAX_SESSION_DECLARED_BYTES,
  createRelayForwardState,
  isRelayForwardIdle,
  processRelayFrame,
} from './relay-forwarder.js';

const JSON_HEADERS = {
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'no-store',
  'access-control-allow-origin': '*',
  'access-control-allow-headers': 'content-type',
  'access-control-allow-methods': 'GET,POST,OPTIONS',
};
const RELAY_NONCE_PREFIX_PATTERN = /^[A-Za-z0-9_-]{11}$/;

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

function decodeSessionRoute(pathname) {
  const match = pathname.match(/^\/v1\/sessions\/([^/]+)\/(connect|relay)$/);
  if (!match) return null;
  try {
    const code = decodeURIComponent(match[1]);
    return isReceiveCode(code) ? { code, kind: match[2] } : null;
  } catch {
    return null;
  }
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
        compactCodeImpl: (code) => compactReceiveCode(code),
        rateLimitBinding: env.TURN_CREDENTIAL_RATE_LIMIT,
        generateTurnCredentialsImpl: (options) => generateTurnCredentials(env, options),
      });
    }

    if (url.pathname === '/v1/sessions' && request.method === 'POST') {
      const actor = request.headers.get('cf-connecting-ip') || 'unknown';
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

    if (request.method === 'GET') {
      const route = decodeSessionRoute(url.pathname);
      if (route) return roomStub(env, route.code).fetch(request);
      if (/^\/v1\/sessions\//.test(url.pathname)) return json({ error: 'session-not-found' }, { status: 404 });
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
    if (url.pathname.endsWith('/relay') && request.method === 'GET') return this.#relay(request);
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
      relayCapabilities: null,
      relayAttemptCount: 0,
      relayStartedAttemptId: null,
      relayDeclaredBytes: 0,
      relayDeclaredAttemptId: null,
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
    let receiverRelayCapability = null;
    if (role === 'receiver') {
      attemptId = Number(session.attemptCounter || 0) + 1;
      const receiverAuthority = await issueRelayCapability();
      const senderAuthority = await deriveSenderRelayCapability(session.senderToken, attemptId);
      receiverRelayCapability = receiverAuthority.capability;
      session = {
        ...session,
        attemptCounter: attemptId,
        activeAttemptId: attemptId,
        readyAttemptId: null,
        relayCapabilities: createRelayCapabilityState(
          attemptId,
          senderAuthority.capabilityHash,
          receiverAuthority.capabilityHash,
        ),
        relayStartedAttemptId: null,
        relayDeclaredAttemptId: null,
      };
      await this.ctx.storage.put('session', session);
    }

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    this.ctx.acceptWebSocket(server, [role]);
    if (role === 'receiver') server.serializeAttachment({ kind: 'signal', role, attemptId });
    else server.serializeAttachment({ kind: 'signal', role });
    server.send(JSON.stringify({
      type: 'connected',
      role,
      expiresAt: session.expiresAt,
      ...(attemptId ? { attemptId, relayCapability: receiverRelayCapability } : {}),
    }));

    if (
      role === 'sender'
      && Number.isInteger(session.readyAttemptId)
      && session.readyAttemptId === session.activeAttemptId
    ) {
      const relay = await deriveSenderRelayCapability(session.senderToken, session.activeAttemptId);
      server.send(JSON.stringify({
        type: 'peer-ready',
        attemptId: session.activeAttemptId,
        relayCapability: relay.capability,
      }));
    }

    return new Response(null, { status: 101, webSocket: client });
  }

  async #relay(request) {
    if (request.headers.get('upgrade')?.toLowerCase() !== 'websocket') {
      return json({ error: 'websocket-required' }, { status: 426 });
    }
    let session = await this.ctx.storage.get('session');
    const now = Date.now();
    if (!session || now >= session.expiresAt) return json({ error: 'session-expired' }, { status: 410 });

    const url = new URL(request.url);
    const role = url.searchParams.get('role');
    const attemptId = Number(url.searchParams.get('attemptId'));
    const capability = url.searchParams.get('cap') || '';
    const noncePrefix = url.searchParams.get('nonce') || '';
    if (!RELAY_NONCE_PREFIX_PATTERN.test(noncePrefix)) return json({ error: 'invalid-relay-nonce' }, { status: 400 });

    let capabilityHash;
    try { capabilityHash = await hashRelayCapability(capability); }
    catch { return json({ error: 'invalid-relay-capability' }, { status: 403 }); }
    const admission = validateRelayAdmission(session, { role, attemptId, capabilityHash, now });
    if (!admission.ok) return json({ error: admission.error }, { status: admission.status });

    let remainingBytes = 0;
    if (role === 'sender') {
      remainingBytes = Number(url.searchParams.get('remaining'));
      if (!Number.isSafeInteger(remainingBytes) || remainingBytes < 0 || remainingBytes > RELAY_MAX_SESSION_DECLARED_BYTES) {
        return json({ error: 'invalid-relay-remaining' }, { status: 400 });
      }
    }

    const tag = `relay-${role}`;
    for (const existing of this.ctx.getWebSockets(tag)) {
      const attachment = existing.deserializeAttachment?.() || {};
      if (attachment.attemptId === attemptId) return json({ error: `${role}-relay-already-connected` }, { status: 409 });
      try { existing.close(4002, 'Stale relay attempt'); } catch { /* already closed */ }
    }

    let changed = false;
    let nextSession = session;
    if (session.relayStartedAttemptId !== attemptId) {
      nextSession = {
        ...nextSession,
        relayAttemptCount: Number(nextSession.relayAttemptCount || 0) + 1,
        relayStartedAttemptId: attemptId,
      };
      changed = true;
    }
    if (role === 'sender' && session.relayDeclaredAttemptId !== attemptId) {
      const declared = Number(nextSession.relayDeclaredBytes || 0) + remainingBytes;
      if (declared > RELAY_MAX_SESSION_DECLARED_BYTES) {
        return json({ error: 'relay-session-byte-limit' }, { status: 429 });
      }
      nextSession = { ...nextSession, relayDeclaredBytes: declared, relayDeclaredAttemptId: attemptId };
      changed = true;
    }
    if (changed) {
      session = nextSession;
      await this.ctx.storage.put('session', session);
    }

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    const forwardState = createRelayForwardState({ attemptId, role, remainingBytes, now });
    this.ctx.acceptWebSocket(server, [tag]);
    server.serializeAttachment({ kind: 'relay', role, attemptId, noncePrefix, forwardState });

    const peer = this.#relayPeer(role, attemptId);
    if (peer) {
      const peerAttachment = peer.deserializeAttachment?.() || {};
      server.send(JSON.stringify({ type: 'relay-ready', peerNoncePrefix: peerAttachment.noncePrefix }));
      peer.send(JSON.stringify({ type: 'relay-ready', peerNoncePrefix: noncePrefix }));
    }
    await this.#scheduleRelayAlarm(session, now);
    return new Response(null, { status: 101, webSocket: client });
  }

  #relayPeer(role, attemptId) {
    const target = role === 'sender' ? 'receiver' : 'sender';
    return this.ctx.getWebSockets(`relay-${target}`).find((candidate) => {
      const attachment = candidate.deserializeAttachment?.() || {};
      return attachment.kind === 'relay' && attachment.attemptId === attemptId;
    }) || null;
  }

  async #scheduleRelayAlarm(session, now = Date.now()) {
    await this.ctx.storage.setAlarm(Math.min(session.expiresAt, now + RELAY_IDLE_TIMEOUT_MS));
  }

  async webSocketMessage(ws, message) {
    const attachment = ws.deserializeAttachment?.() || {};
    if (attachment.kind === 'relay') {
      this.#relayMessage(ws, message, attachment);
      return;
    }

    const payload = parseClientSignalingMessage(message);
    if (!payload) return;
    const role = attachment.role;
    if (role !== 'sender' && role !== 'receiver') return;

    let session = await this.ctx.storage.get('session');
    if (!session) return;

    if (payload.type === 'attempt-ready' && role === 'receiver') {
      if (payload.attemptId !== session.activeAttemptId || attachment.attemptId !== session.activeAttemptId) return;
      session = { ...session, readyAttemptId: session.activeAttemptId };
      await this.ctx.storage.put('session', session);
      const relay = await deriveSenderRelayCapability(session.senderToken, session.activeAttemptId);
      for (const sender of this.ctx.getWebSockets('sender')) {
        try {
          sender.send(JSON.stringify({
            type: 'peer-ready',
            attemptId: session.activeAttemptId,
            relayCapability: relay.capability,
          }));
        } catch { /* sender may have just closed */ }
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

  #relayMessage(ws, message, attachment) {
    if (!(message instanceof ArrayBuffer)) {
      const state = { ...attachment.forwardState, malformedCount: attachment.forwardState.malformedCount + 1 };
      ws.serializeAttachment({ ...attachment, forwardState: state });
      if (state.malformedCount >= 3) {
        try { ws.close(4003, 'Relay protocol violation'); } catch { /* already closed */ }
      }
      return;
    }
    const result = processRelayFrame(attachment.forwardState, new Uint8Array(message), Date.now());
    ws.serializeAttachment({ ...attachment, forwardState: result.state });
    if (!result.ok) {
      if (result.fatal) {
        const peer = this.#relayPeer(attachment.role, attachment.attemptId);
        try { ws.close(4003, result.error); } catch { /* already closed */ }
        try { peer?.close(4003, 'Peer relay protocol violation'); } catch { /* already closed */ }
      }
      return;
    }
    const peer = this.#relayPeer(attachment.role, attachment.attemptId);
    if (!peer) {
      try { ws.close(4004, 'Relay peer unavailable'); } catch { /* already closed */ }
      return;
    }
    try { peer.send(message); }
    catch { try { ws.close(4004, 'Relay peer unavailable'); } catch { /* already closed */ } }
  }

  async webSocketClose(ws, code, reason) {
    const attachment = ws.deserializeAttachment?.() || {};
    const { kind, role, attemptId } = attachment;
    if (kind === 'relay') {
      const peer = this.#relayPeer(role, attemptId);
      try { peer?.close(code || 4002, reason || 'Relay peer closed'); } catch { /* already closed */ }
      const session = await this.ctx.storage.get('session');
      if (session && Date.now() < session.expiresAt) await this.ctx.storage.setAlarm(session.expiresAt);
      try { ws.close(code, reason); } catch { /* already closed */ }
      return;
    }

    if (role === 'receiver' && Number.isInteger(attemptId)) {
      for (const relayRole of ['sender', 'receiver']) {
        for (const relay of this.ctx.getWebSockets(`relay-${relayRole}`)) {
          const relayAttachment = relay.deserializeAttachment?.() || {};
          if (relayAttachment.attemptId === attemptId) {
            try { relay.close(4002, 'Receiver attempt closed'); } catch { /* already closed */ }
          }
        }
      }
      const session = await this.ctx.storage.get('session');
      if (session?.activeAttemptId === attemptId) {
        await this.ctx.storage.put('session', {
          ...session,
          activeAttemptId: null,
          readyAttemptId: null,
          relayCapabilities: null,
          relayStartedAttemptId: null,
          relayDeclaredAttemptId: null,
        });
      }
    }
    try { ws.close(code, reason); } catch { /* already closed */ }
  }

  async alarm() {
    const session = await this.ctx.storage.get('session');
    if (!session) return;
    const now = Date.now();
    if (now >= session.expiresAt) {
      for (const ws of this.ctx.getWebSockets()) {
        try { ws.close(4000, 'Session expired'); } catch { /* already closed */ }
      }
      await this.ctx.storage.deleteAll();
      return;
    }

    let relayStillOpen = false;
    for (const ws of this.ctx.getWebSockets()) {
      const attachment = ws.deserializeAttachment?.() || {};
      if (attachment.kind !== 'relay') continue;
      if (isRelayForwardIdle(attachment.forwardState, now)) {
        try { ws.close(4005, 'Relay idle timeout'); } catch { /* already closed */ }
      } else {
        relayStillOpen = true;
      }
    }
    await this.ctx.storage.setAlarm(relayStillOpen
      ? Math.min(session.expiresAt, now + RELAY_IDLE_TIMEOUT_MS)
      : session.expiresAt);
  }
}
