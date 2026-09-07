import test from 'node:test';
import assert from 'node:assert/strict';
import { sendByteChunks, streamFileOverChannel } from '../../apps/web/src/webrtc.js';
import { decodeControlMessage } from '../../packages/core/transfer.js';

test('sendByteChunks sends ordered chunks and honors bufferedAmount backpressure', async () => {
  const sent = [];
  const listeners = new Map();
  const channel = {
    bufferedAmount: 2_000_000,
    bufferedAmountLowThreshold: 0,
    readyState: 'open',
    send(value) { sent.push(new Uint8Array(value)); },
    addEventListener(name, fn) { listeners.set(name, fn); },
    removeEventListener(name) { listeners.delete(name); }
  };
  setTimeout(() => {
    channel.bufferedAmount = 0;
    listeners.get('bufferedamountlow')?.();
  }, 5);
  const bytes = Uint8Array.from({ length: 10 }, (_, i) => i);
  await sendByteChunks(bytes, channel, { chunkSize: 4, highWaterMark: 1024 });
  assert.deepEqual(sent.map(x => [...x]), [[0,1,2,3],[4,5,6,7],[8,9]]);
  assert.equal(channel.bufferedAmountLowThreshold, 512);
});

test('streamFileOverChannel resumes from an absolute byte offset', async () => {
  const slices = [];
  const sent = [];
  const progress = [];
  const file = {
    name: 'resume.bin',
    type: 'application/octet-stream',
    size: 10,
    slice(start, end) {
      slices.push([start, end]);
      const bytes = Uint8Array.from({ length: end - start }, (_, index) => start + index);
      return { async arrayBuffer() { return bytes.buffer; } };
    },
  };
  const channel = {
    bufferedAmount: 0,
    readyState: 'open',
    send(value) { sent.push(value); },
    addEventListener() {},
    removeEventListener() {},
  };

  await streamFileOverChannel(file, channel, {
    fileId: 'FILE1234',
    offset: 4,
    chunkSize: 3,
    onProgress(done, total) { progress.push([done, total]); },
  });

  assert.deepEqual(slices, [[4, 7], [7, 10]]);
  assert.deepEqual(progress, [[7, 10], [10, 10]]);
  const finalControl = decodeControlMessage(sent.at(-1));
  assert.deepEqual(finalControl, {
    v: 2,
    type: 'transfer-complete',
    payload: { fileId: 'FILE1234', size: 10 },
  });
});
