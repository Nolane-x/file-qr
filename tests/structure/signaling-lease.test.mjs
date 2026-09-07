import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const source = fs.readFileSync(new URL('../../services/signaling/src/index.js', import.meta.url), 'utf8');

test('signaling no longer consumes the room after a data channel opens', () => {
  assert.ok(!source.includes("payload?.type === 'session-consumed'"));
  assert.ok(!source.includes('consumed: false'));
  assert.ok(!source.includes('session.consumed'));
});

test('receiver admissions receive monotonic attempt ids', () => {
  assert.match(source, /attemptCounter/);
  assert.match(source, /attemptId/);
  assert.match(source, /peer-ready[\s\S]*attemptId/);
});

test('receiver websocket attachment owns its attempt and close releases only that attempt', () => {
  assert.match(source, /serializeAttachment\(\{\s*role,\s*attemptId/);
  assert.match(source, /webSocketClose[\s\S]*attemptId/);
  assert.match(source, /activeAttemptId[\s\S]*===\s*attemptId/);
});

test('exact lease expiry remains server-side', () => {
  assert.match(source, /Date\.now\(\)\s*>=\s*session\.expiresAt/);
  assert.match(source, /setAlarm\(session\.expiresAt\)/);
});
