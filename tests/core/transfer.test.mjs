import test from 'node:test';
import assert from 'node:assert/strict';
import { chunkRanges, encodeControlMessage, decodeControlMessage } from '../../packages/core/transfer.js';

test('chunkRanges partitions a file without gaps', () => {
  assert.deepEqual([...chunkRanges(10, 4)], [[0,4],[4,8],[8,10]]);
});

test('control messages round-trip with explicit protocol version', () => {
  const encoded = encodeControlMessage('meta', { name: 'x.bin', size: 42 });
  const decoded = decodeControlMessage(encoded);
  assert.deepEqual(decoded, { v: 1, type: 'meta', payload: { name: 'x.bin', size: 42 } });
});
