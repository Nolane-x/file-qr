import test from 'node:test';
import assert from 'node:assert/strict';
import { crc32 } from '../../packages/core/crc32.js';

test('crc32 matches the canonical 123456789 vector', () => {
  assert.equal(crc32(new TextEncoder().encode('123456789')), 0xcbf43926);
});
