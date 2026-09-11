import test from 'node:test';
import assert from 'node:assert/strict';

let routesPromise;
async function loadRoutes() {
  routesPromise ||= import('../../services/signaling/src/resource-routes.js');
  try {
    return await routesPromise;
  } catch (error) {
    assert.fail(`signaling resource routes must expose a Node-testable behavioral seam: ${error?.message || error}`);
  }
}

function sessionEnv(limitResult) {
  const state = { limiterCalls: 0, limiterKey: '', roomLookups: 0, roomFetches: 0 };
  return {
    state,
    env: {
      SESSION_ALLOCATION_RATE_LIMIT: limitResult === 'missing' ? undefined : {
        async limit({ key }) {
          state.limiterCalls += 1;
          state.limiterKey = key;
          if (limitResult instanceof Error) throw limitResult;
          return limitResult;
        },
      },
      SESSIONS: {
        idFromName() {
          state.roomLookups += 1;
          return 'room-id';
        },
        get() {
          state.roomLookups += 1;
          return {
            async fetch() {
              state.roomFetches += 1;
              return new Response(JSON.stringify({ ok: true }), { status: 201 });
            },
          };
        },
      },
      SESSION_TTL_MS: '600000',
    },
  };
}

function turnEnv({ authorizationStatus = 200, limitResult = { success: false } } = {}) {
  const state = { authorizationCalls: 0, limiterCalls: 0, limiterKey: '', providerCalls: 0 };
  return {
    state,
    env: {
      TURN_KEY_ID: 'test-turn-key',
      TURN_KEY_API_TOKEN: 'test-turn-api-token',
      TURN_CREDENTIAL_RATE_LIMIT: limitResult === 'missing' ? undefined : {
        async limit({ key }) {
          state.limiterCalls += 1;
          state.limiterKey = key;
          if (limitResult instanceof Error) throw limitResult;
          return limitResult;
        },
      },
      SESSIONS: {
        idFromName() { return 'room-id'; },
        get() {
          return {
            async fetch() {
              state.authorizationCalls += 1;
              return new Response(JSON.stringify({
                ok: authorizationStatus === 200,
                expiresAt: Date.now() + 600_000,
              }), { status: authorizationStatus });
            },
          };
        },
      },
    },
  };
}

const SESSION_REQUEST = () => new Request('https://signal.example/v1/sessions', {
  method: 'POST',
  headers: { 'cf-connecting-ip': '203.0.113.42', 'content-type': 'application/json' },
  body: '{}',
});

const TURN_REQUEST = () => new Request('https://signal.example/v1/turn-credentials', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ code: 'ABCDE-FGHJK' }),
});

test('session denial returns 429 before code, token, or Durable Object allocation side effects', async () => {
  const { handleSessionAllocation } = await loadRoutes();
  const { env, state } = sessionEnv({ success: false });
  let codeCalls = 0;
  let tokenCalls = 0;

  const response = await handleSessionAllocation(SESSION_REQUEST(), env, {
    createReceiveCodeImpl() { codeCalls += 1; return 'ABCDE-FGHJK'; },
    randomTokenImpl() { tokenCalls += 1; return 'sender-token'; },
  });

  assert.equal(response.status, 429);
  assert.equal(response.headers.get('retry-after'), '60');
  assert.deepEqual(await response.json(), { error: 'rate-limited' });
  assert.equal(state.limiterCalls, 1);
  assert.match(state.limiterKey, /^[0-9a-f]{64}$/);
  assert.ok(!state.limiterKey.includes('203.0.113.42'));
  assert.equal(codeCalls, 0);
  assert.equal(tokenCalls, 0);
  assert.equal(state.roomLookups, 0);
  assert.equal(state.roomFetches, 0);
});

test('session limiter absence or exception fails closed before room allocation', async () => {
  const { handleSessionAllocation } = await loadRoutes();
  for (const limiterState of ['missing', new Error('limiter unavailable')]) {
    const { env, state } = sessionEnv(limiterState);
    const response = await handleSessionAllocation(SESSION_REQUEST(), env);
    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), { error: 'rate-limit-unavailable' });
    assert.equal(state.roomLookups, 0);
    assert.equal(state.roomFetches, 0);
  }
});

test('TURN denial happens after live-lease authorization and before provider minting', async () => {
  const { handleTurnCredentials } = await loadRoutes();
  const { env, state } = turnEnv({ limitResult: { success: false } });

  const response = await handleTurnCredentials(TURN_REQUEST(), env, {
    async generateTurnCredentialsImpl() {
      state.providerCalls += 1;
      return { iceServers: [{ urls: ['turn:example.invalid'] }], expiresAt: Date.now() + 300_000 };
    },
  });

  assert.equal(response.status, 429);
  assert.equal(response.headers.get('retry-after'), '60');
  assert.deepEqual(await response.json(), { error: 'rate-limited' });
  assert.equal(state.authorizationCalls, 1);
  assert.equal(state.limiterCalls, 1);
  assert.match(state.limiterKey, /^[0-9a-f]{64}$/);
  assert.ok(!state.limiterKey.includes('ABCDEFGHJK'));
  assert.equal(state.providerCalls, 0);
});

test('TURN unconfigured and expired-session paths do not consume limiter or provider authority', async () => {
  const { handleTurnCredentials } = await loadRoutes();

  const unconfigured = turnEnv({ limitResult: { success: true } });
  delete unconfigured.env.TURN_KEY_ID;
  delete unconfigured.env.TURN_KEY_API_TOKEN;
  const unconfiguredResponse = await handleTurnCredentials(TURN_REQUEST(), unconfigured.env, {
    async generateTurnCredentialsImpl() { unconfigured.state.providerCalls += 1; return null; },
  });
  assert.equal(unconfiguredResponse.status, 404);
  assert.deepEqual(await unconfiguredResponse.json(), { error: 'turn-not-configured' });
  assert.equal(unconfigured.state.authorizationCalls, 0);
  assert.equal(unconfigured.state.limiterCalls, 0);
  assert.equal(unconfigured.state.providerCalls, 0);

  const expired = turnEnv({ authorizationStatus: 410, limitResult: { success: true } });
  const expiredResponse = await handleTurnCredentials(TURN_REQUEST(), expired.env, {
    async generateTurnCredentialsImpl() { expired.state.providerCalls += 1; return null; },
  });
  assert.equal(expiredResponse.status, 410);
  assert.deepEqual(await expiredResponse.json(), { error: 'session-expired' });
  assert.equal(expired.state.authorizationCalls, 1);
  assert.equal(expired.state.limiterCalls, 0);
  assert.equal(expired.state.providerCalls, 0);
});

test('TURN limiter unavailability fails closed after authorization and before provider minting', async () => {
  const { handleTurnCredentials } = await loadRoutes();
  for (const limiterState of ['missing', new Error('limiter unavailable')]) {
    const { env, state } = turnEnv({ limitResult: limiterState });
    const response = await handleTurnCredentials(TURN_REQUEST(), env, {
      async generateTurnCredentialsImpl() { state.providerCalls += 1; return null; },
    });
    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), { error: 'rate-limit-unavailable' });
    assert.equal(state.authorizationCalls, 1);
    assert.equal(state.providerCalls, 0);
  }
});