import test from 'node:test';
import assert from 'node:assert/strict';
import { compactReceiveCode, createReceiveCode, normalizeReceiveCode, isReceiveCode } from '../../packages/core/session.js';

test('receive code uses ten Crockford base32 characters grouped 5-5', () => {
  const bytes = Uint8Array.from([0,1,2,3,4,5,6,7]);
  const code = createReceiveCode(bytes);
  assert.match(code, /^[0-9A-HJKMNP-TV-Z]{5}-[0-9A-HJKMNP-TV-Z]{5}$/);
  assert.equal(code.length, 11);
});

test('receive code normalization removes separators and ambiguous casing', () => {
  assert.equal(normalizeReceiveCode(' abcd-efghij '), 'ABCDE-FGH1J');
  assert.equal(normalizeReceiveCode('o1il0-23456'), '01110-23456');
});

test('receive code validation rejects malformed codes', () => {
  assert.equal(isReceiveCode('ABCDE-FGHJK'), true);
  assert.equal(isReceiveCode('ABCDE-UKLMN'), false);
  assert.equal(isReceiveCode('SHORT'), false);
});

test('receive code validation rejects overlong aliases instead of truncating to a valid session', () => {
  assert.equal(isReceiveCode('ABCDE-FGHJKX'), false);
  assert.equal(isReceiveCode('ABCDE-FGHJK-EXTRA'), false);
  assert.throws(() => compactReceiveCode('ABCDE-FGHJKX'), /Invalid receive code/);
});
