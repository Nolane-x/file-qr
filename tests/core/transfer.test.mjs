import test from 'node:test';
import assert from 'node:assert/strict';
import { chunkRanges, encodeControlMessage, decodeControlMessage, validateResumeOffset } from '../../packages/core/transfer.js';

test('chunkRanges partitions a file without gaps', () => {
  assert.deepEqual([...chunkRanges(10, 4)], [[0,4],[4,8],[8,10]]);
});

test('control messages round-trip with explicit protocol version 2', () => {
  const encoded = encodeControlMessage('file-offer', { fileId: 'FILE1234', name: 'x.bin', size: 42 });
  const decoded = decodeControlMessage(encoded);
  assert.deepEqual(decoded, {
    v: 2,
    type: 'file-offer',
    payload: { fileId: 'FILE1234', name: 'x.bin', size: 42 },
  });
});

test('resume offset must be an integer within the file', () => {
  assert.equal(validateResumeOffset(0, 100_000), 0);
  assert.equal(validateResumeOffset(65_536, 100_000), 65_536);
  assert.equal(validateResumeOffset(100_000, 100_000), 100_000);
  assert.throws(() => validateResumeOffset(-1, 100), /offset/i);
  assert.throws(() => validateResumeOffset(101, 100), /offset/i);
  assert.throws(() => validateResumeOffset(1.5, 100), /offset/i);
  assert.throws(() => validateResumeOffset(0, -1), /size/i);
});

test('decoder rejects legacy or future protocol versions rather than guessing compatibility', () => {
  assert.throws(() => decodeControlMessage(JSON.stringify({ v: 1, type: 'meta', payload: {} })), /unsupported/i);
  assert.throws(() => decodeControlMessage(JSON.stringify({ v: 3, type: 'file-offer', payload: {} })), /unsupported/i);
});
