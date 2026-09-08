const DEFAULT_MEMORY_LIMIT = 512 * 1024 * 1024;
export const OPFS_DURABILITY_CHECKPOINT_BYTES = 1024 * 1024;
const memoryPartials = new Map();

function safePart(value) {
  return String(value ?? '').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 72);
}

export function partialStorageKey(leaseCode, fileId) {
  const lease = safePart(leaseCode);
  const file = safePart(fileId);
  if (!lease || !file) throw new Error('Lease code and fileId are required for resumable storage');
  return `fqr_${lease}_${file}`;
}

export function partialMetaCompatible(left, right) {
  if (!left || !right) return false;
  return left.fileId === right.fileId
    && left.name === right.name
    && left.size === right.size
    && (left.type || 'application/octet-stream') === (right.type || 'application/octet-stream');
}

function normalizeMemoryOptions(limitOrOptions) {
  if (typeof limitOrOptions === 'number') return { limit: limitOrOptions, key: null };
  return {
    limit: limitOrOptions?.limit ?? DEFAULT_MEMORY_LIMIT,
    key: limitOrOptions?.key ?? null,
  };
}

export function createMemorySink(meta, limitOrOptions = DEFAULT_MEMORY_LIMIT) {
  const { limit, key } = normalizeMemoryOptions(limitOrOptions);
  let state = key ? memoryPartials.get(key) : null;
  if (state && !partialMetaCompatible(state.meta, meta)) {
    memoryPartials.delete(key);
    state = null;
  }
  if (!state) {
    state = { meta: { ...meta }, chunks: [], received: 0 };
    if (key) memoryPartials.set(key, state);
  }

  const chunks = state.chunks;
  let received = state.received;
  const sync = () => { state.received = received; };

  return {
    kind: 'memory',
    get offset() { return received; },
    async write(bytes) {
      if (meta.size > limit || received + bytes.byteLength > limit) {
        throw new Error('Browser memory storage is not suitable for this file. Use the native app for large files.');
      }
      if (received + bytes.byteLength > meta.size) throw new Error('Received bytes exceed advertised file size');
      chunks.push(bytes.slice());
      received += bytes.byteLength;
      sync();
    },
    async close() {
      if (received !== meta.size) throw new Error('Received file is incomplete');
      sync();
      return new File(chunks, meta.name, { type: meta.type || 'application/octet-stream', lastModified: Date.now() });
    },
    async abort({ discard = false } = {}) {
      if (key && !discard) {
        sync();
        return;
      }
      chunks.length = 0;
      received = 0;
      sync();
      if (key) memoryPartials.delete(key);
    },
    async cleanup() {
      chunks.length = 0;
      received = 0;
      sync();
      if (key) memoryPartials.delete(key);
    },
  };
}

async function removeEntry(root, name) {
  try { await root.removeEntry(name); } catch { /* already gone */ }
}

async function readPartialMeta(root, name) {
  try {
    const handle = await root.getFileHandle(name);
    const file = await handle.getFile();
    return JSON.parse(await file.text());
  } catch {
    return null;
  }
}

async function writePartialMeta(root, name, meta) {
  const handle = await root.getFileHandle(name, { create: true });
  const writable = await handle.createWritable();
  await writable.write(JSON.stringify(meta));
  await writable.close();
}

async function createOpfsSink(meta, options = {}) {
  const root = await navigator.storage.getDirectory();
  const key = options.key || partialStorageKey(options.leaseCode, meta.fileId || options.fileId);
  const partName = `${key}.part`;
  const metaName = `${key}.json`;
  const checkpointBytes = Number.isSafeInteger(options.checkpointBytes) && options.checkpointBytes > 0
    ? options.checkpointBytes
    : OPFS_DURABILITY_CHECKPOINT_BYTES;
  let savedMeta = await readPartialMeta(root, metaName);
  let existingSize = 0;

  if (savedMeta && !partialMetaCompatible(savedMeta, meta)) {
    await removeEntry(root, partName);
    await removeEntry(root, metaName);
    savedMeta = null;
  }

  let handle;
  if (savedMeta) {
    try {
      handle = await root.getFileHandle(partName);
      const partial = await handle.getFile();
      if (partial.size <= meta.size) existingSize = partial.size;
      else {
        await removeEntry(root, partName);
        await removeEntry(root, metaName);
        handle = null;
        savedMeta = null;
      }
    } catch {
      handle = null;
      savedMeta = null;
    }
  }

  if (!handle) handle = await root.getFileHandle(partName, { create: true });
  if (!savedMeta) await writePartialMeta(root, metaName, { ...meta });

  let received = existingSize;
  let committed = existingSize;
  let writable = null;

  async function ensureWritable() {
    if (writable) return writable;
    writable = await handle.createWritable({ keepExistingData: received > 0 });
    if (received > 0) await writable.seek(received);
    return writable;
  }

  async function checkpointWritable() {
    if (!writable) return;
    const active = writable;
    writable = null;
    await active.close();
    committed = received;
  }

  return {
    kind: 'opfs',
    get offset() { return received; },
    async write(bytes) {
      if (received + bytes.byteLength > meta.size) throw new Error('Received bytes exceed advertised file size');
      const active = await ensureWritable();
      await active.write(bytes);
      received += bytes.byteLength;
      if (received === meta.size || received - committed >= checkpointBytes) {
        await checkpointWritable();
      }
    },
    async close() {
      if (received !== meta.size) throw new Error('Received file is incomplete');
      await checkpointWritable();
      const file = await handle.getFile();
      return new File([file], meta.name, { type: meta.type || file.type || 'application/octet-stream', lastModified: Date.now() });
    },
    async abort({ discard = false } = {}) {
      try { await checkpointWritable(); } catch { /* preserve the last completed checkpoint */ }
      if (discard) {
        await removeEntry(root, partName);
        await removeEntry(root, metaName);
      }
    },
    async cleanup() {
      try { await checkpointWritable(); } catch { /* continue cleanup */ }
      await removeEntry(root, partName);
      await removeEntry(root, metaName);
    },
  };
}

export async function createReceiveSink(meta, options = {}) {
  const key = options.key || (
    options.leaseCode && (meta.fileId || options.fileId)
      ? partialStorageKey(options.leaseCode, meta.fileId || options.fileId)
      : null
  );
  if (typeof navigator !== 'undefined' && navigator.storage?.getDirectory && key) {
    try { return await createOpfsSink(meta, { ...options, key }); } catch { /* fall back to memory */ }
  }
  return createMemorySink(meta, { limit: options.limit ?? DEFAULT_MEMORY_LIMIT, key });
}

export function downloadReceivedFile(file, name = file.name) {
  const url = URL.createObjectURL(file);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = name;
  anchor.rel = 'noopener';
  anchor.style.display = 'none';
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}
