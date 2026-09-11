import { FQR2_MAX_SEQ_NUM, FQR2_MAX_SOURCE_SYMBOLS } from './optical-v2.js';

const MASK64 = 0xffffffffffffffffn;
const SHA256_RE = /^[0-9a-f]{64}$/;

function rotl64(value, bits) {
  const shift = BigInt(bits);
  return ((value << shift) | (value >> (64n - shift))) & MASK64;
}

function readU64be(bytes, offset) {
  let value = 0n;
  for (let i = 0; i < 8; i++) value = (value << 8n) | BigInt(bytes[offset + i]);
  return value;
}

function requireSeed(seedBytes) {
  const seed = seedBytes instanceof Uint8Array ? seedBytes : new Uint8Array(seedBytes ?? 0);
  if (seed.byteLength !== 32) throw new Error('xoshiro256** seed must be exactly 32 bytes');
  return seed;
}

export function createXoshiro256ss(seedBytes) {
  const seed = requireSeed(seedBytes);
  const state = [0, 8, 16, 24].map(offset => readU64be(seed, offset));
  if (state.every(value => value === 0n)) state[3] = 0x9e3779b97f4a7c15n;

  return function next() {
    const result = (rotl64((state[1] * 5n) & MASK64, 7) * 9n) & MASK64;
    const t = (state[1] << 17n) & MASK64;

    state[2] ^= state[0];
    state[3] ^= state[1];
    state[1] ^= state[2];
    state[0] ^= state[3];
    state[2] ^= t;
    state[3] = rotl64(state[3], 45);

    state[0] &= MASK64;
    state[1] &= MASK64;
    state[2] &= MASK64;
    state[3] &= MASK64;
    return result;
  };
}

function requireSelectorInput({ seqNum, k, blockSha256 }) {
  if (!Number.isInteger(seqNum) || seqNum < 1 || seqNum > FQR2_MAX_SEQ_NUM) {
    throw new Error('FQR2 sequence number exceeds limit');
  }
  if (!Number.isInteger(k) || k < 1 || k > FQR2_MAX_SOURCE_SYMBOLS) {
    throw new Error('FQR2 source symbol count exceeds limit');
  }
  if (!SHA256_RE.test(String(blockSha256 ?? ''))) throw new Error('Malformed FQR2 SHA-256 hash');
}

async function selectorPrng(seqNum, blockSha256) {
  const material = new Uint8Array(8);
  new DataView(material.buffer).setUint32(0, seqNum, false);
  for (let i = 0; i < 4; i++) material[4 + i] = Number.parseInt(blockSha256.slice(i * 2, i * 2 + 2), 16);
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', material));
  return createXoshiro256ss(digest);
}

function selectHarmonicDegree(next, k) {
  let total = 0;
  const cumulative = new Array(k);
  for (let degree = 1; degree <= k; degree++) {
    total += 1 / degree;
    cumulative[degree - 1] = total;
  }
  const u = Number(next() >> 11n) / 2 ** 53;
  const target = u * total;
  for (let i = 0; i < cumulative.length; i++) if (cumulative[i] > target) return i + 1;
  return k;
}

export async function fountainIndexes({ seqNum, k, blockSha256 }) {
  requireSelectorInput({ seqNum, k, blockSha256 });
  if (seqNum <= k) return [seqNum - 1];

  const next = await selectorPrng(seqNum, blockSha256);
  const degree = selectHarmonicDegree(next, k);
  const indexes = Array.from({ length: k }, (_, index) => index);
  for (let position = 0; position < degree; position++) {
    const remaining = k - position;
    const selected = position + Number(next() % BigInt(remaining));
    [indexes[position], indexes[selected]] = [indexes[selected], indexes[position]];
  }
  return indexes.slice(0, degree);
}

export function splitSourceSymbols(input, symbolBytes) {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input ?? 0);
  if (!Number.isInteger(symbolBytes) || symbolBytes < 1) throw new Error('FQR2 symbol size must be a positive integer');
  const count = Math.max(1, Math.ceil(bytes.byteLength / symbolBytes));
  if (count > FQR2_MAX_SOURCE_SYMBOLS) throw new Error('FQR2 source symbol count exceeds limit');
  const symbols = [];
  for (let index = 0; index < count; index++) {
    const symbol = new Uint8Array(symbolBytes);
    const start = index * symbolBytes;
    symbol.set(bytes.subarray(start, Math.min(bytes.byteLength, start + symbolBytes)));
    symbols.push(symbol);
  }
  return symbols;
}

export function xorSymbols(sourceSymbols, indexes) {
  if (!Array.isArray(sourceSymbols) || sourceSymbols.length < 1 || sourceSymbols.length > FQR2_MAX_SOURCE_SYMBOLS) {
    throw new Error('FQR2 source symbols are required');
  }
  if (!Array.isArray(indexes) || indexes.length < 1) throw new Error('FQR2 fountain indexes are required');
  const width = sourceSymbols[0]?.byteLength;
  if (!Number.isInteger(width) || width < 1) throw new Error('FQR2 source symbol size is invalid');
  const out = new Uint8Array(width);
  const seen = new Set();
  for (const index of indexes) {
    if (!Number.isInteger(index) || index < 0 || index >= sourceSymbols.length || seen.has(index)) {
      throw new Error('FQR2 fountain index is invalid');
    }
    seen.add(index);
    const symbol = sourceSymbols[index];
    if (!(symbol instanceof Uint8Array) || symbol.byteLength !== width) throw new Error('FQR2 source symbols must have equal width');
    for (let offset = 0; offset < width; offset++) out[offset] ^= symbol[offset];
  }
  return out;
}

export async function encodeFountainPart({ sourceSymbols, seqNum, blockSha256 }) {
  if (!Array.isArray(sourceSymbols) || sourceSymbols.length < 1 || sourceSymbols.length > FQR2_MAX_SOURCE_SYMBOLS) {
    throw new Error('FQR2 source symbols are required');
  }
  const width = sourceSymbols[0]?.byteLength;
  if (!Number.isInteger(width) || width < 1 || sourceSymbols.some(symbol => !(symbol instanceof Uint8Array) || symbol.byteLength !== width)) {
    throw new Error('FQR2 source symbols must have equal width');
  }
  const indexes = await fountainIndexes({ seqNum, k: sourceSymbols.length, blockSha256 });
  return { indexes, payload: xorSymbols(sourceSymbols, indexes) };
}
