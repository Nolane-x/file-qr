import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const index = fs.readFileSync(new URL('../../services/signaling/src/index.js', import.meta.url), 'utf8');

test('relay path is distinct from signaling and uses attempt-scoped capability authority', () => {
  assert.match(index, /\/(connect\|relay)|\/relay/);
  assert.match(index, /issueRelayCapability/);
  assert.match(index, /deriveSenderRelayCapability/);
  assert.match(index, /hashRelayCapability/);
  assert.match(index, /validateRelayAdmission/);
  assert.match(index, /relayCapability/);
});

test('relay binary branches before JSON signaling parser and uses relay-only socket tags', () => {
  const relayBranch = index.indexOf("attachment.kind === 'relay'");
  const signalingParser = index.indexOf('parseClientSignalingMessage(message)');
  assert.ok(relayBranch >= 0 && signalingParser > relayBranch);
  assert.match(index, /`relay-\$\{role\}`/);
  assert.match(index, /message instanceof ArrayBuffer/);
  assert.match(index, /processRelayFrame/);
});

test('relay payload is attachment-forwarded rather than persisted in Durable Object storage', () => {
  const relayMethod = index.slice(
    index.lastIndexOf('#relayMessage(ws, message, attachment) {'),
    index.indexOf('async webSocketClose'),
  );
  assert.match(relayMethod, /peer\.send\(message\)/);
  assert.doesNotMatch(relayMethod, /storage\.put/);
  assert.match(index, /relayDeclaredBytes/);
  assert.match(index, /RELAY_MAX_SESSION_DECLARED_BYTES/);
});

test('alarm preserves exact lease expiry while enforcing relay idle timeout', () => {
  assert.match(index, /RELAY_IDLE_TIMEOUT_MS/);
  assert.match(index, /isRelayForwardIdle/);
  assert.match(index, /session\.expiresAt/);
  assert.match(index, /storage\.deleteAll\(\)/);
});
