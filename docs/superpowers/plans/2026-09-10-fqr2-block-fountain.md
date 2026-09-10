# FQR2 Block-Fountain Optical Transport Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an experimental FQR2 offline optical transport that uses bounded 64 KiB blocks, deterministic LT-style fountain repair, SHA-256 block verification, and random-access persistent receive storage while preserving the existing FQR1 path unchanged.

**Architecture:** Keep FQR1 in `packages/core/optical.js` untouched. Add focused FQR2 core modules for frame grammar and deterministic fountain coding, a bounded decoder, a native optical block-storage module, and a native FQR2 session/orchestrator module. The native entrypoint routes exact `FQR1|` and `FQR2|` prefixes and reuses the existing QR renderer/camera surface without changing signaling, TURN, WebRTC, signing, release governance, or repository governance.

**Tech Stack:** JavaScript ES modules, Node `node:test`, Web Crypto SHA-256, BigInt xoshiro256**, Base64URL, CRC32, OPFS File System Access API, Tauri/Vite native webview, existing `qr` renderer and `qr/dom.js` camera APIs.

**Spec:** `docs/superpowers/specs/2026-09-10-fqr2-block-fountain-design.md`

## Global Constraints

- Preserve FQR1 byte-for-byte and keep `FQR1|STREAM_ID|SEQUENCE|TOTAL|CRC32|BASE64URL_PAYLOAD` unchanged.
- `FQR2_BLOCK_BYTES = 64 * 1024` and FQR2 v0.2 accepts no other block size.
- `FQR2_DEFAULT_SYMBOL_BYTES = 768`, `FQR2_MIN_SYMBOL_BYTES = 256`, `FQR2_MAX_SYMBOL_BYTES = 900`.
- `FQR2_MAX_SOURCE_SYMBOLS = 256`, `FQR2_MAX_FILE_BYTES = 64 * 1024 * 1024`, `FQR2_MAX_BLOCKS = 1024`.
- `FQR2_MAX_METADATA_BYTES = 2048` UTF-8 bytes and `FQR2_MAX_SEQ_NUM = 0xffffffff`.
- One active decoder block only; unresolved equations are bounded to `3 * K`; recent sequence identities are bounded to `4 * K`.
- CRC32 is a fast per-frame corruption filter; SHA-256 verifies reconstructed block integrity; neither authenticates the sender.
- Sender may hold one 64 KiB file block plus coding state, but may not call whole-file `file.arrayBuffer()` or precompute all FQR2 frames.
- Receiver may use memory fallback only for `FILE_SIZE <= 8 MiB`; larger FQR2 receives require OPFS/equivalent random-access persistence.
- No new npm dependency for FQR2.
- No signaling, TURN, publisher-signing, release-governance, branch-protection, or package-version changes.
- Keep package version `0.4.0` during this work.
- No throughput, distance, universal-camera, or production-readiness claim without physical evidence.
- First implementation PR must preserve a test-only hosted RED commit before production implementation.

---

## File Structure

### Core protocol
- Create `packages/core/optical-v2.js` — FQR2 constants, Base64URL helpers local to FQR2, manifest encoder/parser, part encoder/parser, geometry validation, SHA-256 helpers.
- Create `packages/core/fountain.js` — xoshiro256**, harmonic degree selection, deterministic source-index selection, source-symbol splitting/padding, systematic/mixed part creation.
- Create `packages/core/fountain-decoder.js` — one-block bounded peeling/XOR decoder with deterministic equation eviction and bounded sequence cache.
- Keep `packages/core/optical.js` unchanged except only if an export-only compatibility helper is proven necessary; default plan is zero changes.

### Native optical runtime
- Create `apps/native/src/optical-storage.js` — FQR2 random-access OPFS store and <=8 MiB memory fallback.
- Create `apps/native/src/optical-v2-session.js` — block-cyclic FQR2 sender and one-active-block FQR2 receiver orchestration, dependency-injected for tests.
- Modify `apps/native/src/main.js` — exact FQR1/FQR2 routing and UI wiring only; keep network/WebRTC code untouched.
- Modify `apps/native/index.html` only if a minimal version selector/status element is required; prefer reusing existing QR Stream controls.

### Tests
- Create `tests/core/optical-v2.test.mjs`.
- Create `tests/core/fountain.test.mjs`.
- Create `tests/core/fountain-decoder.test.mjs`.
- Create `tests/native/optical-storage.test.mjs`.
- Create `tests/native/optical-v2-session.test.mjs`.
- Create `tests/structure/optical-v2-runtime.test.mjs`.
- Preserve `tests/core/optical.test.mjs` unchanged as the FQR1 compatibility sentinel.

### Documentation
- Modify `docs/architecture/PROTOCOL.md` only after exact-head implementation verification.
- Modify `README.md` only after exact-head implementation verification, retaining experimental/no-throughput language.

---

### Task 1: Establish the hosted RED contract

**Files:**
- Create: `tests/core/optical-v2.test.mjs`
- Create: `tests/core/fountain.test.mjs`
- Create: `tests/core/fountain-decoder.test.mjs`
- Create: `tests/native/optical-storage.test.mjs`
- Create: `tests/native/optical-v2-session.test.mjs`
- Create: `tests/structure/optical-v2-runtime.test.mjs`

**Interfaces:**
- Consumes: FQR2 design spec only.
- Produces: executable behavioral contracts for modules that intentionally do not exist yet.

- [ ] **Step 1: Write the failing protocol tests**

Create `tests/core/optical-v2.test.mjs` with imports that intentionally fail until Task 2 exists:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  FQR2_BLOCK_BYTES,
  FQR2_MAX_FILE_BYTES,
  encodeFqr2Manifest,
  decodeFqr2Manifest,
  encodeFqr2Part,
  decodeFqr2Part,
} from '../../packages/core/optical-v2.js';

test('FQR2 manifest round-trips fixed v0.2 geometry', () => {
  const frame = encodeFqr2Manifest({
    streamId: '0123456789AB',
    fileSize: 131073,
    symbolBytes: 768,
    name: 'sample.bin',
    type: 'application/octet-stream',
  });
  const decoded = decodeFqr2Manifest(frame);
  assert.equal(decoded.blockBytes, FQR2_BLOCK_BYTES);
  assert.equal(decoded.blockCount, 3);
  assert.equal(decoded.fileSize, 131073);
  assert.equal(decoded.name, 'sample.bin');
});

test('FQR2 manifest handles a zero-byte stream as one logical block', () => {
  const decoded = decodeFqr2Manifest(encodeFqr2Manifest({
    streamId: '0123456789AB', fileSize: 0, symbolBytes: 768,
    name: 'empty.bin', type: 'application/octet-stream',
  }));
  assert.equal(decoded.blockCount, 1);
});

test('FQR2 manifest rejects file and geometry abuse before state creation', () => {
  assert.throws(() => encodeFqr2Manifest({
    streamId: '0123456789AB', fileSize: FQR2_MAX_FILE_BYTES + 1,
    symbolBytes: 768, name: 'x', type: 'application/octet-stream',
  }), /file size/i);
});

test('FQR2 part round-trips an exact symbol and rejects CRC corruption', () => {
  const payload = Uint8Array.from({ length: 768 }, (_, i) => i & 255);
  const frame = encodeFqr2Part({
    streamId: '0123456789AB', blockIndex: 0, seqNum: 1,
    seqLen: 86, blockLength: 65536,
    blockSha256: '11'.repeat(32), payload,
  });
  assert.deepEqual(decodeFqr2Part(frame).payload, payload);
  const bad = frame.slice(0, -1) + (frame.endsWith('A') ? 'B' : 'A');
  assert.throws(() => decodeFqr2Part(bad), /CRC|payload/i);
});
```

- [ ] **Step 2: Write deterministic fountain and decoder RED tests**

Create vectors that lock xoshiro state transition, systematic selection, mixed selection, lossy recovery, equation cap, sequence cache cap, duplicate behavior, and inconsistent degree-zero rejection. Use fixed hash `00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff` and small `K=4`/`K=8` vectors so expected indexes/payloads are explicit in the test file rather than generated by production code.

Representative shape:

```js
import { fountainIndexes, encodeFountainPart } from '../../packages/core/fountain.js';
import { Fqr2BlockDecoder } from '../../packages/core/fountain-decoder.js';

test('systematic sequence numbers map one-to-one', () => {
  assert.deepEqual(fountainIndexes({ seqNum: 1, k: 4, blockSha256: HASH }), [0]);
  assert.deepEqual(fountainIndexes({ seqNum: 4, k: 4, blockSha256: HASH }), [3]);
});

test('bounded decoder recovers after omitted systematic symbols using repairs', async () => {
  const decoder = new Fqr2BlockDecoder({ blockLength: 16, symbolBytes: 4, blockSha256: EXPECTED_SHA });
  for (const part of LOSSY_PARTS) await decoder.accept(part);
  assert.equal(decoder.complete, true);
  assert.deepEqual(decoder.bytes(), EXPECTED_BYTES);
});

test('decoder remains bounded under thousands of unique repair identities', async () => {
  const decoder = new Fqr2BlockDecoder({ blockLength: 65536, symbolBytes: 768, blockSha256: HASH });
  for (let seqNum = 1000; seqNum < 5000; seqNum++) await decoder.accept(makeValidRepair(seqNum));
  assert.ok(decoder.unresolvedEquationCount <= 3 * decoder.k);
  assert.ok(decoder.recentSequenceCount <= 4 * decoder.k);
});
```

- [ ] **Step 3: Write storage RED tests using an in-memory fake OPFS adapter**

Do not require Node to implement OPFS. Define the production storage module so filesystem calls are adapter-injected in tests. The RED tests require exact-offset writes, data-before-sidecar ordering, reopen validation, exact-size finalize, and >8 MiB memory refusal.

```js
import { createOpticalBlockStore } from '../../apps/native/src/optical-storage.js';

test('verified blocks commit data before sidecar progress', async () => {
  const events = [];
  const fs = makeFakeOpfs(events);
  const store = await createOpticalBlockStore(MANIFEST, { opfs: fs });
  await store.writeVerifiedBlock(1, BLOCK_BYTES, BLOCK_SHA);
  assert.deepEqual(events.slice(-4), ['data-write:65536', 'data-close', 'meta-write', 'meta-close']);
  assert.equal(store.hasBlock(1), true);
});

test('large receive refuses whole-file memory fallback', async () => {
  await assert.rejects(
    () => createOpticalBlockStore({ ...MANIFEST, fileSize: 8 * 1024 * 1024 + 1 }, { opfs: null }),
    /persistent|OPFS|storage/i,
  );
});
```

- [ ] **Step 4: Write native sender/receiver orchestration RED tests**

Require dependency injection for file slicing, hashing, frame emission, store opening, and decoder construction so memory behavior is observable without a camera.

```js
import { createFqr2Broadcaster, createFqr2Receiver } from '../../apps/native/src/optical-v2-session.js';

test('broadcaster reads one block at a time and never whole-file arrayBuffer', async () => {
  const slices = [];
  const file = makeFileSpy({ size: 3 * 65536 + 7, slices });
  const broadcaster = createFqr2Broadcaster(file, { emitFrame: async () => {}, yieldControl: async () => {} });
  await broadcaster.runVisits(4);
  assert.deepEqual(slices, [[0,65536],[65536,131072],[131072,196608],[196608,196615]]);
  assert.equal(file.wholeArrayBufferCalls, 0);
});

test('receiver routes FQR2 parts into one active block only', async () => {
  const receiver = createFqr2Receiver({ openStore: fakeStoreFactory });
  await receiver.accept(MANIFEST_FRAME);
  await receiver.accept(BLOCK_2_PART);
  await receiver.accept(BLOCK_3_PART);
  assert.equal(receiver.activeBlockIndex, 1);
  assert.equal(receiver.bufferedOtherBlockCount, 0);
});
```

- [ ] **Step 5: Write structural RED tests**

`tests/structure/optical-v2-runtime.test.mjs` must read `apps/native/src/main.js` and future FQR2 modules and assert:

```js
assert.doesNotMatch(sessionSource, /file\.arrayBuffer\(\)/);
assert.match(mainSource, /startsWith\(['"]FQR1\|['"]\)/);
assert.match(mainSource, /startsWith\(['"]FQR2\|['"]\)/);
assert.doesNotMatch(mainSource, /FQR2[\s\S]*new OpticalAssembler/);
assert.doesNotMatch(allChangedProductionSource, /turn-credentials|SESSION_ALLOCATION_RATE_LIMIT|WINDOWS_CERTIFICATE|ANDROID_KEY_BASE64/);
```

- [ ] **Step 6: Commit test-only RED**

```bash
git add tests/core/optical-v2.test.mjs tests/core/fountain.test.mjs tests/core/fountain-decoder.test.mjs tests/native/optical-storage.test.mjs tests/native/optical-v2-session.test.mjs tests/structure/optical-v2-runtime.test.mjs
git commit -m "test: define FQR2 block-fountain contract"
```

Push this commit before adding production modules. Open/update the implementation PR and preserve this SHA in the PR body.

- [ ] **Step 7: Verify hosted RED is intentional**

Expected hosted `npm test`: existing FQR1 and repository tests remain green; new FQR2 files fail because `optical-v2.js`, `fountain.js`, `fountain-decoder.js`, `optical-storage.js`, and `optical-v2-session.js` do not yet exist. Audit/install failures or unrelated existing-test failures are not an acceptable RED.

---

### Task 2: Implement strict FQR2 frame grammar and geometry

**Files:**
- Create: `packages/core/optical-v2.js`
- Test: `tests/core/optical-v2.test.mjs`

**Interfaces:**
- Produces:
  - `FQR2_BLOCK_BYTES`, `FQR2_DEFAULT_SYMBOL_BYTES`, `FQR2_MIN_SYMBOL_BYTES`, `FQR2_MAX_SYMBOL_BYTES`, `FQR2_MAX_SOURCE_SYMBOLS`, `FQR2_MAX_FILE_BYTES`, `FQR2_MAX_BLOCKS`, `FQR2_MAX_METADATA_BYTES`, `FQR2_MAX_SEQ_NUM`.
  - `encodeFqr2Manifest(input): string`.
  - `decodeFqr2Manifest(frame): Manifest`.
  - `encodeFqr2Part(input): string`.
  - `decodeFqr2Part(frame, manifest?): Part`.
  - `sha256Hex(bytes): Promise<string>`.
  - `expectedBlockGeometry(manifest, blockIndex): { blockLength, k }`.

- [ ] **Step 1: Run only protocol RED tests**

```bash
node --test tests/core/optical-v2.test.mjs
```

Expected: FAIL because `packages/core/optical-v2.js` is missing.

- [ ] **Step 2: Implement exact constants and reusable validators**

Use strict decimal parsing rather than permissive `Number()` coercion:

```js
export const FQR2_BLOCK_BYTES = 64 * 1024;
export const FQR2_DEFAULT_SYMBOL_BYTES = 768;
export const FQR2_MIN_SYMBOL_BYTES = 256;
export const FQR2_MAX_SYMBOL_BYTES = 900;
export const FQR2_MAX_SOURCE_SYMBOLS = 256;
export const FQR2_MAX_FILE_BYTES = 64 * 1024 * 1024;
export const FQR2_MAX_BLOCKS = 1024;
export const FQR2_MAX_METADATA_BYTES = 2048;
export const FQR2_MAX_SEQ_NUM = 0xffffffff;

function parseBoundedUint(text, label, max) {
  if (!/^(0|[1-9][0-9]*)$/.test(text)) throw new Error(`Malformed ${label}`);
  const value = Number(text);
  if (!Number.isSafeInteger(value) || value > max) throw new Error(`${label} exceeds limit`);
  return value;
}
```

- [ ] **Step 3: Implement manifest encode/decode**

Validate field count and numeric bounds before Base64URL decode. Re-encode metadata through UTF-8 JSON containing only `name` and `type`. Require exact block count:

```js
const expectedBlocks = Math.max(1, Math.ceil(fileSize / FQR2_BLOCK_BYTES));
if (blockBytes !== FQR2_BLOCK_BYTES || blockCount !== expectedBlocks) {
  throw new Error('FQR2 manifest geometry mismatch');
}
```

- [ ] **Step 4: Implement part encode/decode**

Require exact payload length `symbolBytes` when a manifest is supplied, strict lowercase 64-hex SHA-256, strict 8-hex CRC32, and exact final-block geometry via `expectedBlockGeometry()`.

- [ ] **Step 5: Implement SHA-256 helper with Web Crypto**

```js
export async function sha256Hex(bytes) {
  const input = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', input));
  return [...digest].map(b => b.toString(16).padStart(2, '0')).join('');
}
```

- [ ] **Step 6: Run protocol tests**

```bash
node --test tests/core/optical-v2.test.mjs
```

Expected: PASS including malformed field count, metadata bound, zero-byte geometry, CRC corruption, SHA syntax, block/index bounds, and sequence maximum tests.

- [ ] **Step 7: Commit**

```bash
git add packages/core/optical-v2.js tests/core/optical-v2.test.mjs
git commit -m "feat: add strict FQR2 frame grammar"
```

---

### Task 3: Implement deterministic fountain coding

**Files:**
- Create: `packages/core/fountain.js`
- Test: `tests/core/fountain.test.mjs`

**Interfaces:**
- Consumes: `sha256Hex`-compatible SHA-256 seed derivation and FQR2 `symbolBytes`/`blockSha256` values.
- Produces:
  - `createXoshiro256ss(seedBytes): () => bigint`.
  - `fountainIndexes({ seqNum, k, blockSha256 }): Promise<number[]>`.
  - `splitSourceSymbols(blockBytes, symbolBytes): Uint8Array[]`.
  - `xorSymbols(symbols, indexes): Uint8Array`.
  - `encodeFountainPart({ sourceSymbols, seqNum, blockSha256 }): Promise<{ indexes, payload }>`.

- [ ] **Step 1: Run fountain tests and confirm RED**

```bash
node --test tests/core/fountain.test.mjs
```

Expected: FAIL because `fountain.js` is missing.

- [ ] **Step 2: Implement endian-stable xoshiro256\*\***

```js
const MASK64 = 0xffffffffffffffffn;
const rotl64 = (x, k) => ((x << BigInt(k)) | (x >> BigInt(64 - k))) & MASK64;

function readU64be(bytes, offset) {
  let out = 0n;
  for (let i = 0; i < 8; i++) out = (out << 8n) | BigInt(bytes[offset + i]);
  return out;
}

export function createXoshiro256ss(seedBytes) {
  const state = [0, 8, 16, 24].map(offset => readU64be(seedBytes, offset));
  if (state.every(v => v === 0n)) state[3] = 0x9e3779b97f4a7c15n;
  return () => {
    const result = (rotl64((state[1] * 5n) & MASK64, 7) * 9n) & MASK64;
    const t = (state[1] << 17n) & MASK64;
    state[2] ^= state[0]; state[3] ^= state[1]; state[1] ^= state[2]; state[0] ^= state[3];
    state[2] ^= t; state[3] = rotl64(state[3], 45);
    state[0] &= MASK64; state[1] &= MASK64; state[2] &= MASK64; state[3] &= MASK64;
    return result;
  };
}
```

- [ ] **Step 3: Implement selector seed derivation**

Build exactly 8 bytes: 4-byte big-endian `SEQ_NUM` followed by the first 4 decoded bytes of `BLOCK_SHA256`, SHA-256 that seed, then initialize xoshiro.

- [ ] **Step 4: Implement harmonic degree and partial Fisher-Yates**

```js
function selectDegree(next, k) {
  let total = 0;
  const cumulative = [];
  for (let d = 1; d <= k; d++) { total += 1 / d; cumulative.push(total); }
  const u = Number(next() >> 11n) / 2 ** 53;
  const target = u * total;
  return cumulative.findIndex(v => v > target) + 1;
}
```

For `seqNum <= k`, return `[seqNum - 1]` without PRNG use. For mixed parts, shuffle only enough positions to select the chosen degree.

- [ ] **Step 5: Implement fixed-width symbol split and XOR**

Zero-pad only the final logical symbol. Do not mutate caller-owned source symbol arrays.

- [ ] **Step 6: Lock deterministic vectors**

Run:

```bash
node --test tests/core/fountain.test.mjs
```

Expected: PASS for exact xoshiro outputs, harmonic degrees, selected indexes, mixed payload bytes, systematic mapping, uniqueness of selected indexes, `K=1`, and invalid `seqNum/k/hash` rejection.

- [ ] **Step 7: Commit**

```bash
git add packages/core/fountain.js tests/core/fountain.test.mjs
git commit -m "feat: add deterministic FQR2 fountain encoder"
```

---

### Task 4: Implement the bounded one-block fountain decoder

**Files:**
- Create: `packages/core/fountain-decoder.js`
- Test: `tests/core/fountain-decoder.test.mjs`

**Interfaces:**
- Consumes: `fountainIndexes()` and validated part objects from Tasks 2–3.
- Produces `Fqr2BlockDecoder` with:
  - constructor `{ blockLength, symbolBytes, blockSha256 }`.
  - `accept(part): Promise<{ accepted, duplicate, solved, complete }>`.
  - getters `k`, `complete`, `solvedCount`, `unresolvedEquationCount`, `recentSequenceCount`.
  - `bytes(): Uint8Array` only after verified completion.
  - `reset(): void`.

- [ ] **Step 1: Run decoder tests and confirm RED**

```bash
node --test tests/core/fountain-decoder.test.mjs
```

- [ ] **Step 2: Implement bounded state containers**

Use `Map<number, Uint8Array>` for solved symbols, an array for unresolved equations, and insertion-ordered `Map<number, true>` for the recent sequence cache. After every accepted new sequence:

```js
while (recent.size > 4 * k) recent.delete(recent.keys().next().value);
```

- [ ] **Step 3: Implement equation reduction and promotion**

Each incoming equation is copied before mutation. XOR solved indexes out. Degree zero with non-zero payload returns rejection and does not mutate retained equations. Degree one promotes a symbol and recursively reduces all retained equations until no further degree-one equation exists.

- [ ] **Step 4: Implement deterministic equation eviction**

When `equations.length === 3 * k`, find the highest remaining degree; among ties evict the lowest insertion ordinal. If the incoming equation has a greater degree than the selected eviction candidate and does not immediately solve/reduce state, discard the incoming equation instead.

- [ ] **Step 5: Verify SHA-256 before marking complete**

After all `K` symbols are solved, concatenate fixed-width symbols, trim to `blockLength`, compute SHA-256, and only then set `complete=true`. On hash mismatch call `reset()` and throw `FQR2 block SHA-256 mismatch`.

- [ ] **Step 6: Run decoder stress/loss tests**

```bash
node --test tests/core/fountain-decoder.test.mjs
```

Expected: PASS for deterministic lossy recovery, duplicate suppression, inconsistent degree-zero rejection, thousands-of-sequences bounds, equation eviction, hash-mismatch reset, and zero-byte logical block.

- [ ] **Step 7: Run all core optical tests**

```bash
node --test tests/core/optical.test.mjs tests/core/optical-v2.test.mjs tests/core/fountain.test.mjs tests/core/fountain-decoder.test.mjs
```

Expected: all PASS; FQR1 test file remains unmodified.

- [ ] **Step 8: Commit**

```bash
git add packages/core/fountain-decoder.js tests/core/fountain-decoder.test.mjs
git commit -m "feat: add bounded FQR2 fountain decoder"
```

---

### Task 5: Add crash-safe random-access optical storage

**Files:**
- Create: `apps/native/src/optical-storage.js`
- Test: `tests/native/optical-storage.test.mjs`

**Interfaces:**
- Produces `createOpticalBlockStore(manifest, options): Promise<store>`.
- Store exposes `hasBlock(index)`, `writeVerifiedBlock(index, bytes, blockSha256)`, `completedBlocks`, `finalize()`, `abort({ discard })`, `cleanup()`.
- `options.opfs` accepts an adapter in tests; production adapter wraps `navigator.storage.getDirectory()`.

- [ ] **Step 1: Run storage tests and confirm RED**

```bash
node --test tests/native/optical-storage.test.mjs
```

- [ ] **Step 2: Implement manifest identity and sidecar validation**

Persist only immutable validated fields plus committed block hashes. Reopen requires exact equality for stream ID, file size, fixed block bytes, symbol bytes, block count, file name, and MIME type. Reject unknown schema versions and invalid block indexes/hash syntax.

- [ ] **Step 3: Implement OPFS exact-offset writes**

For block `index`, seek to `index * FQR2_BLOCK_BYTES`; write only already-verified bytes. Close the data writable before writing sidecar progress. Do not mark in-memory `completed` until sidecar close succeeds.

- [ ] **Step 4: Implement bounded memory fallback**

For `fileSize <= 8 * 1024 * 1024`, use a fixed block map bounded by the admitted file size. For larger files with unavailable OPFS:

```js
throw new Error('Large FQR2 receive requires persistent random-access storage');
```

- [ ] **Step 5: Implement finalize exactness**

Require every logical block committed and exact final byte count. The OPFS backend verifies the `.part` file size equals `manifest.fileSize`; the memory backend concatenates only the exact logical block lengths.

- [ ] **Step 6: Verify crash ordering and reopen tests**

```bash
node --test tests/native/optical-storage.test.mjs
```

Expected: PASS for out-of-order writes, data-before-sidecar ordering, sidecar failure not advancing progress, malformed/mismatched sidecar rejection, exact-size finalize, exact bytes, cleanup, and >8 MiB fallback refusal.

- [ ] **Step 7: Commit**

```bash
git add apps/native/src/optical-storage.js tests/native/optical-storage.test.mjs
git commit -m "feat: add persistent FQR2 block storage"
```

---

### Task 6: Add block-cyclic sender and one-active-block receiver orchestration

**Files:**
- Create: `apps/native/src/optical-v2-session.js`
- Test: `tests/native/optical-v2-session.test.mjs`

**Interfaces:**
- Consumes: Tasks 2–5.
- Produces:
  - `createFqr2Broadcaster(file, options)` with `run()`, test-only bounded `runVisits(count)`, `stop()`, and progress getters.
  - `createFqr2Receiver(options)` with `accept(frame)`, `stop()`, `activeBlockIndex`, `completedBlocks`, and progress snapshot.

- [ ] **Step 1: Run session tests and confirm RED**

```bash
node --test tests/native/optical-v2-session.test.mjs
```

- [ ] **Step 2: Implement manifest generation without whole-file reads**

Use only file metadata and `file.size` to build the manifest. The broadcaster may call `file.slice(start,end).arrayBuffer()` for one block; never call `file.arrayBuffer()`.

- [ ] **Step 3: Implement one-block visit**

For each block visit:

```js
const start = blockIndex * FQR2_BLOCK_BYTES;
const end = Math.min(file.size, start + FQR2_BLOCK_BYTES);
const block = new Uint8Array(await file.slice(start, end).arrayBuffer());
const blockSha256 = await sha256Hex(block);
const symbols = splitSourceSymbols(block, symbolBytes);
```

Emit manifest first, then exactly `K` parts. Cycle 0 uses `1..K`; cycle `c>0` uses `c*K+j+1`. Check the computed sequence before encode and stop on `> FQR2_MAX_SEQ_NUM`.

- [ ] **Step 4: Release block references after each visit**

Keep block/symbol variables scoped inside the visit function. Do not cache encoded frames or completed block bytes for later cycles.

- [ ] **Step 5: Implement receiver manifest lock and one-block adoption**

Ignore FQR2 part frames before manifest. After manifest, ignore already completed blocks. If no active block exists, adopt the first observed incomplete block; while one block is active, validate but do not retain other-block parts.

- [ ] **Step 6: Persist only verified complete blocks**

On decoder completion, call `writeVerifiedBlock()`; only after it resolves may the receiver increment durable progress and release the decoder. If the write fails, preserve/retry according to store semantics but never claim completion.

- [ ] **Step 7: Finalize after all blocks durable**

When `completedBlocks === blockCount`, call `store.finalize()` and expose the final File to the caller. Do not synthesize completion from decoder counts alone.

- [ ] **Step 8: Run orchestration tests**

```bash
node --test tests/native/optical-v2-session.test.mjs
```

Expected: PASS for one-block file slicing, systematic first cycle, fresh repair sequence identities on later cycles, sequence overflow stop, mid-cycle receiver join, one active decoder block, ignored other-block frames, persistence-before-progress, restart with completed blocks, and exact final file.

- [ ] **Step 9: Commit**

```bash
git add apps/native/src/optical-v2-session.js tests/native/optical-v2-session.test.mjs
git commit -m "feat: add FQR2 optical session runtime"
```

---

### Task 7: Wire FQR2 into the native QR Stream UI without changing FQR1

**Files:**
- Modify: `apps/native/src/main.js`
- Optional minimal modify: `apps/native/index.html`
- Modify: `tests/structure/optical-v2-runtime.test.mjs`
- Existing sentinel: `tests/core/optical.test.mjs`

**Interfaces:**
- Consumes `createFqr2Broadcaster()` / `createFqr2Receiver()`.
- Produces exact prefix routing and user-visible experimental progress/error copy.

- [ ] **Step 1: Run structural test and confirm remaining RED assertions**

```bash
node --test tests/structure/optical-v2-runtime.test.mjs
```

- [ ] **Step 2: Preserve current FQR1 send/receive functions as compatibility path**

Do not rewrite their frame grammar or `OpticalAssembler` semantics. Rename local functions only if necessary for clarity, e.g. `startFqr1Send()` and `startFqr1Receive()`, without changing behavior.

- [ ] **Step 3: Add exact version routing**

The camera callback must route text before any assembler mutation:

```js
if (decoded.startsWith('FQR2|')) {
  await fqr2Receiver.accept(decoded);
  return;
}
if (decoded.startsWith('FQR1|')) {
  const result = fqr1Assembler.accept(decoded);
  // existing FQR1 behavior
  return;
}
```

Unknown prefixes remain ignored/unsupported. Never send FQR2 text to `OpticalAssembler`.

- [ ] **Step 4: Wire FQR2 sender as explicit experimental mode**

Keep FQR1 available. FQR2 sender status must show `QR Stream v0.2 (experimental)`, current block/total, and cycle. FQR2 continues until Stop/runtime close and must not inherit FQR1's ten-minute stop.

- [ ] **Step 5: Wire receive progress and storage capability errors**

Show durable block progress and active symbol progress. If >8 MiB receive cannot open persistent storage, show the explicit storage capability failure rather than silently using whole-file memory.

- [ ] **Step 6: Ensure stop/mode switching releases camera, loops, FQR2 broadcaster, receiver, and FQR1 state**

Extend `opticalSession` with narrowly scoped stop callbacks; do not touch network scanner or signaling semantics.

- [ ] **Step 7: Run focused compatibility suite**

```bash
node --test tests/core/optical.test.mjs tests/native/optical-v2-session.test.mjs tests/structure/optical-receive-budget.test.mjs tests/structure/optical-v2-runtime.test.mjs
npm run build:native-ui
```

Expected: PASS. Existing FQR1 vectors remain byte-for-byte unchanged.

- [ ] **Step 8: Commit**

```bash
git add apps/native/src/main.js apps/native/index.html tests/structure/optical-v2-runtime.test.mjs
git commit -m "feat: wire experimental FQR2 QR Stream"
```

Only include `apps/native/index.html` if it actually changed.

---

### Task 8: Full repository verification and conservative documentation

**Files:**
- Modify: `docs/architecture/PROTOCOL.md`
- Modify: `README.md`
- No package-version change.

**Interfaces:**
- Consumes verified behavior from Tasks 2–7.
- Produces conservative experimental documentation and final exact-head evidence.

- [ ] **Step 1: Run full local repository verification before documentation claims**

```bash
npm test
npm run build:web
npm run build:native-ui
npm run check:signaling
npm run check:web-deploy
```

Expected: all PASS. Any signaling/deploy failure must be investigated as a regression rather than waived because FQR2 is offline-only.

- [ ] **Step 2: Update protocol documentation**

Add FQR2 exact manifest/part grammar, fixed 64 KiB blocks, deterministic fountain selection, block SHA-256 integrity, bounded decoder/storage model, and FQR1 compatibility. Explicitly state FQR2 is not sender-authenticated and not part of online protocol v2.

- [ ] **Step 3: Update README conservatively**

Describe `QR Stream v0.2 (experimental)` as bounded-memory fountain/FEC with initial 64 MiB admission cap. Preserve: no throughput claim, no universal-device claim, no production-default claim until physical evidence. Keep FQR1 compatibility described.

- [ ] **Step 4: Run docs/security structural tests and full suite again**

```bash
npm test
npm run verify
```

Expected: all PASS with no changed dependency graph.

- [ ] **Step 5: Commit documentation**

```bash
git add README.md docs/architecture/PROTOCOL.md
git commit -m "docs: describe experimental FQR2 transport"
```

- [ ] **Step 6: Exact scope audit**

Compare implementation head against the branch base. Allowed production scope is limited to:

```text
packages/core/optical-v2.js
packages/core/fountain.js
packages/core/fountain-decoder.js
apps/native/src/optical-storage.js
apps/native/src/optical-v2-session.js
apps/native/src/main.js
apps/native/index.html              # only if UI markup actually changes
README.md
docs/architecture/PROTOCOL.md
tests/core/optical-v2.test.mjs
tests/core/fountain.test.mjs
tests/core/fountain-decoder.test.mjs
tests/native/optical-storage.test.mjs
tests/native/optical-v2-session.test.mjs
tests/structure/optical-v2-runtime.test.mjs
```

Any signaling, TURN, workflow signing/release, branch/ruleset, package-lock, or package-version change is scope creep and must be removed unless a separately approved prerequisite is proven necessary.

- [ ] **Step 7: Obtain exact-head hosted verification**

Require all intended GitHub Actions gates on the exact implementation SHA:

```text
CI                SUCCESS
Browser Reliability SUCCESS
GitHub Pages Mirror SUCCESS
Native Builds       SUCCESS
```

Record exact run IDs and test counts in the PR body. Do not treat hosted GREEN as physical optical evidence.

- [ ] **Step 8: Review PR threads and merge base**

Require zero unresolved review threads, compare `ahead/behind`, and confirm merge base. Because Issue #15 currently leaves `main` unprotected, do not merge production code through an untrusted boundary merely to finish the feature quickly.

- [ ] **Step 9: Keep physical evidence as a separate post-code gate**

Do not raise the 64 MiB cap, make FQR2 default, add multi-QR lanes, or publish throughput claims until a separately recorded Windows/Android physical-camera ceremony proves them.

---

## Final Acceptance Checklist

- [ ] Test-only hosted RED commit preserved before production implementation.
- [ ] FQR1 `tests/core/optical.test.mjs` unchanged and green.
- [ ] FQR2 manifest/part parsers fail closed under malformed/bounded inputs.
- [ ] Exact xoshiro, harmonic degree, selected-index, and mixed-payload vectors green.
- [ ] Lossy deterministic recovery green.
- [ ] Decoder equation count never exceeds `3 * K`.
- [ ] Sequence identity cache never exceeds `4 * K`.
- [ ] Sender reads only one 64 KiB block at a time and never whole-file `arrayBuffer()`.
- [ ] Receiver persists only SHA-256-verified blocks.
- [ ] OPFS commit order is data checkpoint before sidecar progress.
- [ ] Reopen restores only durably committed blocks.
- [ ] >8 MiB receive cannot fall back to complete-file JS memory.
- [ ] Finalization requires all blocks plus exact final file size/bytes.
- [ ] Native exact-prefix routing keeps FQR1/FQR2 isolated.
- [ ] Package version remains `0.4.0`; dependency graph unchanged.
- [ ] No signaling/TURN/signing/release/governance scope creep.
- [ ] Exact-head CI, Browser Reliability, GitHub Pages Mirror, and Native Builds all SUCCESS.
- [ ] Documentation keeps FQR2 experimental and avoids unmeasured performance/authentication claims.
- [ ] Physical production/default claims remain deferred to empirical evidence.
