import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('../../apps/web/src/main.js', import.meta.url), 'utf8');

function section(start, end) {
  const from = source.indexOf(start);
  const to = source.indexOf(end, from + start.length);
  assert.notEqual(from, -1, `missing section start: ${start}`);
  assert.notEqual(to, -1, `missing section end: ${end}`);
  return source.slice(from, to);
}

test('receiver failure only preserves a partial while the same lease can still resume', () => {
  const failure = section('async function failTransfer(detail)', 'function startConnectionTimer()');
  assert.match(failure, /const receiverCanResume = current\.role === 'receiver' && leaseOpen\(\) && !current\.leaseExpired;/);
  assert.match(failure, /discardPartial:\s*!receiverCanResume/);
  assert.match(failure, /receiverCanResume && transferred > 0/);
});

test('lease expiry discards an inactive receiver partial instead of retaining dead resume state', () => {
  const expiry = section('async function handleLeaseExpiry()', 'async function copyText');
  assert.match(expiry, /cleanupLease\(\{\s*keepView:\s*true,\s*discardPartial:\s*true\s*\}\)/);
});

test('signaling lease closure also discards receiver partials when no data channel remains open', () => {
  const receiver = section('async function receiveFile(rawCode)', 'async function onScannedPayload');
  assert.match(receiver, /cleanupLease\(\{\s*keepView:\s*true,\s*discardPartial:\s*true\s*\}\)/);
});
