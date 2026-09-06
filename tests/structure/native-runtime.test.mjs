import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

test('optical runtime keeps timeout handle separate from callable stop hook', () => {
  const js = fs.readFileSync(new URL('../../apps/native/src/main.js', import.meta.url), 'utf8');
  assert.ok(js.includes('timer: null'));
  assert.ok(!js.includes('opticalSession.stop = window.setTimeout'));
});

test('optical v0.1 rejects oversized files before reading them into memory', () => {
  const js = fs.readFileSync(new URL('../../apps/native/src/main.js', import.meta.url), 'utf8');
  assert.ok(js.includes('const OPTICAL_MAX_BYTES = 8 * 1024 * 1024'));
  assert.ok(js.includes('file.size > OPTICAL_MAX_BYTES'));
  assert.ok(js.indexOf('file.size > OPTICAL_MAX_BYTES') < js.indexOf('file.arrayBuffer()'));
  assert.ok(js.includes('use Network mode for larger files'));
});
