import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const moduleUrl = new URL('../../apps/web/src/receive-payload.js', import.meta.url);

test('receive payload parser accepts codes and receive URLs only', async () => {
  assert.ok(fs.existsSync(moduleUrl), 'receive-payload module must exist');
  const { parseReceivePayload } = await import(moduleUrl);
  assert.equal(parseReceivePayload('ABCDE-FGHJK'), 'ABCDE-FGHJK');
  assert.equal(parseReceivePayload('ABCDEFGHJK'), 'ABCDE-FGHJK');
  assert.equal(parseReceivePayload('https://fileqr.nolane-file.workers.dev/?receive=ABCDEFGHJK'), 'ABCDE-FGHJK');
  assert.equal(parseReceivePayload('https://example.com/path?receive=ABCDE-FGHJK'), 'ABCDE-FGHJK');
  assert.equal(parseReceivePayload('https://example.com/path#receive=ABCDE-FGHJK'), 'ABCDE-FGHJK');
  assert.equal(parseReceivePayload('https://example.com/path'), null);
  assert.equal(parseReceivePayload('https://example.com/?receive=bad'), null);
  assert.equal(parseReceivePayload('not a code'), null);
});

test('receive URL parser rejects overlong receive-code aliases before normalization', async () => {
  assert.ok(fs.existsSync(moduleUrl), 'receive-payload module must exist');
  const { parseReceivePayload } = await import(moduleUrl);
  assert.equal(parseReceivePayload('ABCDE-FGHJKX'), null);
  assert.equal(parseReceivePayload('https://example.com/?receive=ABCDE-FGHJKX'), null);
  assert.equal(parseReceivePayload('https://example.com/?receive=ABCDE-FGHJK-EXTRA'), null);
  assert.equal(parseReceivePayload('https://example.com/#receive=ABCDE-FGHJKX'), null);
});

test('structured receive payload keeps QR relay secret in URL fragment so HTTP requests cannot carry it', async () => {
  const {
    buildReceivePayloadUrl,
    parseReceivePayload,
    parseReceivePayloadDetails,
  } = await import(moduleUrl);

  const secret = 'A'.repeat(43);
  const built = buildReceivePayloadUrl('https://fileqr.example/send?old=1', 'ABCDEFGHJK', secret);
  assert.equal(built, `https://fileqr.example/send#receive=ABCDE-FGHJK&relay=${secret}`);
  const url = new URL(built);
  assert.equal(url.search, '', 'structured receive payload must not put relay authority in the HTTP query');
  assert.equal(url.searchParams.has('relay'), false);
  assert.equal(url.hash.includes(secret), true);
  assert.deepEqual(parseReceivePayloadDetails(built), {
    code: 'ABCDE-FGHJK',
    relaySecret: secret,
  });
  assert.equal(parseReceivePayload(built), 'ABCDE-FGHJK');
  assert.deepEqual(parseReceivePayloadDetails('ABCDE-FGHJK'), {
    code: 'ABCDE-FGHJK',
    relaySecret: null,
  });
});

test('structured receive payload rejects query-carried or malformed relay secrets instead of silently downgrading', async () => {
  const { parseReceivePayloadDetails } = await import(moduleUrl);
  const validSecret = 'A'.repeat(43);
  assert.equal(
    parseReceivePayloadDetails(`https://fileqr.example/?receive=ABCDE-FGHJK&relay=${validSecret}`),
    null,
    'relay secrets in query strings must be rejected because query strings are sent to the HTTP origin',
  );
  for (const relay of [
    '',
    'A'.repeat(42),
    'A'.repeat(44),
    `${'A'.repeat(42)}=`,
    `${'A'.repeat(42)}+`,
    `${'A'.repeat(42)}/`,
  ]) {
    const url = `https://fileqr.example/#receive=ABCDE-FGHJK&relay=${encodeURIComponent(relay)}`;
    assert.equal(parseReceivePayloadDetails(url), null);
  }
});

test('relay secret generator consumes exactly 32 random bytes and returns unpadded base64url', async () => {
  const { generateRelaySecret } = await import(moduleUrl);
  let requested = 0;
  const secret = generateRelaySecret((bytes) => {
    requested = bytes.length;
    for (let index = 0; index < bytes.length; index += 1) bytes[index] = index;
  });
  assert.equal(requested, 32);
  assert.match(secret, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(secret.includes('='), false);
});
