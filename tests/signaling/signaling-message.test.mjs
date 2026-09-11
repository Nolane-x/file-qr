import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const moduleUrl = new URL('../../services/signaling/src/signaling-message.js', import.meta.url);

test('client signaling parser accepts only bounded File QR signaling envelopes', async () => {
  if (!fs.existsSync(moduleUrl)) {
    assert.fail('signaling-message.js must exist so signaling validation is behavior-testable');
  }

  const {
    MAX_SIGNALING_MESSAGE_CHARS,
    parseClientSignalingMessage,
  } = await import(moduleUrl.href);

  assert.equal(typeof parseClientSignalingMessage, 'function');
  assert.ok(Number.isInteger(MAX_SIGNALING_MESSAGE_CHARS));
  assert.ok(MAX_SIGNALING_MESSAGE_CHARS >= 16_384);
  assert.ok(MAX_SIGNALING_MESSAGE_CHARS <= 262_144);

  const ready = { type: 'attempt-ready', attemptId: 7 };
  assert.deepEqual(parseClientSignalingMessage(JSON.stringify(ready)), ready);

  const offer = {
    type: 'description',
    attemptId: 7,
    description: { type: 'offer', sdp: 'v=0\r\n' },
  };
  assert.deepEqual(parseClientSignalingMessage(JSON.stringify(offer)), offer);

  const candidate = {
    type: 'candidate',
    attemptId: 7,
    candidate: {
      candidate: 'candidate:1 1 udp 2122260223 192.0.2.1 50000 typ host',
      sdpMid: '0',
      sdpMLineIndex: 0,
      usernameFragment: 'abc123',
    },
  };
  assert.deepEqual(parseClientSignalingMessage(JSON.stringify(candidate)), candidate);

  for (const invalid of [
    null,
    '',
    '{',
    JSON.stringify({ type: 'unknown', attemptId: 7 }),
    JSON.stringify({ type: 'attempt-ready', attemptId: 0 }),
    JSON.stringify({ type: 'attempt-ready', attemptId: Number.MAX_SAFE_INTEGER + 1 }),
    JSON.stringify({ type: 'description', attemptId: 7, description: { type: 'rollback', sdp: '' } }),
    JSON.stringify({ type: 'description', attemptId: 7, description: { type: 'offer', sdp: 'x'.repeat(70_000) } }),
    JSON.stringify({ type: 'candidate', attemptId: 7, candidate: { candidate: 'x'.repeat(9_000) } }),
    'x'.repeat(MAX_SIGNALING_MESSAGE_CHARS + 1),
  ]) {
    assert.equal(parseClientSignalingMessage(invalid), null);
  }
});
