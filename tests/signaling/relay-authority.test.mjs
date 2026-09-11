import test from 'node:test';
import assert from 'node:assert/strict';

const moduleUrl = new URL('../../services/signaling/src/relay-authority.js', import.meta.url);

async function load() {
  try {
    return await import(moduleUrl);
  } catch (error) {
    assert.fail(`relay-authority.js must exist: ${error?.message || error}`);
  }
}

test('relay capabilities are high entropy and persisted only as hashes', async () => {
  const { issueRelayCapability, createRelayCapabilityState } = await load();
  let requested = 0;
  const sender = await issueRelayCapability((bytes) => { requested = bytes.length; bytes.fill(7); });
  const receiver = await issueRelayCapability((bytes) => bytes.fill(9));
  assert.equal(requested, 32);
  assert.match(sender.capability, /^[A-Za-z0-9_-]{43}$/);
  assert.match(sender.capabilityHash, /^[0-9a-f]{64}$/);
  assert.notEqual(sender.capability, sender.capabilityHash);
  const state = createRelayCapabilityState(3, sender.capabilityHash, receiver.capabilityHash);
  assert.deepEqual(Object.keys(state).sort(), ['attemptId', 'receiverHash', 'senderHash']);
  assert.ok(!JSON.stringify(state).includes(sender.capability));
  assert.ok(!JSON.stringify(state).includes(receiver.capability));
});

test('relay admission requires live exact attempt role and matching capability hash', async () => {
  const { validateRelayAdmission } = await load();
  const now = 1_800_000_000_000;
  const session = {
    expiresAt: now + 60_000,
    activeAttemptId: 4,
    relayAttemptCount: 1,
    relayStartedAttemptId: 4,
    relayCapabilities: { attemptId: 4, senderHash: 'a'.repeat(64), receiverHash: 'b'.repeat(64) },
  };
  assert.deepEqual(validateRelayAdmission(session, { role: 'sender', attemptId: 4, capabilityHash: 'a'.repeat(64), now }), { ok: true, status: 200, error: null });
  assert.equal(validateRelayAdmission(session, { role: 'receiver', attemptId: 4, capabilityHash: 'b'.repeat(64), now }).ok, true);
  assert.deepEqual(validateRelayAdmission(session, { role: 'viewer', attemptId: 4, capabilityHash: 'a'.repeat(64), now }), { ok: false, status: 400, error: 'invalid-relay-role' });
  assert.deepEqual(validateRelayAdmission(session, { role: 'sender', attemptId: 5, capabilityHash: 'a'.repeat(64), now }), { ok: false, status: 409, error: 'stale-relay-attempt' });
  assert.deepEqual(validateRelayAdmission(session, { role: 'sender', attemptId: 4, capabilityHash: 'c'.repeat(64), now }), { ok: false, status: 403, error: 'invalid-relay-capability' });
  assert.deepEqual(validateRelayAdmission({ ...session, expiresAt: now }, { role: 'sender', attemptId: 4, capabilityHash: 'a'.repeat(64), now }), { ok: false, status: 410, error: 'session-expired' });
});

test('relay admission fails closed when capability state is missing or belongs to another attempt', async () => {
  const { validateRelayAdmission } = await load();
  const now = 5_000;
  const base = { expiresAt: 6_000, activeAttemptId: 2, relayAttemptCount: 0, relayStartedAttemptId: null };
  assert.equal(validateRelayAdmission(base, { role: 'sender', attemptId: 2, capabilityHash: 'a'.repeat(64), now }).error, 'relay-capability-unavailable');
  assert.equal(validateRelayAdmission({ ...base, relayCapabilities: { attemptId: 1, senderHash: 'a'.repeat(64), receiverHash: 'b'.repeat(64) } }, { role: 'sender', attemptId: 2, capabilityHash: 'a'.repeat(64), now }).error, 'relay-capability-unavailable');
});

test('a fifth distinct relay attempt in one lease is denied without blocking the already-started fourth attempt', async () => {
  const { validateRelayAdmission } = await load();
  const now = 1_000;
  const relayCapabilities = { attemptId: 9, senderHash: 'a'.repeat(64), receiverHash: 'b'.repeat(64) };
  const session = { expiresAt: 2_000, activeAttemptId: 9, relayAttemptCount: 4, relayStartedAttemptId: 8, relayCapabilities };
  assert.deepEqual(validateRelayAdmission(session, { role: 'sender', attemptId: 9, capabilityHash: 'a'.repeat(64), now }), { ok: false, status: 429, error: 'relay-attempt-limit' });
  const already = { ...session, relayStartedAttemptId: 9 };
  assert.equal(validateRelayAdmission(already, { role: 'sender', attemptId: 9, capabilityHash: 'a'.repeat(64), now }).ok, true);
});
