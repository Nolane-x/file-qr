import test from 'node:test';
import assert from 'node:assert/strict';
import { createMemorySink } from '../../apps/web/src/storage.js';

test('memory sink preserves received bytes in order', async () => {
  const sink = createMemorySink({ name: 'x.bin', size: 5, type: 'application/octet-stream' }, 10);
  await sink.write(Uint8Array.of(1, 2));
  await sink.write(Uint8Array.of(3, 4, 5));
  const file = await sink.close();
  assert.equal(file.name, 'x.bin');
  assert.deepEqual([...new Uint8Array(await file.arrayBuffer())], [1, 2, 3, 4, 5]);
});

test('memory sink refuses payloads beyond its safety limit', async () => {
  const sink = createMemorySink({ name: 'x.bin', size: 11, type: 'application/octet-stream' }, 10);
  await assert.rejects(() => sink.write(Uint8Array.of(1)), /native app/i);
});
