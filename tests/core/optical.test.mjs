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

test('optical assembler rejects payload bytes beyond its configured receive budget', () => {
  const data = Uint8Array.from({ length: 200 }, (_, i) => i & 255);
  const frames = encodeOpticalFrames(data, { streamId: 'STREAM03', payloadBytes: 100 });
  const assembler = new OpticalAssembler({ maxBytes: 150 });

  assert.equal(assembler.accept(frames[0]).accepted, true);
  assert.throws(() => assembler.accept(frames[1]), /receive byte limit/i);
  assert.equal(assembler.received, 1, 'rejected frame must not be retained');
});

test('optical assembler rejects streams beyond its configured frame budget', () => {
  const [frame] = encodeOpticalFrames(new Uint8Array(32), { streamId: 'STREAM04', payloadBytes: 32 });
  const parts = frame.split('|');
  parts[3] = '3';
  const oversizedDeclaration = parts.join('|');
  const assembler = new OpticalAssembler({ maxFrames: 2 });

  assert.throws(() => assembler.accept(oversizedDeclaration), /frame limit/i);
  assert.equal(assembler.received, 0, 'rejected stream must not initialize assembler state');
});
