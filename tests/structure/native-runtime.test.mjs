import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

test('optical runtime keeps timeout handle separate from callable stop hook', () => {
  const js = fs.readFileSync(new URL('../../apps/native/src/main.js', import.meta.url), 'utf8');
  assert.ok(js.includes('timer: null'));
  assert.ok(!js.includes('opticalSession.stop = window.setTimeout'));
});
