import test from 'node:test';
import assert from 'node:assert/strict';

const moduleUrl = new URL('../../packages/core/relay-frame.js', import.meta.url);

async function loadRelayFrame() {
  try {
    return await import(moduleUrl);
  } catch (error) {
    assert.fail(`relay-frame.js must exist: ${error?.message || error}`);
  }
}

test('relay frame round-trips bounded authenticated metadata and opaque ciphertext', async () => {
  const {
    RELAY_PROTOCOL_VERSION,
    RELAY_MAX_PLAINTEXT_BYTES,
    RELAY_MAX_FRAME_BYTES,
    encodeRelayFrame,
    parseRelayFrame,
  } = await loadRelayFrame();

  assert.equal(RELAY_PROTOCOL_VERSION, 1);
  assert.equal(RELAY_MAX_PLAINTEXT_BYTES, 64 * 1024);
  assert.equal(RELAY_MAX_FRAME_BYTES, 70 * 1024);

  const ciphertext = Uint8Array.from({ length: 17 }, (_, index) => index + 1);
  const frame = encodeRelayFrame({
    attemptId: 7,
    sequence: 3,
    kind: 'data',
    plaintextLength: 1,
    ciphertext,
  });
  const parsed = parseRelayFrame(frame, 7);
  assert.equal(parsed.version, 1);
  assert.equal(parsed.attemptId, 7);
  assert.equal(parsed.sequence, 3);
  assert.equal(parsed.kind, 'data');
  assert.equal(parsed.plaintextLength, 1);
  assert.deepEqual(parsed.ciphertext, ciphertext);
  assert.ok(parsed.header instanceof Uint8Array);
});

test('relay frame parser rejects version, attempt, sequence, kind and size violations', async () => {
  const { encodeRelayFrame, parseRelayFrame } = await loadRelayFrame();
  const tagOnly = new Uint8Array(16);

  assert.throws(() => encodeRelayFrame({ attemptId: 0, sequence: 0, kind: 'data', plaintextLength: 0, ciphertext: tagOnly }), /attempt/i);
  assert.throws(() => encodeRelayFrame({ attemptId: 1, sequence: -1, kind: 'data', plaintextLength: 0, ciphertext: tagOnly }), /sequence/i);
  assert.throws(() => encodeRelayFrame({ attemptId: 1, sequence: 2 ** 32, kind: 'data', plaintextLength: 0, ciphertext: tagOnly }), /sequence/i);
  assert.throws(() => encodeRelayFrame({ attemptId: 1, sequence: 0, kind: 'unknown', plaintextLength: 0, ciphertext: tagOnly }), /kind/i);
  assert.throws(() => encodeRelayFrame({ attemptId: 1, sequence: 0, kind: 'data', plaintextLength: 64 * 1024 + 1, ciphertext: new Uint8Array(64 * 1024 + 17) }), /plaintext|size/i);

  const valid = encodeRelayFrame({ attemptId: 9, sequence: 0, kind: 'control', plaintextLength: 0, ciphertext: tagOnly });
  assert.throws(() => parseRelayFrame(valid, 10), /attempt/i);

  const wrongVersion = valid.slice();
  wrongVersion[0] = 2;
  assert.throws(() => parseRelayFrame(wrongVersion, 9), /version/i);

  const wrongKind = valid.slice();
  wrongKind[1] = 255;
  assert.throws(() => parseRelayFrame(wrongKind, 9), /kind/i);

  const wrongCiphertextLength = valid.slice(0, valid.length - 1);
  assert.throws(() => parseRelayFrame(wrongCiphertextLength, 9), /length|ciphertext/i);

  assert.throws(() => parseRelayFrame(new Uint8Array(70 * 1024 + 1), 9), /frame|size/i);
});
