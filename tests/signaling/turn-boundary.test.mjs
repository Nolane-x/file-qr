import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { defaultIceServers, fetchOptionalIceServers } from '../../apps/web/src/webrtc.js';

const signaling = fs.readFileSync(new URL('../../services/signaling/src/index.js', import.meta.url), 'utf8');
const wrangler = fs.readFileSync(new URL('../../services/signaling/wrangler.jsonc', import.meta.url), 'utf8');
const main = fs.readFileSync(new URL('../../apps/web/src/main.js', import.meta.url), 'utf8');

test('optional TURN fetch treats unconfigured signaling as direct-mode success', async () => {
  let requestedUrl = '';
  const iceServers = await fetchOptionalIceServers('https://signal.example', {
    leaseCode: 'ABCDE-FGHJK',
    fetchImpl: async (url, init) => {
      requestedUrl = String(url);
      assert.equal(init.method, 'POST');
      assert.deepEqual(JSON.parse(init.body), { code: 'ABCDE-FGHJK' });
      return new Response(JSON.stringify({ error: 'turn-not-configured' }), {
        status: 404,
        headers: { 'content-type': 'application/json' },
      });
    },
  });

  assert.equal(requestedUrl, 'https://signal.example/v1/turn-credentials');
  assert.deepEqual(iceServers, []);
  assert.ok(defaultIceServers().length >= 2);
});

test('optional TURN fetch returns only validated short-lived ICE servers', async () => {
  const iceServers = await fetchOptionalIceServers('https://signal.example/', {
    leaseCode: 'ABCDE-FGHJK',
    timeoutMs: 50,
    fetchImpl: async () => new Response(JSON.stringify({
      iceServers: [{
        urls: ['turn:turn.cloudflare.com:3478?transport=udp'],
        username: 'short-user',
        credential: 'short-credential',
      }],
      expiresAt: Date.now() + 600_000,
    }), { status: 200, headers: { 'content-type': 'application/json' } }),
  });

  assert.equal(iceServers.length, 1);
  assert.match(iceServers[0].urls[0], /^turn:/);
  assert.equal(iceServers[0].username, 'short-user');
  assert.equal(iceServers[0].credential, 'short-credential');
});

test('signaling TURN boundary is lease-bound and keeps long-lived credentials server-side', () => {
  assert.match(signaling, /\/v1\/turn-credentials/);
  assert.match(signaling, /TURN_KEY_ID/);
  assert.match(signaling, /TURN_KEY_API_TOKEN/);
  assert.match(signaling, /rtc\.live\.cloudflare\.com/);
  assert.match(signaling, /turn-authorize|authorize-turn/);
  assert.match(signaling, /Date\.now\(\)\s*>=\s*session\.expiresAt/);

  assert.ok(!wrangler.includes('TURN_KEY_API_TOKEN'));
  assert.ok(!wrangler.includes('TURN_KEY_ID'));
  assert.ok(!/Bearer\s+[A-Za-z0-9_-]{20,}/.test(signaling));
});

test('web runtime merges optional TURN with default STUN before creating each attempt peer', () => {
  assert.match(main, /fetchOptionalIceServers/);
  assert.match(main, /defaultIceServers/);
  assert.match(main, /resolveIceServers/);
  assert.match(main, /createPeerConnection\(\{\s*iceServers\s*\}\)/);
});
