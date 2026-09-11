import test from 'node:test';
import assert from 'node:assert/strict';
import { handleTurnCredentials } from '../../services/signaling/src/resource-routes.js';

const TURN_REQUEST = () => new Request('https://signal.example/v1/turn-credentials', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ code: 'ABCDE-FGHJK' }),
});

test('TURN provider minting is bounded by the remaining authorized lease lifetime', async () => {
  const now = 1_000_000;
  const leaseExpiresAt = now + 120_500;
  let providerMaxTtlSeconds = null;

  const response = await handleTurnCredentials(TURN_REQUEST(), {}, {
    turnConfiguredImpl: () => true,
    authorizeTurnImpl: async () => new Response(JSON.stringify({ ok: true, expiresAt: leaseExpiresAt }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }),
    compactCodeImpl: () => 'ABCDEFGHJK',
    rateLimitBinding: { async limit() { return { success: true }; } },
    nowImpl: () => now,
    async generateTurnCredentialsImpl(maxTtlSeconds) {
      providerMaxTtlSeconds = maxTtlSeconds;
      return {
        iceServers: [{ urls: ['turn:example.invalid'], username: 'u', credential: 'c' }],
        expiresAt: now + maxTtlSeconds * 1000,
      };
    },
  });

  assert.equal(response.status, 200);
  assert.equal(providerMaxTtlSeconds, 120);
  const payload = await response.json();
  assert.ok(payload.expiresAt <= leaseExpiresAt);
});
