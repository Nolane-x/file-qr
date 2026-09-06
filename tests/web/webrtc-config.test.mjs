import test from 'node:test';
import assert from 'node:assert/strict';

const moduleUrl = new URL('../../apps/web/src/webrtc.js', import.meta.url);

test('default ICE configuration includes Cloudflare and Google STUN', async () => {
  const mod = await import(moduleUrl);
  assert.equal(typeof mod.defaultIceServers, 'function');
  const servers = mod.defaultIceServers();
  const text = JSON.stringify(servers);
  assert.match(text, /stun\.cloudflare\.com:3478/);
  assert.match(text, /stun\.l\.google\.com:19302/);
});

test('peer creation accepts injected ICE servers for future TURN credentials', async () => {
  const previous = globalThis.RTCPeerConnection;
  globalThis.RTCPeerConnection = class {
    constructor(config) { this.config = config; }
  };
  try {
    const { createPeerConnection } = await import(moduleUrl);
    const custom = [{ urls: ['turn:relay.example.test:3478'], username: 'short', credential: 'lived' }];
    const peer = createPeerConnection({ iceServers: custom });
    assert.deepEqual(peer.config.iceServers, custom);
  } finally {
    globalThis.RTCPeerConnection = previous;
  }
});
