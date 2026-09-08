import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

test('native optical receiver enables finite byte and frame assembly budgets', () => {
  const core = fs.readFileSync(new URL('../../packages/core/optical.js', import.meta.url), 'utf8');
  const native = fs.readFileSync(new URL('../../apps/native/src/main.js', import.meta.url), 'utf8');

  assert.match(core, /export const MIN_OPTICAL_PAYLOAD_BYTES = 32;/, 'core must expose the FQR1 minimum payload size used to derive a safe frame budget');
  assert.match(native, /OPTICAL_RECEIVE_MAX_BYTES/, 'native receiver must define a finite receive byte budget');
  assert.match(native, /OPTICAL_RECEIVE_MAX_FRAMES/, 'native receiver must define a finite receive frame budget');
  assert.match(native, /OPTICAL_RECEIVE_MAX_BYTES\s*\/\s*MIN_OPTICAL_PAYLOAD_BYTES/, 'frame budget must be derived from the receive byte budget and protocol minimum payload size');
  assert.match(native, /new OpticalAssembler\(\{[\s\S]*?maxBytes:\s*OPTICAL_RECEIVE_MAX_BYTES,[\s\S]*?maxFrames:\s*OPTICAL_RECEIVE_MAX_FRAMES,[\s\S]*?\}\)/, 'native optical receiver must activate both assembler budgets');
});
