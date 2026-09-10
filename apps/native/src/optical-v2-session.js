import {
  FQR2_BLOCK_BYTES,
  FQR2_DEFAULT_SYMBOL_BYTES,
  FQR2_MAX_SEQ_NUM,
  decodeFqr2Manifest,
  decodeFqr2Part,
  encodeFqr2Manifest,
  encodeFqr2Part,
  sha256Hex,
} from '../../../packages/core/optical-v2.js';
import { encodeFountainPart, splitSourceSymbols } from '../../../packages/core/fountain.js';
import { Fqr2BlockDecoder } from '../../../packages/core/fountain-decoder.js';
import { createOpticalBlockStore } from './optical-storage.js';

const STREAM_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

function randomStreamId() {
  const random = crypto.getRandomValues(new Uint8Array(12));
  return [...random].map(byte => STREAM_ALPHABET[byte & 31]).join('');
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

export function createFqr2Broadcaster(file, options = {}) {
  if (!file || !Number.isSafeInteger(file.size) || file.size < 0 || typeof file.slice !== 'function') {
    throw new Error('FQR2 broadcaster requires a sliceable file');
  }
  const streamId = options.streamId || randomStreamId();
  const symbolBytes = options.symbolBytes ?? FQR2_DEFAULT_SYMBOL_BYTES;
  const emitFrame = options.emitFrame ?? (async () => {});
  const yieldControl = options.yieldControl ?? (async () => {});
  const manifestFrame = encodeFqr2Manifest({
    streamId,
    fileSize: file.size,
    symbolBytes,
    name: file.name || 'file.bin',
    type: file.type || 'application/octet-stream',
  });
  const manifest = decodeFqr2Manifest(manifestFrame);
  let visits = 0;
  let stopped = false;
  let currentBlockIndex = 0;
  let currentCycle = 0;

  async function visitOneBlock() {
    if (stopped) return false;
    const blockIndex = visits % manifest.blockCount;
    const cycle = Math.floor(visits / manifest.blockCount);
    currentBlockIndex = blockIndex;
    currentCycle = cycle;
    await emitFrame(manifestFrame, { kind: 'manifest', blockIndex, cycle, manifest });
    if (stopped) return false;

    const start = blockIndex * FQR2_BLOCK_BYTES;
    const end = Math.min(file.size, start + FQR2_BLOCK_BYTES);
    const block = new Uint8Array(await file.slice(start, end).arrayBuffer());
    const blockSha256 = await sha256Hex(block);
    const sourceSymbols = splitSourceSymbols(block, manifest.symbolBytes);
    const k = sourceSymbols.length;

    for (let localIndex = 0; localIndex < k; localIndex++) {
      if (stopped) return false;
      const seqNum = cycle * k + localIndex + 1;
      if (!Number.isSafeInteger(seqNum) || seqNum > FQR2_MAX_SEQ_NUM) {
        stopped = true;
        throw new Error('FQR2 sequence number exhausted');
      }
      const encoded = await encodeFountainPart({ sourceSymbols, seqNum, blockSha256 });
      const partFrame = encodeFqr2Part({
        streamId: manifest.streamId,
        blockIndex,
        seqNum,
        seqLen: k,
        blockLength: block.byteLength,
        blockSha256,
        payload: encoded.payload,
      });
      await emitFrame(partFrame, { kind: 'part', blockIndex, cycle, seqNum, k, manifest });
      await yieldControl();
    }
    visits += 1;
    return true;
  }

  return {
    manifest,
    get blockIndex() { return currentBlockIndex; },
    get cycle() { return currentCycle; },
    get blockCount() { return manifest.blockCount; },
    get stopped() { return stopped; },
    stop() { stopped = true; },
    async runVisits(count) {
      if (!Number.isInteger(count) || count < 0) throw new Error('FQR2 visit count must be a non-negative integer');
      for (let index = 0; index < count && !stopped; index++) await visitOneBlock();
    },
    async run() {
      while (!stopped) await visitOneBlock();
    },
  };
}

export function createFqr2Receiver(options = {}) {
  const openStore = options.openStore ?? createOpticalBlockStore;
  let manifest = null;
  let store = null;
  let activeBlockIndex = null;
  let activeBlockSha256 = null;
  let decoder = null;
  let finalizedFile = null;
  let stopped = false;

  async function acceptManifest(frame) {
    const parsed = decodeFqr2Manifest(frame);
    if (manifest) {
      if (!sameManifest(manifest, parsed)) throw new Error('FQR2 manifest conflict');
      return { accepted: false, duplicate: true, manifest };
    }
    manifest = parsed;
    store = await openStore(manifest);
    return { accepted: true, duplicate: false, manifest };
  }

  async function acceptPart(frame) {
    if (!manifest || !store) return { accepted: false, reason: 'manifest-required' };
    const part = decodeFqr2Part(frame, manifest);
    if (store.hasBlock(part.blockIndex)) return { accepted: false, reason: 'block-complete' };

    if (activeBlockIndex !== null && part.blockIndex !== activeBlockIndex) {
      return { accepted: false, reason: 'other-block-active' };
    }
    if (activeBlockIndex === null) {
      activeBlockIndex = part.blockIndex;
      activeBlockSha256 = part.blockSha256;
      decoder = new Fqr2BlockDecoder({
        blockLength: part.blockLength,
        symbolBytes: manifest.symbolBytes,
        blockSha256: part.blockSha256,
      });
    } else if (part.blockSha256 !== activeBlockSha256) {
      throw new Error('FQR2 active block hash conflict');
    }

    let result;
    try {
      result = await decoder.accept({ seqNum: part.seqNum, payload: part.payload });
    } catch (error) {
      if (/block SHA-256 mismatch/i.test(String(error?.message))) {
        activeBlockIndex = null;
        activeBlockSha256 = null;
        decoder = null;
      }
      throw error;
    }

    if (!decoder.complete) {
      return {
        ...result,
        blockIndex: activeBlockIndex,
        completedBlocks: store.completedBlocks,
        blockCount: manifest.blockCount,
      };
    }

    const completedIndex = activeBlockIndex;
    const completedHash = activeBlockSha256;
    const bytes = decoder.bytes();
    await store.writeVerifiedBlock(completedIndex, bytes, completedHash);
    activeBlockIndex = null;
    activeBlockSha256 = null;
    decoder = null;

    if (store.completedBlocks === manifest.blockCount) finalizedFile = await store.finalize();
    return {
      accepted: true,
      duplicate: false,
      blockIndex: completedIndex,
      blockComplete: true,
      complete: finalizedFile !== null,
      completedBlocks: store.completedBlocks,
      blockCount: manifest.blockCount,
      file: finalizedFile,
    };
  }

  return {
    get manifest() { return manifest; },
    get activeBlockIndex() { return activeBlockIndex; },
    get bufferedOtherBlockCount() { return 0; },
    get completedBlocks() { return store?.completedBlocks ?? 0; },
    get complete() { return finalizedFile !== null; },
    get file() { return finalizedFile; },
    get activeSolvedSymbols() { return decoder?.solvedCount ?? 0; },
    get activeSourceSymbols() { return decoder?.k ?? 0; },
    async accept(frame) {
      if (stopped) return { accepted: false, reason: 'stopped' };
      const text = String(frame);
      if (text.startsWith('FQR2|M|')) return acceptManifest(text);
      if (text.startsWith('FQR2|P|')) return acceptPart(text);
      return { accepted: false, reason: 'unsupported-frame' };
    },
    async stop({ discard = false } = {}) {
      stopped = true;
      activeBlockIndex = null;
      activeBlockSha256 = null;
      decoder = null;
      if (store) await store.abort({ discard });
    },
    async cleanup() {
      stopped = true;
      activeBlockIndex = null;
      activeBlockSha256 = null;
      decoder = null;
      if (store) await store.cleanup();
    },
  };
}
