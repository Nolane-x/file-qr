import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

function read(path) {
  return fs.readFileSync(new URL(path, import.meta.url), 'utf8');
}

test('FQR2 native runtime is block-bounded, version-isolated and single-flight', () => {
  const main = read('../../apps/native/src/main.js');
  const session = read('../../apps/native/src/optical-v2-session.js');
  const storage = read('../../apps/native/src/optical-storage.js');
  const fqr1 = read('../../packages/core/optical.js');
  const all = `${session}\n${storage}`;

  assert.match(fqr1, /export const OPTICAL_VERSION = ['"]FQR1['"]/);
  assert.doesNotMatch(session, /\bfile\.arrayBuffer\(\)/, 'FQR2 sender must never read the whole file');
  assert.match(session, /\.slice\(/, 'FQR2 sender must read bounded slices');
  assert.match(main, /startsWith\(['"]FQR1\|['"]\)/, 'native camera path must route FQR1 explicitly');
  assert.match(main, /startsWith\(['"]FQR2\|['"]\)/, 'native camera path must route FQR2 explicitly');
  assert.doesNotMatch(main, /FQR2[\s\S]{0,300}new OpticalAssembler/, 'FQR2 must not enter the FQR1 assembler');
  assert.match(main, /fqr2AcceptBusy/, 'async FQR2 camera ingestion must be single-flight');
  assert.match(main, /if\s*\(fqr2AcceptBusy\)\s*return/, 'busy camera frames must be dropped instead of queued');
  assert.doesNotMatch(main, /fqr2.*queue|queue.*fqr2/i, 'native path must not build an unbounded FQR2 frame queue');
  assert.match(storage, /8\s*\*\s*1024\s*\*\s*1024|8\s*\*\s*1024\s*\*\s*1024/, 'memory fallback must retain an explicit 8 MiB ceiling');
  assert.doesNotMatch(all, /turn-credentials|SESSION_ALLOCATION_RATE_LIMIT|TURN_CREDENTIAL_RATE_LIMIT|WINDOWS_CERTIFICATE|ANDROID_KEY_BASE64/);
});

test('FQR2 runtime does not inherit the FQR1 ten-minute hard stop', () => {
  const session = read('../../apps/native/src/optical-v2-session.js');
  assert.doesNotMatch(session, /10\s*\*\s*60\s*\*\s*1000|600000|maxAgeMs/);
});

test('FQR2 storage requires durable progress ordering and no large memory fallback', () => {
  const storage = read('../../apps/native/src/optical-storage.js');
  assert.match(storage, /writeDataAt|createWritable/);
  assert.match(storage, /writeMeta|sidecar|metadata/i);
  assert.match(storage, /Large FQR2 receive requires persistent random-access storage/);
});
