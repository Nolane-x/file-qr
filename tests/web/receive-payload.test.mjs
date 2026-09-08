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
});
