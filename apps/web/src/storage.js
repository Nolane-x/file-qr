const DEFAULT_MEMORY_LIMIT = 512 * 1024 * 1024;

export function createMemorySink(meta, limit = DEFAULT_MEMORY_LIMIT) {
  const chunks = [];
  let received = 0;
  return {
    kind: 'memory',
    async write(bytes) {
      if (meta.size > limit || received + bytes.byteLength > limit) {
        throw new Error('Browser memory storage is not suitable for this file. Use the native app for large files.');
      }
      chunks.push(bytes.slice());
      received += bytes.byteLength;
    },
    async close() {
      return new File(chunks, meta.name, { type: meta.type || 'application/octet-stream', lastModified: Date.now() });
    },
    async abort() { chunks.length = 0; received = 0; },
  };
}

async function createOpfsSink(meta) {
  const root = await navigator.storage.getDirectory();
  const entryName = `file-qr-${crypto.randomUUID()}.part`;
  const handle = await root.getFileHandle(entryName, { create: true });
  const writable = await handle.createWritable();
  let closed = false;
  return {
    kind: 'opfs',
    async write(bytes) { await writable.write(bytes); },
    async close() {
      if (!closed) { await writable.close(); closed = true; }
      const file = await handle.getFile();
      return new File([file], meta.name, { type: meta.type || file.type || 'application/octet-stream', lastModified: Date.now() });
    },
    async abort() {
      if (!closed) {
        try { await writable.abort(); } catch { /* no-op */ }
        closed = true;
      }
      try { await root.removeEntry(entryName); } catch { /* already gone */ }
    },
    async cleanup() { try { await root.removeEntry(entryName); } catch { /* already gone */ } },
  };
}

export async function createReceiveSink(meta) {
  if (typeof navigator !== 'undefined' && navigator.storage?.getDirectory) {
    try { return await createOpfsSink(meta); } catch { /* fall back to memory */ }
  }
  return createMemorySink(meta);
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
