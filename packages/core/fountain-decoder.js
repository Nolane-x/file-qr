import {
  FQR2_BLOCK_BYTES,
  FQR2_MAX_SEQ_NUM,
  FQR2_MAX_SOURCE_SYMBOLS,
  sha256Hex,
} from './optical-v2.js';
import { fountainIndexes } from './fountain.js';

const SHA256_RE = /^[0-9a-f]{64}$/;

function bytesEqual(left, right) {
  if (left.byteLength !== right.byteLength) return false;
  for (let i = 0; i < left.byteLength; i++) if (left[i] !== right[i]) return false;
  return true;
}

function isZero(bytes) {
  for (const byte of bytes) if (byte !== 0) return false;
  return true;
}

function xorInto(target, source) {
  for (let i = 0; i < target.byteLength; i++) target[i] ^= source[i];
}

function sameIndexes(left, right) {
  if (left.length !== right.length) return false;
  for (let i = 0; i < left.length; i++) if (left[i] !== right[i]) return false;
  return true;
}

export class Fqr2BlockDecoder {
  #blockLength;
  #symbolBytes;
  #blockSha256;
  #k;
  #solved = new Map();
  #equations = [];
  #recent = new Map();
  #ordinal = 0;
  #verifiedBytes = null;

  constructor({ blockLength, symbolBytes, blockSha256 }) {
    if (!Number.isInteger(blockLength) || blockLength < 0 || blockLength > FQR2_BLOCK_BYTES) {
      throw new Error('FQR2 decoder block length exceeds limit');
    }
    if (!Number.isInteger(symbolBytes) || symbolBytes < 1) throw new Error('FQR2 decoder symbol size is invalid');
    if (!SHA256_RE.test(String(blockSha256 ?? ''))) throw new Error('Malformed FQR2 SHA-256 hash');
    const k = Math.max(1, Math.ceil(blockLength / symbolBytes));
    if (k > FQR2_MAX_SOURCE_SYMBOLS) throw new Error('FQR2 source symbol count exceeds limit');
    this.#blockLength = blockLength;
    this.#symbolBytes = symbolBytes;
    this.#blockSha256 = blockSha256;
    this.#k = k;
  }

  get k() { return this.#k; }
  get complete() { return this.#verifiedBytes !== null; }
  get solvedCount() { return this.#solved.size; }
  get unresolvedEquationCount() { return this.#equations.length; }
  get recentSequenceCount() { return this.#recent.size; }

  reset() {
    this.#solved.clear();
    this.#equations.length = 0;
    this.#recent.clear();
    this.#ordinal = 0;
    this.#verifiedBytes = null;
  }

  #rememberSequence(seqNum) {
    this.#recent.set(seqNum, true);
    const maxRecent = 4 * this.#k;
    while (this.#recent.size > maxRecent) this.#recent.delete(this.#recent.keys().next().value);
  }

  #addSolved(index, payload, queue) {
    const existing = this.#solved.get(index);
    if (existing) {
      if (!bytesEqual(existing, payload)) throw new Error('Inconsistent FQR2 fountain equation');
      return false;
    }
    this.#solved.set(index, payload.slice());
    queue.push(index);
    return true;
  }

  #cascadeSolved(initialIndex, initialPayload) {
    const queue = [];
    this.#addSolved(initialIndex, initialPayload, queue);

    while (queue.length) {
      const solvedIndex = queue.shift();
      const solvedPayload = this.#solved.get(solvedIndex);
      for (let position = this.#equations.length - 1; position >= 0; position--) {
        const equation = this.#equations[position];
        const found = equation.indexes.indexOf(solvedIndex);
        if (found === -1) continue;
        xorInto(equation.payload, solvedPayload);
        equation.indexes.splice(found, 1);

        if (equation.indexes.length === 0) {
          this.#equations.splice(position, 1);
          if (!isZero(equation.payload)) throw new Error('Inconsistent FQR2 fountain equation');
          continue;
        }
        if (equation.indexes.length === 1) {
          this.#equations.splice(position, 1);
          this.#addSolved(equation.indexes[0], equation.payload, queue);
        }
      }
    }
  }

  #retainEquation(indexes, payload) {
    const canonical = [...indexes].sort((a, b) => a - b);
    for (const existing of this.#equations) {
      if (!sameIndexes(existing.indexes, canonical)) continue;
      if (!bytesEqual(existing.payload, payload)) throw new Error('Inconsistent FQR2 fountain equation');
      return false;
    }

    const incoming = { indexes: canonical, payload: payload.slice(), ordinal: this.#ordinal++ };
    const maxEquations = 3 * this.#k;
    if (this.#equations.length < maxEquations) {
      this.#equations.push(incoming);
      return true;
    }

    let worstPosition = 0;
    for (let i = 1; i < this.#equations.length; i++) {
      const candidate = this.#equations[i];
      const worst = this.#equations[worstPosition];
      if (candidate.indexes.length > worst.indexes.length
        || (candidate.indexes.length === worst.indexes.length && candidate.ordinal < worst.ordinal)) {
        worstPosition = i;
      }
    }
    const worst = this.#equations[worstPosition];
    if (incoming.indexes.length > worst.indexes.length) return false;
    this.#equations.splice(worstPosition, 1, incoming);
    return true;
  }

  async #verifyIfComplete() {
    if (this.#solved.size !== this.#k) return;
    const full = new Uint8Array(this.#k * this.#symbolBytes);
    for (let index = 0; index < this.#k; index++) {
      const symbol = this.#solved.get(index);
      if (!symbol) return;
      full.set(symbol, index * this.#symbolBytes);
    }
    const logical = full.slice(0, this.#blockLength);
    const actual = await sha256Hex(logical);
    if (actual !== this.#blockSha256) {
      this.reset();
      throw new Error('FQR2 block SHA-256 mismatch');
    }
    this.#verifiedBytes = logical;
    this.#equations.length = 0;
  }

  async accept(part) {
    if (this.complete) return { accepted: false, duplicate: false, solved: this.solvedCount, complete: true };
    const seqNum = part?.seqNum;
    if (!Number.isInteger(seqNum) || seqNum < 1 || seqNum > FQR2_MAX_SEQ_NUM) {
      throw new Error('FQR2 sequence number exceeds limit');
    }
    const payload = part?.payload;
    if (!(payload instanceof Uint8Array) || payload.byteLength !== this.#symbolBytes) {
      throw new Error('FQR2 decoder payload symbol size mismatch');
    }
    if (this.#recent.has(seqNum)) {
      return { accepted: false, duplicate: true, solved: this.solvedCount, complete: this.complete };
    }

    const indexes = await fountainIndexes({ seqNum, k: this.#k, blockSha256: this.#blockSha256 });
    const reducedIndexes = [];
    const reducedPayload = payload.slice();
    for (const index of indexes) {
      const solved = this.#solved.get(index);
      if (solved) xorInto(reducedPayload, solved);
      else reducedIndexes.push(index);
    }

    try {
      if (reducedIndexes.length === 0) {
        if (!isZero(reducedPayload)) throw new Error('Inconsistent FQR2 fountain equation');
      } else if (reducedIndexes.length === 1) {
        this.#cascadeSolved(reducedIndexes[0], reducedPayload);
      } else {
        this.#retainEquation(reducedIndexes, reducedPayload);
      }
      this.#rememberSequence(seqNum);
      await this.#verifyIfComplete();
    } catch (error) {
      if (/Inconsistent FQR2 fountain equation/.test(String(error?.message))) this.reset();
      throw error;
    }

    return { accepted: true, duplicate: false, solved: this.solvedCount, complete: this.complete };
  }

  bytes() {
    if (!this.complete) throw new Error('FQR2 block is incomplete');
    return this.#verifiedBytes.slice();
  }
}
