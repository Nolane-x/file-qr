import test from 'node:test';
import assert from 'node:assert/strict';
import { createOpticalBlockStore } from '../../apps/native/src/optical-storage.js';

const BLOCK_BYTES = 65536;
const HASH0 = '11'.repeat(32);
const HASH1 = '22'.repeat(32);

function manifest(overrides = {}) {
  return {
    version: 'FQR2', streamId: '0123456789AB', fileSize: BLOCK_BYTES + 4,
    blockBytes: BLOCK_BYTES, symbolBytes: 768, blockCount: 2,
    name: 'sample.bin', type: 'application/octet-stream', ...overrides,
  };
}

function makeAdapter(events = []) {
  const files = new Map();
  const meta = new Map();
  return {
    events,
    async readMeta(key) { return meta.has(key) ? structuredClone(meta.get(key)) : null; },
    async writeMeta(key, value) { events.push('meta-write'); meta.set(key, structuredClone(value)); },
    async writeDataAt(key, offset, bytes) {
      events.push(`data-write:${offset}:${bytes.byteLength}`);
      const current = files.get(key) || new Uint8Array(0);
      const size = Math.max(current.byteLength, offset + bytes.byteLength);
      const next = new Uint8Array(size); next.set(current); next.set(bytes, offset); files.set(key, next);
    },
    async dataSize(key) { return (files.get(key) || new Uint8Array(0)).byteLength; },
    async readAll(key) { return (files.get(key) || new Uint8Array(0)).slice(); },
    async remove(key) { events.push(`remove:${key}`); files.delete(key); meta.delete(key); },
    snapshotMeta() { return [...meta.values()].map(value => structuredClone(value)); },
  };
}

function installFakeNavigator(root) {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: { storage: { getDirectory: async () => root } },
  });
  return () => {
    if (previous) Object.defineProperty(globalThis, 'navigator', previous);
    else delete globalThis.navigator;
  };
}

test('verified blocks may commit out of order at exact offsets', async () => {
  const events = [];
  const adapter = makeAdapter(events);
  const store = await createOpticalBlockStore(manifest(), { adapter });
  await store.writeVerifiedBlock(1, Uint8Array.from([9,8,7,6]), HASH1);
  assert.equal(store.hasBlock(1), true);
  assert.equal(store.hasBlock(0), false);
  assert.deepEqual(events.slice(-2), ['data-write:65536:4', 'meta-write']);
  await store.writeVerifiedBlock(0, new Uint8Array(BLOCK_BYTES), HASH0);
  const file = await store.finalize();
  const bytes = new Uint8Array(await file.arrayBuffer());
  assert.equal(bytes.byteLength, BLOCK_BYTES + 4);
  assert.deepEqual(bytes.slice(-4), Uint8Array.from([9,8,7,6]));
});

test('sidecar never advances when data write fails', async () => {
  const events = [];
  const adapter = makeAdapter(events);
  adapter.writeDataAt = async () => { events.push('data-fail'); throw new Error('disk failed'); };
  const store = await createOpticalBlockStore(manifest(), { adapter });
  await assert.rejects(() => store.writeVerifiedBlock(0, new Uint8Array(BLOCK_BYTES), HASH0), /disk failed/);
  assert.equal(store.hasBlock(0), false);
  assert.deepEqual(events, ['data-fail']);
});

test('reopen restores only sidecar-committed block progress', async () => {
  const adapter = makeAdapter();
  const first = await createOpticalBlockStore(manifest(), { adapter });
  await first.writeVerifiedBlock(1, Uint8Array.from([1,2,3,4]), HASH1);
  const reopened = await createOpticalBlockStore(manifest(), { adapter });
  assert.equal(reopened.hasBlock(1), true);
  assert.equal(reopened.completedBlocks, 1);
});

test('manifest mismatch and malformed persisted sidecar fail closed', async () => {
  const adapter = makeAdapter();
  const first = await createOpticalBlockStore(manifest(), { adapter });
  await first.writeVerifiedBlock(1, Uint8Array.from([1,2,3,4]), HASH1);
  await assert.rejects(() => createOpticalBlockStore(manifest({ name: 'other.bin' }), { adapter }), /manifest|mismatch/i);
  const bad = makeAdapter();
  bad.readMeta = async () => ({ schema: 1, manifest: manifest(), completed: [{ index: 9999, sha256: HASH1 }] });
  await assert.rejects(() => createOpticalBlockStore(manifest(), { adapter: bad }), /sidecar|block|persisted/i);
});

test('browser OPFS malformed sidecar JSON fails closed without deleting partial data', async () => {
  const removed = [];
  const dataKey = `fqr2_${manifest().streamId}.part`;
  const metaKey = `fqr2_${manifest().streamId}.json`;
  const root = {
    async getFileHandle(key) {
      if (key === metaKey) {
        return { async getFile() { return { async text() { return '{"schema":'; } }; } };
      }
      if (key === dataKey) {
        return { async getFile() { return { size: 4, async arrayBuffer() { return new Uint8Array([1,2,3,4]).buffer; } }; } };
      }
      throw new DOMException('missing', 'NotFoundError');
    },
    async removeEntry(key) { removed.push(key); },
  };
  const restoreNavigator = installFakeNavigator(root);
  try {
    await assert.rejects(() => createOpticalBlockStore(manifest()), /sidecar|JSON|persisted/i);
    assert.deepEqual(removed, [], 'malformed metadata must never downgrade to orphan cleanup');
  } finally {
    restoreNavigator();
  }
});

test('browser OPFS missing sidecar still removes orphan partial data', async () => {
  const removed = [];
  const dataKey = `fqr2_${manifest().streamId}.part`;
  const metaKey = `fqr2_${manifest().streamId}.json`;
  const root = {
    async getFileHandle(key) {
      if (key === metaKey) throw new DOMException('missing', 'NotFoundError');
      if (key === dataKey) return { async getFile() { return { size: 4 }; } };
      throw new DOMException('missing', 'NotFoundError');
    },
    async removeEntry(key) { removed.push(key); },
  };
  const restoreNavigator = installFakeNavigator(root);
  try {
    const store = await createOpticalBlockStore(manifest());
    assert.equal(store.completedBlocks, 0);
    assert.deepEqual(removed, [dataKey]);
  } finally {
    restoreNavigator();
  }
});

test('finalize requires all logical blocks and exact file size', async () => {
  const adapter = makeAdapter();
  const store = await createOpticalBlockStore(manifest(), { adapter });
  await store.writeVerifiedBlock(1, Uint8Array.from([1,2,3,4]), HASH1);
  await assert.rejects(() => store.finalize(), /incomplete|blocks/i);
});

test('large FQR2 receive refuses whole-file memory fallback', async () => {
  await assert.rejects(
    () => createOpticalBlockStore(manifest({ fileSize: 8 * 1024 * 1024 + 1, blockCount: 129 }), { adapter: null }),
    /persistent|OPFS|storage/i,
  );
});
