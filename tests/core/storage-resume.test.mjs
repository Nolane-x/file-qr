import test from 'node:test';
import assert from 'node:assert/strict';
import { createMemorySink, partialStorageKey, partialMetaCompatible } from '../../apps/web/src/storage.js';

const meta = {
  fileId: 'FILE1234',
  name: 'resume.bin',
  size: 6,
  type: 'application/octet-stream',
};

test('partial identity is deterministic and filesystem-safe', () => {
  const a = partialStorageKey('ABCDE-FGHJK', 'FILE1234');
  const b = partialStorageKey('ABCDE-FGHJK', 'FILE1234');
  assert.equal(a, b);
  assert.match(a, /^[a-zA-Z0-9_-]+$/);
  assert.notEqual(a, partialStorageKey('ABCDE-FGHJK', 'OTHER999'));
});

test('partial metadata must match the same file identity', () => {
  assert.equal(partialMetaCompatible(meta, { ...meta }), true);
  assert.equal(partialMetaCompatible(meta, { ...meta, size: 7 }), false);
  assert.equal(partialMetaCompatible(meta, { ...meta, fileId: 'OTHER999' }), false);
  assert.equal(partialMetaCompatible(meta, { ...meta, name: 'other.bin' }), false);
});

test('memory partial resumes inside the same runtime and completes in order', async () => {
  const key = partialStorageKey('ABCDE-FGHJK', meta.fileId);
  const first = createMemorySink(meta, { limit: 32, key });
  assert.equal(first.offset, 0);
  await first.write(Uint8Array.of(1, 2, 3));
  await first.abort();

  const second = createMemorySink(meta, { limit: 32, key });
  assert.equal(second.offset, 3);
  await second.write(Uint8Array.of(4, 5, 6));
  const file = await second.close();
  assert.deepEqual([...new Uint8Array(await file.arrayBuffer())], [1, 2, 3, 4, 5, 6]);
  await second.cleanup();

  const third = createMemorySink(meta, { limit: 32, key });
  assert.equal(third.offset, 0, 'successful cleanup removes resumable partial state');
  await third.abort({ discard: true });
});

test('explicit discard removes a retryable memory partial', async () => {
  const key = partialStorageKey('ABCDE-FGHJK', 'DISCARD1');
  const first = createMemorySink({ ...meta, fileId: 'DISCARD1' }, { limit: 32, key });
  await first.write(Uint8Array.of(9, 8));
  await first.abort({ discard: true });
  const second = createMemorySink({ ...meta, fileId: 'DISCARD1' }, { limit: 32, key });
  assert.equal(second.offset, 0);
  await second.abort({ discard: true });
});
