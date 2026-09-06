import test from 'node:test';
import assert from 'node:assert/strict';
import { SessionState } from '../../services/signaling/src/session-state.js';

test('session expires exactly 600 seconds after creation', () => {
  const s = new SessionState(1_000, 600_000, 'TOKEN');
  assert.equal(s.isExpired(600_999), false);
  assert.equal(s.isExpired(601_000), true);
});

test('only the token holder can claim sender and only one receiver can join', () => {
  const s = new SessionState(0, 600_000, 'TOKEN');
  assert.throws(() => s.admit('sender', 'BAD', 1), /token/i);
  assert.deepEqual(s.admit('sender', 'TOKEN', 1), { role: 'sender' });
  assert.throws(() => s.admit('sender', 'TOKEN', 2), /sender/i);
  assert.deepEqual(s.admit('receiver', '', 2), { role: 'receiver' });
  assert.throws(() => s.admit('receiver', '', 3), /receiver/i);
});

test('consumed session rejects new admissions', () => {
  const s = new SessionState(0, 600_000, 'TOKEN');
  s.consume();
  assert.throws(() => s.admit('receiver', '', 10), /consumed/i);
});
