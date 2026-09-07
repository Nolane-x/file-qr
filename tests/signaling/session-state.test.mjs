import test from 'node:test';
import assert from 'node:assert/strict';
import { SessionState } from '../../services/signaling/src/session-state.js';

test('session expires exactly 600 seconds after creation', () => {
  const s = new SessionState(1_000, 600_000, 'TOKEN');
  assert.equal(s.isExpired(600_999), false);
  assert.equal(s.isExpired(601_000), true);
});

test('only the token holder can claim sender and only one receiver attempt is active', () => {
  const s = new SessionState(0, 600_000, 'TOKEN');
  assert.throws(() => s.admit('sender', 'BAD', 1), /token/i);
  assert.deepEqual(s.admit('sender', 'TOKEN', 1), { role: 'sender' });
  assert.throws(() => s.admit('sender', 'TOKEN', 2), /sender/i);
  assert.deepEqual(s.admit('receiver', '', 2), { role: 'receiver', attemptId: 1 });
  assert.equal(s.receiverActive, true);
  assert.throws(() => s.admit('receiver', '', 3), /receiver/i);
});

test('completed or failed receiver attempt does not consume the ten-minute lease', () => {
  const s = new SessionState(0, 600_000, 'TOKEN');
  s.admit('sender', 'TOKEN', 1);
  const first = s.admit('receiver', '', 10);
  assert.equal(first.attemptId, 1);
  assert.equal(s.releaseReceiver(first.attemptId), true);
  assert.equal(s.receiverActive, false);

  const second = s.admit('receiver', '', 20);
  assert.equal(second.attemptId, 2);
  assert.equal(s.releaseReceiver(first.attemptId), false, 'stale attempt must not release the active receiver');
  assert.equal(s.receiverActive, true);
  assert.equal(s.releaseReceiver(second.attemptId), true);
  assert.equal(s.receiverActive, false);
});

test('sequential receiver attempts remain admissible until the exact expiry instant', () => {
  const s = new SessionState(1_000, 600_000, 'TOKEN');
  const first = s.admit('receiver', '', 600_999);
  assert.equal(first.attemptId, 1);
  assert.equal(s.releaseReceiver(first.attemptId), true);
  assert.throws(() => s.admit('receiver', '', 601_000), /expired/i);
  assert.throws(() => s.admit('receiver', '', 700_000), /expired/i);
});
