import test from 'node:test';
import assert from 'node:assert/strict';
import { sendByteChunks } from '../../apps/web/src/webrtc.js';

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
