import test from 'node:test';
import assert from 'node:assert/strict';
import { createMemorySink, createReceiveSink, partialStorageKey, partialMetaCompatible } from '../../apps/web/src/storage.js';

const meta = {
  fileId: 'FILE1234',
  name: 'resume.bin',
  size: 6,
  type: 'application/octet-stream',
};

function namedError(name, message) {
  const error = new Error(message);
  error.name = name;
  return error;
}

function notFound(message = 'not found') {
  return namedError('NotFoundError', message);
}

function createFakeOpfs(initialEntries = {}) {
  const entries = new Map(
    Object.entries(initialEntries).map(([name, bytes]) => [name, Uint8Array.from(bytes)]),
  );

  function handleFor(name) {
    return {
      async getFile() {
        const bytes = entries.get(name);
        if (!bytes) throw notFound();
        return new File([bytes], name, { type: 'application/octet-stream' });
      },
      async createWritable({ keepExistingData = false } = {}) {
        let data = keepExistingData && entries.has(name)
          ? entries.get(name).slice()
          : new Uint8Array();
        let position = 0;

        return {
          async seek(nextPosition) { position = nextPosition; },
          async write(value) {
            const bytes = typeof value === 'string'
              ? new TextEncoder().encode(value)
              : value instanceof Uint8Array
                ? value
                : new Uint8Array(value);
            const required = position + bytes.byteLength;
            if (required > data.byteLength) {
              const grown = new Uint8Array(required);
              grown.set(data);
              data = grown;
            }
            data.set(bytes, position);
            position = required;
          },
          async close() { entries.set(name, data.slice()); },
        };
      },
    };
  }

  return {
    entries,
    async getFileHandle(name, { create = false } = {}) {
      if (!entries.has(name)) {
        if (!create) throw notFound();
        entries.set(name, new Uint8Array());
      }
      return handleFor(name);
    },
    async removeEntry(name) {
      if (!entries.delete(name)) throw notFound();
    },
  };
}

function installFakeStorage(t, root) {
  const previousNavigator = globalThis.navigator;
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: { storage: { getDirectory: async () => root } },
  });
  t.after(() => {
    if (previousNavigator === undefined) delete globalThis.navigator;
    else {
      Object.defineProperty(globalThis, 'navigator', {
        configurable: true,
        value: previousNavigator,
      });
    }
  });
}

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

test('fresh OPFS transfer truncates an orphaned stale part when metadata is absent', async (t) => {
  const leaseCode = 'ABCDE-FGHJK';
  const freshMeta = { ...meta, size: 3 };
  const key = partialStorageKey(leaseCode, freshMeta.fileId);
  const root = createFakeOpfs({
    [`${key}.part`]: Uint8Array.of(1, 2, 3, 4, 5, 6, 7, 8, 9),
  });
  installFakeStorage(t, root);

  const sink = await createReceiveSink(freshMeta, { leaseCode, fileId: freshMeta.fileId });
  assert.equal(sink.kind, 'opfs');
  assert.equal(sink.offset, 0);
  await sink.write(Uint8Array.of(7, 8, 9));
  const file = await sink.close();

  assert.equal(file.size, freshMeta.size, 'fresh transfer must not retain stale OPFS tail bytes');
  assert.deepEqual([...new Uint8Array(await file.arrayBuffer())], [7, 8, 9]);
  await sink.cleanup();
});

test('OPFS checkpoints preserve resumable bytes across abrupt page termination', async (t) => {
  const leaseCode = 'ABCDE-FGHJK';
  const checkpointBytes = 1024 * 1024;
  const durableMeta = {
    ...meta,
    fileId: 'DURABLE1',
    name: 'durable.bin',
    size: checkpointBytes * 2,
  };
  const root = createFakeOpfs();
  installFakeStorage(t, root);

  const first = await createReceiveSink(durableMeta, { leaseCode, fileId: durableMeta.fileId });
  await first.write(new Uint8Array(checkpointBytes).fill(0x5a));

  // Deliberately do not close or abort the first sink. A real tab/page can disappear
  // before asynchronous pagehide cleanup finishes, so durable resume must not depend
  // on that lifecycle callback committing the only copy of received bytes.
  const second = await createReceiveSink(durableMeta, { leaseCode, fileId: durableMeta.fileId });
  assert.equal(second.offset, checkpointBytes, 'a completed durability checkpoint must be visible to the next receiver runtime');

  await second.abort({ discard: true });
});

test('malformed OPFS partial metadata fails closed instead of silently resetting resumable state', async (t) => {
  const leaseCode = 'ABCDE-FGHJK';
  const corruptMeta = { ...meta, fileId: 'CORRUPT1' };
  const key = partialStorageKey(leaseCode, corruptMeta.fileId);
  const root = createFakeOpfs({
    [`${key}.json`]: new TextEncoder().encode('{broken-json'),
    [`${key}.part`]: Uint8Array.of(1, 2, 3),
  });
  installFakeStorage(t, root);

  await assert.rejects(
    () => createReceiveSink(corruptMeta, { leaseCode, fileId: corruptMeta.fileId }),
    /metadata|json|persisted/i,
  );
  assert.deepEqual([...root.entries.get(`${key}.part`)], [1, 2, 3], 'corrupt metadata must not authorize destructive reset');
});

test('OPFS access errors fail closed instead of downgrading to memory fallback', async (t) => {
  const leaseCode = 'ABCDE-FGHJK';
  const deniedMeta = { ...meta, fileId: 'DENIED01' };
  const denied = namedError('SecurityError', 'opfs access denied');
  installFakeStorage(t, {
    async getFileHandle() { throw denied; },
    async removeEntry() { throw denied; },
  });

  await assert.rejects(
    () => createReceiveSink(deniedMeta, { leaseCode, fileId: deniedMeta.fileId }),
    /opfs access denied/i,
  );
});

test('OPFS cleanup propagates delete failures instead of reporting successful cleanup', async (t) => {
  const leaseCode = 'ABCDE-FGHJK';
  const cleanupMeta = { ...meta, fileId: 'CLEANUP1' };
  const root = createFakeOpfs();
  installFakeStorage(t, root);

  const sink = await createReceiveSink(cleanupMeta, { leaseCode, fileId: cleanupMeta.fileId });
  root.removeEntry = async () => { throw namedError('NoModificationAllowedError', 'delete denied'); };

  await assert.rejects(() => sink.cleanup(), /delete denied/i);
});
