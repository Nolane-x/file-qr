import test from 'node:test';
import assert from 'node:assert/strict';
import { buildRelayWebSocketUrl, buildSignalWebSocketUrl } from '../../apps/web/src/signaling.js';

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
