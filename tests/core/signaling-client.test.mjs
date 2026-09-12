import test from 'node:test';
import assert from 'node:assert/strict';
import { buildRelayWebSocketUrl, buildSignalWebSocketUrl, connectRelay } from '../../apps/web/src/signaling.js';

test('signaling websocket URL encodes code, role and sender token', () => {
  assert.equal(
    buildSignalWebSocketUrl('https://signal.example', 'ABCD1-EFGH2', 'sender', 'a b'),
    'wss://signal.example/v1/sessions/ABCD1EFGH2/connect?role=sender&token=a+b'
  );
});

test('receiver signaling URL omits sender token', () => {
  assert.equal(
    buildSignalWebSocketUrl('http://localhost:8787/', 'ABCD1-EFGH2', 'receiver'),
    'ws://localhost:8787/v1/sessions/ABCD1EFGH2/connect?role=receiver'
  );
});

test('relay websocket URL binds role attempt capability remaining bytes and nonce without sender token', () => {
  const url = buildRelayWebSocketUrl('https://signal.example', 'ABCD1-EFGH2', {
    role: 'sender',
    attemptId: 7,
    capability: 'A'.repeat(43),
    remaining: 65536,
    noncePrefix: Uint8Array.from([0, 1, 2, 3, 4, 5, 6, 7]),
  });
  assert.equal(
    url,
    `wss://signal.example/v1/sessions/ABCD1EFGH2/relay?role=sender&attemptId=7&cap=${'A'.repeat(43)}&nonce=AAECAwQFBgc&remaining=65536`,
  );
  assert.ok(!url.includes('token='));
});

test('receiver relay URL omits remaining byte declaration', () => {
  const url = buildRelayWebSocketUrl('http://localhost:8787/', 'ABCD1-EFGH2', {
    role: 'receiver',
    attemptId: 1,
    capability: 'B'.repeat(43),
    noncePrefix: Uint8Array.from([8, 9, 10, 11, 12, 13, 14, 15]),
  });
  assert.equal(
    url,
    `ws://localhost:8787/v1/sessions/ABCD1EFGH2/relay?role=receiver&attemptId=1&cap=${'B'.repeat(43)}&nonce=CAkKCwwNDg8`,
  );
});

test('relay connection buffers the first encrypted frame until transport adopts the socket', async (t) => {
  const originalWebSocket = globalThis.WebSocket;
  class FakeWebSocket {
    static instances = [];
    constructor(url) {
      this.url = url;
      this.readyState = 0;
      this.binaryType = '';
      this.listeners = new Map();
      FakeWebSocket.instances.push(this);
    }
    addEventListener(type, fn) {
      const list = this.listeners.get(type) || [];
      list.push(fn);
      this.listeners.set(type, list);
    }
    removeEventListener(type, fn) {
      this.listeners.set(type, (this.listeners.get(type) || []).filter((entry) => entry !== fn));
    }
    emit(type, event = {}) {
      for (const fn of [...(this.listeners.get(type) || [])]) fn(event);
    }
    open() {
      this.readyState = 1;
      this.emit('open');
    }
    close() {
      this.readyState = 3;
      this.emit('close');
    }
    send() {}
  }
  globalThis.WebSocket = FakeWebSocket;
  t.after(() => { globalThis.WebSocket = originalWebSocket; });

  const connecting = connectRelay('http://localhost:8787', 'ABCD1-EFGH2', {
    role: 'receiver',
    attemptId: 1,
    capability: 'B'.repeat(43),
    noncePrefix: Uint8Array.from([8, 9, 10, 11, 12, 13, 14, 15]),
  });
  const raw = FakeWebSocket.instances.at(-1);
  raw.open();
  const socket = await connecting;
  raw.emit('message', { data: JSON.stringify({ type: 'relay-ready', peerNoncePrefix: 'AAECAwQFBgc' }) });
  await socket.fileQrRelayReady;

  const firstEncryptedFrame = Uint8Array.from([1, 2, 3]).buffer;
  raw.emit('message', { data: firstEncryptedFrame });
  const seen = [];
  assert.equal(typeof socket.fileQrAdoptRelayMessageHandler, 'function');
  const release = socket.fileQrAdoptRelayMessageHandler((event) => seen.push(event.data));
  assert.deepEqual(seen, [firstEncryptedFrame], 'frame arriving after relay-ready but before transport setup must be replayed exactly once');

  const secondEncryptedFrame = Uint8Array.from([4, 5]).buffer;
  raw.emit('message', { data: secondEncryptedFrame });
  assert.deepEqual(seen, [firstEncryptedFrame, secondEncryptedFrame], 'live relay frames must continue through the adopted handler');
  release();
});
