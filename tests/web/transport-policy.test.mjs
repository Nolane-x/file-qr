import test from 'node:test';
import assert from 'node:assert/strict';

const moduleUrl = new URL('../../apps/web/src/transport-policy.js', import.meta.url);
async function load() { return import(moduleUrl); }

test('direct is always the initial production path when relay is available', async () => {
  const { createTransportPolicy } = await load();
  const policy = createTransportPolicy({ hasRelaySecret: true });
  assert.deepEqual(policy.start(), { state: 'connecting-direct', action: 'connect-direct' });
  assert.equal(policy.state, 'connecting-direct');
  assert.deepEqual(policy.directConnected(), { state: 'direct', action: 'use-direct' });
});

test('transient disconnect never enters relay before terminal direct exhaustion', async () => {
  const { createTransportPolicy } = await load();
  const policy = createTransportPolicy({ hasRelaySecret: true });
  policy.start();
  policy.directConnected();
  assert.deepEqual(policy.directDisconnected(), { state: 'direct', action: 'wait-direct-recovery' });
  assert.equal(policy.state, 'direct');
});

test('terminal direct exhaustion before committed bytes enters encrypted relay when QR secret exists', async () => {
  const { createTransportPolicy } = await load();
  const policy = createTransportPolicy({ hasRelaySecret: true });
  policy.start();
  assert.deepEqual(policy.directExhausted({ committedBytes: 0 }), { state: 'connecting-relay', action: 'connect-relay' });
  assert.deepEqual(policy.relayConnected(), { state: 'relay', action: 'use-relay' });
  assert.deepEqual(policy.complete(), { state: 'completed', action: 'complete' });
});

test('manual-code receiver cannot silently downgrade into encrypted relay', async () => {
  const { createTransportPolicy } = await load();
  const policy = createTransportPolicy({ hasRelaySecret: false });
  policy.start();
  assert.deepEqual(policy.directExhausted({ committedBytes: 0 }), { state: 'failed', action: 'require-qr-relay-secret' });
  assert.equal(policy.state, 'failed');
});

test('force-relay is evidence-only but still requires the QR relay secret', async () => {
  const { createTransportPolicy } = await load();
  const forced = createTransportPolicy({ hasRelaySecret: true, forceRelay: true });
  assert.deepEqual(forced.start(), { state: 'connecting-relay', action: 'connect-relay' });
  const unsafe = createTransportPolicy({ hasRelaySecret: false, forceRelay: true });
  assert.deepEqual(unsafe.start(), { state: 'failed', action: 'require-qr-relay-secret' });
});

test('same-attempt transport splice is forbidden after committed bytes', async () => {
  const { createTransportPolicy } = await load();
  const policy = createTransportPolicy({ hasRelaySecret: true });
  policy.start();
  policy.directConnected();
  assert.deepEqual(policy.directExhausted({ committedBytes: 1 }), { state: 'failed', action: 'retry-new-attempt' });
  assert.equal(policy.state, 'failed');
});
