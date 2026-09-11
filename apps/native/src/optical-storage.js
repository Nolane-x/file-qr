import {
  FQR2_BLOCK_BYTES,
  FQR2_MAX_BLOCKS,
  FQR2_MAX_FILE_BYTES,
  FQR2_MAX_SYMBOL_BYTES,
  FQR2_MIN_SYMBOL_BYTES,
  expectedBlockGeometry,
} from '../../../packages/core/optical-v2.js';

const MEMORY_FALLBACK_MAX_BYTES = 8 * 1024 * 1024;
const STREAM_ID_RE = /^[0-9A-HJKMNP-TV-Z]{12}$/;
const SHA256_RE = /^[0-9a-f]{64}$/;
const SIDECAR_SCHEMA = 1;

function normalizeManifest(manifest) {
  if (!manifest || manifest.version !== 'FQR2' || !STREAM_ID_RE.test(String(manifest.streamId ?? ''))) {
    throw new Error('Invalid FQR2 manifest for block storage');
  }
  if (!Number.isSafeInteger(manifest.fileSize) || manifest.fileSize < 0 || manifest.fileSize > FQR2_MAX_FILE_BYTES) {
    throw new Error('Invalid FQR2 manifest file size');
  }
  if (manifest.blockBytes !== FQR2_BLOCK_BYTES) throw new Error('Invalid FQR2 manifest block geometry');
  if (!Number.isInteger(manifest.symbolBytes)
    || manifest.symbolBytes < FQR2_MIN_SYMBOL_BYTES
    || manifest.symbolBytes > FQR2_MAX_SYMBOL_BYTES) {
    throw new Error('Invalid FQR2 manifest symbol geometry');
  }
  const expectedBlocks = Math.max(1, Math.ceil(manifest.fileSize / FQR2_BLOCK_BYTES));
  if (!Number.isInteger(manifest.blockCount)
    || manifest.blockCount !== expectedBlocks
    || manifest.blockCount < 1
    || manifest.blockCount > FQR2_MAX_BLOCKS) {
    throw new Error('Invalid FQR2 manifest block count');
  }
  if (typeof manifest.name !== 'string' || typeof manifest.type !== 'string') throw new Error('Invalid FQR2 manifest metadata');
  const normalized = {
    version: 'FQR2',
    streamId: manifest.streamId,
    fileSize: manifest.fileSize,
    blockBytes: manifest.blockBytes,
    symbolBytes: manifest.symbolBytes,
    blockCount: manifest.blockCount,
    name: manifest.name,
    type: manifest.type,
  };
  expectedBlockGeometry(normalized, normalized.blockCount - 1);
  return normalized;
}

function sameManifest(left, right) {
  return left.version === right.version
    && left.streamId === right.streamId
    && left.fileSize === right.fileSize
    && left.blockBytes === right.blockBytes
    && left.symbolBytes === right.symbolBytes
    && left.blockCount === right.blockCount
    && left.name === right.name
    && left.type === right.type;
}

function validateCommittedEntry(entry, manifest) {
  if (!entry || !Number.isInteger(entry.index) || entry.index < 0 || entry.index >= manifest.blockCount) {
    throw new Error('Invalid FQR2 persisted sidecar block index');
  }
  if (!SHA256_RE.test(String(entry.sha256 ?? ''))) throw new Error('Invalid FQR2 persisted sidecar block hash');
  return { index: entry.index, sha256: entry.sha256 };
}

function sidecarFor(manifest, completed) {
  return {
    schema: SIDECAR_SCHEMA,
    manifest: { ...manifest },
    completed: [...completed.entries()]
      .sort(([left], [right]) => left - right)
      .map(([index, sha256]) => ({ index, sha256 })),
  };
}

function createMemoryAdapter() {
  const data = new Map();
  const metadata = new Map();
  return {
    kind: 'memory',
    async readMeta(key) { return metadata.has(key) ? structuredClone(metadata.get(key)) : null; },
    async writeMeta(key, value) { metadata.set(key, structuredClone(value)); },
    async writeDataAt(key, offset, bytes) {
      const current = data.get(key) || new Uint8Array(0);
      const length = Math.max(current.byteLength, offset + bytes.byteLength);
      const next = new Uint8Array(length);
      next.set(current);
      next.set(bytes, offset);
      data.set(key, next);
    },
    async dataSize(key) { return (data.get(key) || new Uint8Array(0)).byteLength; },
    async readAll(key) { return (data.get(key) || new Uint8Array(0)).slice(); },
    async remove(key) { data.delete(key); metadata.delete(key); },
  };
}

async function createBrowserOpfsAdapter() {
  if (typeof navigator === 'undefined' || !navigator.storage?.getDirectory) return null;
  let root;
  try { root = await navigator.storage.getDirectory(); }
  catch { return null; }

  async function getFileHandle(key, create = false) {
    return root.getFileHandle(key, { create });
  }

  return {
    kind: 'opfs',
    async readMeta(key) {
      let handle;
      try {
        handle = await getFileHandle(key, false);
      } catch (error) {
        if (error?.name === 'NotFoundError') return null;
        throw error;
      }
      const text = await (await handle.getFile()).text();
      try {
        return JSON.parse(text);
      } catch {
        throw new Error('Invalid FQR2 persisted sidecar JSON');
      }
    },
    async writeMeta(key, value) {
      const handle = await getFileHandle(key, true);
      const writable = await handle.createWritable();
      await writable.write(JSON.stringify(value));
      await writable.close();
    },
    async writeDataAt(key, offset, bytes) {
      const handle = await getFileHandle(key, true);
      const writable = await handle.createWritable({ keepExistingData: true });
      await writable.seek(offset);
      await writable.write(bytes);
      await writable.close();
    },
    async dataSize(key) {
      try {
        return (await (await getFileHandle(key, false)).getFile()).size;
      } catch (error) {
        if (error?.name === 'NotFoundError') return 0;
        throw error;
      }
    },
    async readAll(key) {
      const file = await (await getFileHandle(key, false)).getFile();
      return new Uint8Array(await file.arrayBuffer());
    },
    async getFile(key) { return (await getFileHandle(key, false)).getFile(); },
    async remove(key) {
      try {
        await root.removeEntry(key);
      } catch (error) {
        if (error?.name !== 'NotFoundError') throw error;
      }
    },
  };
}

function makeFile(parts, name, type) {
  if (typeof File !== 'undefined') return new File(parts, name, { type: type || 'application/octet-stream', lastModified: Date.now() });
  const blob = new Blob(parts, { type: type || 'application/octet-stream' });
  blob.name = name;
  return blob;
}

export async function createOpticalBlockStore(inputManifest, options = {}) {
  const manifest = normalizeManifest(inputManifest);
  let adapter;
  if (Object.prototype.hasOwnProperty.call(options, 'adapter')) adapter = options.adapter;
  else adapter = await createBrowserOpfsAdapter();

  if (!adapter) {
    if (manifest.fileSize > MEMORY_FALLBACK_MAX_BYTES) {
      throw new Error('Large FQR2 receive requires persistent random-access storage');
    }
    adapter = createMemoryAdapter();
  }

  for (const method of ['readMeta', 'writeMeta', 'writeDataAt', 'dataSize', 'readAll', 'remove']) {
    if (typeof adapter[method] !== 'function') throw new Error('Invalid FQR2 storage adapter');
  }

  const baseKey = `fqr2_${manifest.streamId}`;
  const dataKey = `${baseKey}.part`;
  const metaKey = `${baseKey}.json`;
  const completed = new Map();
  const saved = await adapter.readMeta(metaKey);

  if (saved !== null) {
    if (!saved || saved.schema !== SIDECAR_SCHEMA || !saved.manifest || !Array.isArray(saved.completed)) {
      throw new Error('Invalid FQR2 persisted sidecar state');
    }
    const savedManifest = normalizeManifest(saved.manifest);
    if (!sameManifest(savedManifest, manifest)) throw new Error('FQR2 persisted manifest mismatch');
    for (const rawEntry of saved.completed) {
      const entry = validateCommittedEntry(rawEntry, manifest);
      if (completed.has(entry.index)) throw new Error('Invalid FQR2 persisted sidecar duplicate block');
      const geometry = expectedBlockGeometry(manifest, entry.index);
      const durableSize = await adapter.dataSize(dataKey);
      if (durableSize < entry.index * FQR2_BLOCK_BYTES + geometry.blockLength) {
        throw new Error('Invalid FQR2 persisted sidecar data boundary');
      }
      completed.set(entry.index, entry.sha256);
    }
  } else if (await adapter.dataSize(dataKey) > 0) {
    await adapter.remove(dataKey);
  }

  return {
    kind: adapter.kind || 'custom',
    manifest: { ...manifest },
    hasBlock(index) { return completed.has(index); },
    get completedBlocks() { return completed.size; },

    async writeVerifiedBlock(index, inputBytes, blockSha256) {
      const geometry = expectedBlockGeometry(manifest, index);
      const bytes = inputBytes instanceof Uint8Array ? inputBytes : new Uint8Array(inputBytes ?? 0);
      if (bytes.byteLength !== geometry.blockLength) throw new Error('FQR2 verified block length mismatch');
      if (!SHA256_RE.test(String(blockSha256 ?? ''))) throw new Error('Malformed FQR2 verified block SHA-256');
      const existing = completed.get(index);
      if (existing) {
        if (existing !== blockSha256) throw new Error('FQR2 committed block hash conflict');
        return { committed: false, duplicate: true };
      }

      const offset = index * FQR2_BLOCK_BYTES;
      await adapter.writeDataAt(dataKey, offset, bytes);
      const nextCompleted = new Map(completed);
      nextCompleted.set(index, blockSha256);
      await adapter.writeMeta(metaKey, sidecarFor(manifest, nextCompleted));
      completed.set(index, blockSha256);
      return { committed: true, duplicate: false };
    },

    async finalize() {
      if (completed.size !== manifest.blockCount) throw new Error('FQR2 receive is incomplete; all blocks are required');
      const size = await adapter.dataSize(dataKey);
      if (size !== manifest.fileSize) throw new Error('FQR2 finalized file size mismatch');
      if (typeof adapter.getFile === 'function') {
        const file = await adapter.getFile(dataKey);
        if (file.size !== manifest.fileSize) throw new Error('FQR2 finalized file size mismatch');
        return makeFile([file], manifest.name, manifest.type);
      }
      const bytes = await adapter.readAll(dataKey);
      if (bytes.byteLength !== manifest.fileSize) throw new Error('FQR2 finalized file size mismatch');
      return makeFile([bytes], manifest.name, manifest.type);
    },

    async abort({ discard = false } = {}) {
      if (!discard) return;
      await adapter.remove(dataKey);
      await adapter.remove(metaKey);
      completed.clear();
    },

    async cleanup() {
      await adapter.remove(dataKey);
      await adapter.remove(metaKey);
      completed.clear();
    },
  };
}
