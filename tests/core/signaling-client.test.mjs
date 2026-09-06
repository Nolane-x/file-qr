import test from 'node:test';
import assert from 'node:assert/strict';
import { buildSignalWebSocketUrl } from '../../apps/web/src/signaling.js';

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
