import test from 'node:test';
import assert from 'node:assert/strict';

const moduleUrl = new URL('../../apps/web/src/relay-crypto.js', import.meta.url);

async function loadCrypto() {
  try {
    return await import(moduleUrl);
  } catch (error) {
    assert.fail(`relay-crypto.js must exist: ${error?.message || error}`);
  }
}

const SECRET = 'AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8';

function prefix(seed = 1) {
  return Uint8Array.from({ length: 8 }, (_, index) => (seed + index) & 255);
}

test('relay crypto round-trips with direction and attempt bound into the key and AAD', async () => {
  const { createRelayCryptoContext } = await loadCrypto();
  const sender = await createRelayCryptoContext({
    relaySecret: SECRET,
    code: 'ABCDE-FGHJK',
    attemptId: 7,
    direction: 'sender-to-receiver',
    noncePrefix: prefix(10),
  });
  const receiver = await createRelayCryptoContext({
    relaySecret: SECRET,
    code: 'ABCDE-FGHJK',
    attemptId: 7,
    direction: 'sender-to-receiver',
    noncePrefix: prefix(10),
  });

  const plaintext = new Uint8Array([1, 2, 3, 4, 5]);
  const frame = await sender.encrypt('data', plaintext);
  const decoded = await receiver.decrypt(frame);
  assert.equal(decoded.kind, 'data');
  assert.equal(decoded.sequence, 0);
  assert.deepEqual(decoded.plaintext, plaintext);
  assert.equal(sender.nextSequence, 1);
  assert.equal(receiver.expectedSequence, 1);
});

test('relay crypto fails closed on replay and non-monotonic sequence', async () => {
  const { createRelayCryptoContext } = await loadCrypto();
  const sender = await createRelayCryptoContext({ relaySecret: SECRET, code: 'ABCDE-FGHJK', attemptId: 2, direction: 'sender-to-receiver', noncePrefix: prefix(2) });
  const receiver = await createRelayCryptoContext({ relaySecret: SECRET, code: 'ABCDE-FGHJK', attemptId: 2, direction: 'sender-to-receiver', noncePrefix: prefix(2) });

  const first = await sender.encrypt('data', new Uint8Array([1]));
  const second = await sender.encrypt('data', new Uint8Array([2]));
  await receiver.decrypt(first);
  await assert.rejects(() => receiver.decrypt(first), /sequence|replay/i);

  const freshReceiver = await createRelayCryptoContext({ relaySecret: SECRET, code: 'ABCDE-FGHJK', attemptId: 2, direction: 'sender-to-receiver', noncePrefix: prefix(2) });
  await assert.rejects(() => freshReceiver.decrypt(second), /sequence|order/i);
});

test('relay crypto rejects wrong secret, attempt, direction and modified ciphertext or header', async () => {
  const { createRelayCryptoContext } = await loadCrypto();
  const sender = await createRelayCryptoContext({ relaySecret: SECRET, code: 'ABCDE-FGHJK', attemptId: 4, direction: 'sender-to-receiver', noncePrefix: prefix(5) });
  const frame = await sender.encrypt('control', new TextEncoder().encode('hello'));

  const wrongSecret = await createRelayCryptoContext({ relaySecret: 'AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE', code: 'ABCDE-FGHJK', attemptId: 4, direction: 'sender-to-receiver', noncePrefix: prefix(5) });
  await assert.rejects(() => wrongSecret.decrypt(frame), /decrypt|authentication|operation/i);

  const wrongAttempt = await createRelayCryptoContext({ relaySecret: SECRET, code: 'ABCDE-FGHJK', attemptId: 5, direction: 'sender-to-receiver', noncePrefix: prefix(5) });
  await assert.rejects(() => wrongAttempt.decrypt(frame), /attempt|decrypt|authentication/i);

  const wrongDirection = await createRelayCryptoContext({ relaySecret: SECRET, code: 'ABCDE-FGHJK', attemptId: 4, direction: 'receiver-to-sender', noncePrefix: prefix(5) });
  await assert.rejects(() => wrongDirection.decrypt(frame), /decrypt|authentication|operation/i);

  const alteredCiphertext = frame.slice();
  alteredCiphertext[alteredCiphertext.length - 1] ^= 1;
  const receiver1 = await createRelayCryptoContext({ relaySecret: SECRET, code: 'ABCDE-FGHJK', attemptId: 4, direction: 'sender-to-receiver', noncePrefix: prefix(5) });
  await assert.rejects(() => receiver1.decrypt(alteredCiphertext), /decrypt|authentication|operation/i);

  const alteredHeader = frame.slice();
  alteredHeader[9] ^= 1;
  const receiver2 = await createRelayCryptoContext({ relaySecret: SECRET, code: 'ABCDE-FGHJK', attemptId: 4, direction: 'sender-to-receiver', noncePrefix: prefix(5) });
  await assert.rejects(() => receiver2.decrypt(alteredHeader), /length|decrypt|authentication|sequence/i);
});

test('relay crypto refuses nonce sequence exhaustion before uint32 wrap', async () => {
  const { createRelayCryptoContext } = await loadCrypto();
  const context = await createRelayCryptoContext({
    relaySecret: SECRET,
    code: 'ABCDE-FGHJK',
    attemptId: 1,
    direction: 'sender-to-receiver',
    noncePrefix: prefix(1),
    initialSequence: 0xffff_ffff,
  });
  await assert.rejects(() => context.encrypt('data', new Uint8Array([1])), /sequence|exhaust/i);
});
