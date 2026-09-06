import test from 'node:test';
import assert from 'node:assert/strict';
import { encodeOpticalFrames, decodeOpticalFrame, OpticalAssembler } from '../../packages/core/optical.js';

test('optical frames round-trip arbitrary bytes', () => {
  const data = Uint8Array.from({ length: 1900 }, (_, i) => (i * 17) & 255);
  const frames = encodeOpticalFrames(data, { streamId: 'A1B2C3D4', payloadBytes: 300 });
  assert.equal(frames.length, 7);
  const assembler = new OpticalAssembler();
  for (const frame of frames) assembler.accept(frame);
  assert.equal(assembler.complete, true);
  assert.deepEqual(assembler.bytes(), data);
});

test('optical assembler deduplicates repeated frames and reports progress', () => {
  const data = new TextEncoder().encode('repeat me '.repeat(80));
  const frames = encodeOpticalFrames(data, { streamId: 'STREAM01', payloadBytes: 128 });
  const assembler = new OpticalAssembler();
  assert.equal(assembler.accept(frames[0]).accepted, true);
  assert.equal(assembler.accept(frames[0]).duplicate, true);
  assert.equal(assembler.received, 1);
  assert.equal(assembler.total, frames.length);
});

test('optical frame rejects corrupted payload by crc', () => {
  const [frame] = encodeOpticalFrames(new TextEncoder().encode('hello'), { streamId: 'STREAM02', payloadBytes: 64 });
  const parsed = decodeOpticalFrame(frame);
  assert.equal(parsed.sequence, 0);
  const corrupted = frame.slice(0, -1) + (frame.endsWith('A') ? 'B' : 'A');
  assert.throws(() => decodeOpticalFrame(corrupted), /CRC/i);
});
