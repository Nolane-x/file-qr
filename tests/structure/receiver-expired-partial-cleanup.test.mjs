import test from 'node:test';
import assert from 'node:assert/strict';
import { readWebRuntimeSource } from '../helpers/web-runtime-source.mjs';

const source = readWebRuntimeSource();

function section(start, end) {
  const from = source.indexOf(start);
  const to = source.indexOf(end, from + start.length);
  assert.notEqual(from, -1, `missing section start: ${start}`);
  assert.notEqual(to, -1, `missing section end: ${end}`);
  return source.slice(from, to);
}

test('receiver failure only preserves a partial while the same lease can still resume', () => {
  const failure = section('async function failTransfer(detail)', 'export function startConnectionTimer()');
  assert.match(failure, /const receiverCanResume = active\.role === 'receiver' && leaseOpen\(\) && !active\.leaseExpired;/);
  assert.match(failure, /discardPartial:\s*!receiverCanResume/);
  assert.match(failure, /receiverCanResume && transferred > 0/);
});

test('lease expiry discards an inactive receiver partial instead of retaining dead resume state', () => {
  const expiry = section('async function handleLeaseExpiry()', 'export async function copyText');
  assert.match(expiry, /cleanupLease\(\{\s*keepView:\s*true,\s*discardPartial:\s*true\s*\}\)/);
});

test('signaling lease closure also discards receiver partials when the lease is no longer usable', () => {
  const receiver = section('async function receiveFile(rawCode, relaySecret = null)', 'async function onScannedPayload');
  assert.match(receiver, /event\.code === 4000 \|\| !leaseOpen\(\)/);
  assert.match(receiver, /cleanupLease\(\{\s*keepView:\s*true,\s*discardPartial:\s*true\s*\}\)/);
});
