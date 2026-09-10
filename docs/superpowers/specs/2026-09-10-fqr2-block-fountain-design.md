# FQR2 Block-Fountain Optical Transport — Design

Date: 2026-09-10
Status: design approved in chat; written-spec review required before implementation
Base: `main@0e08ee50385c40e1ad9db5d446136e0f25d11ac1`

## 1. Purpose

File QR v0.4 has a deliberately conservative offline optical path. `FQR1` materializes the complete file envelope, emits a fixed sequence of independent frames, loops that sequence, and requires the receiver to retain every unique payload chunk until all sequence numbers are present. The native product therefore caps optical send at 8 MiB and explicitly makes no hardware-throughput claim.

FQR2 is the next optical protocol generation. Its goals are:

1. make sender and receiver working memory bounded by a small block rather than total file size;
2. tolerate missed QR frames without requiring one exact fixed sequence to be observed;
3. permit a receiver to join an ongoing broadcast without requiring frame zero;
4. persist verified blocks so camera loss or process interruption does not discard all progress;
5. retain FQR1 decoding and sending as a compatibility path;
6. keep the offline protocol separate from online WebRTC/signaling;
7. remain fail-closed under malformed or adversarial frame metadata;
8. make no new optical-throughput or universal-device claims without physical evidence.

This first FQR2 design intentionally excludes multi-QR-per-camera-frame modulation, non-QR visual modulation, bidirectional optical acknowledgements, RaptorQ, and cryptographic source authentication.

## 2. Existing contracts that remain authoritative

The following v0.4 boundaries do not change:

- online sessions still use the exact 600-second signaling lease and WebRTC protocol v2;
- offline QR Stream remains independent of the signaling service and never uploads file bytes;
- QR Stream data is not source-authenticated merely because it has a checksum or digest;
- FQR1 continues to mean `FQR1|STREAM_ID|SEQUENCE|TOTAL|CRC32|BASE64URL_PAYLOAD`;
- camera access remains user initiated;
- no optical throughput claim is made without hardware benchmark evidence.

FQR2 is not bound to the online 600-second lease. Offline broadcast lifetime is a local UI/runtime concern. FQR2 therefore runs until the user stops it or the runtime closes. The UI may warn about a long-running broadcast, but FQR2 must not inherit FQR1's current ten-minute hard stop.

## 3. Coding approach

FQR2 uses a **systematic LT-style fountain code per bounded file block**.

The design adopts the small fountain primitive used by Blockchain Commons Multipart URs without adopting the UR/CBOR/Bytewords envelope:

- the first `K` sequence numbers for a block are systematic degree-1 source symbols;
- later sequence numbers are deterministic XOR mixtures of source symbols;
- mixed-part degree is drawn from a harmonic distribution biased toward lower degrees;
- selected source indexes are deterministically derived from part sequence identity and immutable block identity;
- decoding uses bounded peeling/XOR reduction.

References:

- Multipart UR Implementation Guide: https://github.com/BlockchainCommons/Research/blob/master/papers/bcr-2024-001-multipart-ur.md
- Animated QR overview: https://developer.blockchaincommons.com/qrs/

File QR will reimplement only the required primitive under its own frame format. No new npm dependency is added for FQR2.

RaptorQ is deferred. RFC 6330 defines a systematic fountain code with strong coding efficiency and large-block support, but its precode/matrix machinery is materially larger than required for the first bounded File QR optical transport. Reference: https://www.rfc-editor.org/info/rfc6330/

## 4. Fixed v0.2 resource geometry

The first FQR2 protocol revision intentionally fixes block size rather than pretending that arbitrary geometry has been empirically validated.

Constants:

- `FQR2_BLOCK_BYTES = 64 * 1024`;
- `FQR2_DEFAULT_SYMBOL_BYTES = 768`;
- `FQR2_MIN_SYMBOL_BYTES = 256`;
- `FQR2_MAX_SYMBOL_BYTES = 900`;
- `FQR2_MAX_SOURCE_SYMBOLS = 256`;
- `FQR2_MAX_FILE_BYTES = 64 * 1024 * 1024`;
- `FQR2_MAX_BLOCKS = 1024`;
- `FQR2_MAX_METADATA_BYTES = 2048` after UTF-8 JSON serialization;
- `FQR2_MAX_SEQ_NUM = 0xffffffff`;
- unresolved mixed equations: at most `3 * K` for one active block;
- recent sequence-number duplicate cache: at most `4 * K` for one active block.

`BLOCK_BYTES` remains present in the manifest for explicit self-description and future versioning, but **FQR2 v0.2 accepts exactly 65536**. Another block size requires a later protocol revision or an explicitly approved compatibility extension.

A block is divided into:

`K = ceil(blockLength / symbolBytes)`

fixed-width source symbols. The final source symbol is zero-padded to `symbolBytes` for XOR coding. `blockLength` determines how much padding is removed after decode.

Because block size is fixed and symbol size cannot be below 256 bytes, `K <= 256` is an invariant rather than an approximate budget.

The 64 MiB file cap is an initial product admission limit, not a RAM limit and not a statement that 64 MiB is practical on every camera/display pair. The architecture removes O(file-size) heap assembly; the product cap may rise only after physical evidence.

No valid frame may cause allocation proportional to an unchecked declared file size, block count, source-symbol count, or sequence number.

## 5. Stream identity and manifest

FQR2 uses a 12-character uppercase Crockford-style stream identifier generated from cryptographically random bytes. The stream ID is an identifier, not an authorization secret.

The sender emits a manifest before every block visit:

`FQR2|M|STREAM_ID|FILE_SIZE|BLOCK_BYTES|SYMBOL_BYTES|BLOCK_COUNT|META_CRC32|META_BASE64URL`

`META_BASE64URL` is UTF-8 JSON containing only:

```json
{
  "name": "example.bin",
  "type": "application/octet-stream"
}
```

The receiver validates numeric bounds before metadata allocation/decoding, validates metadata length, validates `META_CRC32`, and then locks immutable stream geometry.

For FQR2 v0.2:

- `0 <= FILE_SIZE <= FQR2_MAX_FILE_BYTES`;
- `BLOCK_BYTES === 65536`;
- `FQR2_MIN_SYMBOL_BYTES <= SYMBOL_BYTES <= FQR2_MAX_SYMBOL_BYTES`;
- `BLOCK_COUNT === max(1, ceil(FILE_SIZE / BLOCK_BYTES))`;
- `BLOCK_COUNT <= FQR2_MAX_BLOCKS`.

A zero-byte file is represented by one logical block with `BLOCK_LENGTH = 0`, `K = 1`, and a zero-length logical source payload padded to one full symbol for coding. This keeps the state machine explicit and avoids a zero-block special case.

A later manifest for the same stream with different immutable fields is rejected without mutating accepted state.

A receiver joining mid-broadcast may ignore `P` frames until a valid manifest arrives. Because a manifest is repeated at every block boundary, joining does not require waiting for the entire file cycle to return to its first frame.

## 6. Fountain part frame

A part frame is:

`FQR2|P|STREAM_ID|BLOCK_INDEX|SEQ_NUM|SEQ_LEN|BLOCK_LENGTH|BLOCK_SHA256|PART_CRC32|PAYLOAD_BASE64URL`

Rules:

- `BLOCK_INDEX` is zero based and `< BLOCK_COUNT`;
- `SEQ_NUM` is one based and `<= FQR2_MAX_SEQ_NUM`;
- `SEQ_LEN` is `K` and must equal the source-symbol count implied by the locked manifest, `BLOCK_LENGTH`, and `SYMBOL_BYTES`;
- for non-final blocks, `BLOCK_LENGTH === FQR2_BLOCK_BYTES`;
- for the final block, `BLOCK_LENGTH` equals the exact remaining file length, except a zero-byte file uses `BLOCK_LENGTH = 0` and `K = 1`;
- `BLOCK_SHA256` is exactly 64 lowercase hexadecimal characters;
- `PART_CRC32` covers the decoded mixed payload bytes;
- decoded payload length is exactly `SYMBOL_BYTES`.

The receiver locks `BLOCK_SHA256`, `SEQ_LEN`, and `BLOCK_LENGTH` on first accepted part for an active block. Conflicting parts are rejected before fountain-state mutation.

`BLOCK_SHA256` provides strong reconstructed-block corruption detection. It does **not** authenticate the sender because an active attacker can replace both data and digest.

## 7. Deterministic fountain selection

Source symbols are indexed `0..K-1`.

### 7.1 Systematic parts

For `1 <= SEQ_NUM <= K`, the part contains source symbol `SEQ_NUM - 1` unchanged.

### 7.2 Mixed parts

For `SEQ_NUM > K`, selection is deterministic.

The seed identity is constructed from:

- unsigned 32-bit `SEQ_NUM`, serialized big endian;
- the first four bytes represented by `BLOCK_SHA256`, interpreted exactly as the first eight hexadecimal characters and serialized as the same four bytes.

These eight bytes are hashed with SHA-256. The resulting 32 bytes initialize **xoshiro256\*\*** as four consecutive unsigned 64-bit big-endian state words.

If all four state words were ever zero, the implementation substitutes the fixed final state word `0x9e3779b97f4a7c15`; this branch is deterministic and must have a test vector even though SHA-256 producing an all-zero seed is not expected in practice.

The xoshiro256\*\* transition is fixed as:

```text
result = rotl64(s1 * 5, 7) * 9
t = s1 << 17
s2 ^= s0
s3 ^= s1
s1 ^= s2
s0 ^= s3
s2 ^= t
s3 = rotl64(s3, 45)
return result
```

Every arithmetic operation is modulo `2^64`. JavaScript implementation uses `BigInt` plus an explicit `0xffffffffffffffffn` mask. No host-endian typed-array reinterpretation is allowed in seed construction.

### 7.3 Degree selection

For `d = 1..K`, degree weight is proportional to `1/d`, matching the harmonic low-degree bias of Multipart UR.

The implementation builds a cumulative IEEE-754 `Number` distribution in ascending degree order and derives one uniform value from the top 53 bits of the next xoshiro output:

`u = Number(next >> 11n) / 2^53`

The first cumulative bucket strictly greater than `u` selects the degree. Because all currently supported runtimes are JavaScript and use IEEE-754 doubles, deterministic test vectors lock the exact result.

### 7.4 Fragment selection

The implementation performs an in-place partial Fisher-Yates shuffle of `[0, 1, ..., K-1]`. For each needed selection position, the next PRNG output chooses an index from the remaining suffix using integer modulo of the remaining count. Exactly `degree` distinct indexes are selected.

The mixed payload is the XOR of those fixed-width source symbols.

The PRNG, harmonic sampler, and index chooser are coding tools only. No security property relies on their unpredictability.

## 8. Sender schedule and bounded memory

The FQR2 sender must never call whole-file `file.arrayBuffer()` and must never call the FQR1 whole-envelope encoder.

It operates as a cyclic block broadcaster:

1. emit the manifest;
2. load exactly one `file.slice(blockStart, blockEnd)`;
3. compute the block's SHA-256;
4. split/pad that one block into source symbols;
5. emit exactly `K` part frames for that block visit;
6. discard that block/symbol working set;
7. continue to the next block;
8. after the final block, increment the broadcast cycle and repeat until stopped.

Cycle zero emits `SEQ_NUM = 1..K` for each block, producing a systematic first pass.

For cycle `c > 0`, local part index `j` in `0..K-1` uses:

`SEQ_NUM = c * K + j + 1`

This produces a fresh deterministic repair set on every later block visit instead of replaying identical repair frames.

Before generating a sequence number, the sender checks that the calculation is `<= FQR2_MAX_SEQ_NUM`. Overflow stops that FQR2 broadcast with an explicit error; it never wraps sequence identity.

The sender's file-content working memory is O(64 KiB + coding state). It may retain small O(blockCount) scalar UI metadata, but it must not retain every file block, every encoded part, or every rendered QR string.

The first implementation keeps one QR per rendered camera frame. QR ECC, symbol payload size, and frame interval remain implementation presets, not protocol guarantees, and are not described as optimal until physical benchmarking.

## 9. Decoder state and equation bounds

The receiver owns at most one active fountain block working set at a time. Completed blocks are persisted and removed from fountain memory.

Active-block state contains only:

- solved source symbols keyed by source index;
- unresolved mixed equations `{indexes, payload, insertionOrdinal}`;
- a bounded recent `SEQ_NUM` LRU/set for duplicate suppression;
- immutable block geometry and expected SHA-256.

Acceptance sequence:

1. parse and validate complete frame syntax and resource bounds;
2. decode payload and validate `PART_CRC32` before state mutation;
3. reject geometry/hash conflicts;
4. derive source indexes deterministically from `SEQ_NUM`;
5. XOR away already solved source symbols;
6. if degree becomes zero, accept only if payload is all zero; otherwise reject the inconsistent equation;
7. promote degree-one equations to solved source symbols;
8. recursively reduce retained equations after each newly solved symbol;
9. deduplicate already seen/equivalent information;
10. retain at most `3 * K` unresolved equations and at most `4 * K` recent sequence identities.

When the unresolved-equation cap is full, the decoder remains live. A new useful equation may replace one retained equation using this deterministic eviction rule:

1. highest remaining degree loses first;
2. ties lose oldest insertion ordinal first;
3. an incoming equation is discarded instead when its degree is greater than the selected eviction candidate and it does not solve/reduce existing state.

This policy bounds memory while still allowing later low-degree repair information to enter the decoder.

A block is complete only after all `K` source symbols are solved, final padding is trimmed to `BLOCK_LENGTH`, and SHA-256 of reconstructed bytes equals `BLOCK_SHA256`.

On SHA mismatch, the block is not persisted. Its in-memory fountain state is discarded so later clean broadcast cycles can reconstruct it again.

## 10. Persistent random-access block sink

FQR2 requires random-access persistence so the receiver can join mid-broadcast, complete blocks out of order, and avoid whole-file heap retention.

This is a separate storage abstraction from the online sequential WebRTC receive sink.

Conceptual interface:

```text
open(manifest) -> store
store.hasBlock(index)
store.writeVerifiedBlock(index, bytes, blockSha256)
store.completedBlocks
store.finalize()
store.abort({ discard })
store.cleanup()
```

Primary backend: OPFS.

The OPFS backend maintains:

- one `<stream>.fqr2.part` random-access file;
- one `<stream>.fqr2.json` sidecar containing the locked manifest, completed-block bitmap/list, and SHA-256 for every committed block;
- one durability checkpoint after each verified block.

`writeVerifiedBlock()` seeks to `BLOCK_INDEX * FQR2_BLOCK_BYTES` and writes only bytes that have already passed block SHA-256 verification.

Commit ordering is mandatory:

1. write block data;
2. close/checkpoint the writable file operation successfully;
3. update sidecar completed-block state;
4. close/checkpoint the sidecar successfully;
5. only then report that block as durable to UI/orchestrator.

If a crash happens after data write but before sidecar commit, the block may be reconstructed and overwritten later; progress metadata is never allowed to claim durability ahead of data.

On reopen, the receiver validates sidecar schema, manifest equality, file-size plausibility, block indexes, bitmap bounds, and stored hash syntax before accepting prior progress. It does not trust malformed persisted metadata.

`finalize()` requires:

- every logical block marked durably complete;
- `.part` file size exactly equal to `FILE_SIZE`;
- every committed block entry inside valid range;
- no duplicate/conflicting committed block hash.

Only then may it expose a final `File`/download result.

For FQR2 files above the legacy 8 MiB memory ceiling, absence/failure of OPFS or an equivalent random-access persistent backend is an explicit capability failure. It is not permission to allocate the complete file in JS heap.

Small FQR2 payloads may use a bounded memory backend only when `FILE_SIZE <= 8 MiB`.

## 11. Receiver scheduling across blocks

After a valid manifest is locked, the receiver adopts the first incomplete block for which it sees a valid part.

While that block remains active:

- parts for the active block are fountain-decoded;
- parts for already completed blocks are ignored;
- parts for other incomplete blocks are syntax/bounds checked and then ignored, not buffered.

When the active block verifies and is durably persisted, its fountain state is released and the receiver may adopt the next observed incomplete block.

This one-block policy intentionally trades some optical efficiency for a simple, provable memory bound. Multi-block decoder windows are a deferred optimization requiring separate evidence/design approval.

Progress is two-level:

- file progress: durable verified blocks / `BLOCK_COUNT`;
- active block progress: solved source symbols / `K`, with optional retained-equation count.

## 12. Version routing and backward compatibility

FQR1 and FQR2 are explicit independent parsers.

- existing FQR1 vectors and semantics remain unchanged;
- FQR2 receives new manifest/part/fountain classes rather than changing FQR1 grammar;
- the native receiver routes exact prefixes `FQR1|` and `FQR2|`;
- unknown versions are unsupported rather than guessed compatible;
- FQR2 frames can never be fed into `OpticalAssembler` as though they were FQR1;
- FQR1 send remains available for the current small-file compatibility path.

FQR2 may become the default QR Stream mode only after physical camera evidence supports that product decision.

## 13. Security and abuse boundaries

Camera-decoded text is hostile input.

Before allocation or decoder mutation, FQR2 validates and bounds:

- total frame text length;
- exact version/type and field count;
- stream ID syntax;
- file size;
- metadata encoded and decoded length;
- fixed block size;
- block count/index;
- symbol size;
- source-symbol count;
- sequence number;
- SHA-256 syntax;
- CRC32 syntax;
- Base64URL payload decoded length.

Decoder state must stay bounded under an endless stream of unique sequence numbers. A hostile source cannot force O(sequence-number), O(file-size), or unbounded equation retention.

File name and MIME type are display/download metadata only. The receiver must not interpret the sender-provided name as a filesystem path.

CRC32 is a fast frame-corruption filter. SHA-256 verifies reconstructed block integrity. Neither authenticates the sender. Documentation must preserve this distinction.

## 14. Failure semantics

Failures are stream/block scoped and fail closed:

- malformed manifest: no stream state created;
- manifest conflict: reject frame, preserve previously locked stream;
- malformed part or CRC mismatch: no fountain mutation;
- geometry/hash conflict: no fountain mutation;
- inconsistent degree-zero equation: reject equation;
- equation/sequence cache pressure: deterministic bounded eviction;
- block SHA mismatch: never commit block, discard active decode state;
- data-write/checkpoint failure: never advance durable block progress;
- sidecar failure: never report block durable;
- OPFS unavailable above 8 MiB: stop with explicit storage-capability error;
- sequence-number overflow: sender stops rather than wraps;
- finalization failure: preserve verified partial state where safe so finalization can be retried.

The receiver never synthesizes completion until every logical block is independently SHA-256 verified and durably persisted.

## 15. Native UI behavior

The existing QR Stream panel becomes version aware without turning into a technical transport dashboard.

Sender UI shows:

- selected file;
- `QR Stream v0.2 (experimental)`;
- current block / total blocks;
- current broadcast cycle;
- Stop action;
- no false receiver-complete state because the unidirectional sender receives no acknowledgement.

Receiver UI shows:

- verified durable blocks / total blocks;
- active-block solved-symbol progress;
- resume/recovery indication when a matching persisted partial is reopened;
- explicit storage-capability error when large FQR2 receive cannot obtain a bounded persistent backend.

UI copy must not claim guaranteed KB/s or Mbps, maximum distance, universal camera compatibility, or universal practicality for the 64 MiB cap before physical measurement.

## 16. Required TDD lineage

Implementation proceeds RED -> GREEN. The first implementation PR retains a test-only RED commit before production code.

Core tests must cover at least:

1. manifest round trip;
2. manifest hard bounds and immutable-field conflicts;
3. zero-byte stream geometry;
4. part round trip and CRC corruption rejection;
5. systematic `SEQ_NUM <= K` source mapping;
6. xoshiro256\*\* seed/state transition vectors;
7. harmonic degree vectors;
8. selected-index vectors;
9. mixed payload vectors;
10. deterministic recovery after omitted systematic frames plus later repair parts;
11. duplicate reduction;
12. inconsistent degree-zero rejection;
13. equation-cap eviction under thousands of unique repair parts;
14. sequence-cache cap under thousands of unique sequence identities;
15. block SHA mismatch never commits;
16. FQR1 vectors remain byte-for-byte compatible.

Storage tests must cover at least:

1. out-of-order verified block writes at exact offsets;
2. completed-block sidecar persistence/reopen;
3. crash model where sidecar never advances before durable data;
4. manifest mismatch rejection;
5. malformed sidecar rejection;
6. sparse/impossible file-state rejection;
7. final exact file-size equality;
8. final exact-byte equality;
9. memory fallback refusal above 8 MiB.

Native/structural tests must prove:

1. sender does not call whole-file `file.arrayBuffer()`;
2. sender does not materialize a full-file encoded-frame array;
3. sender holds one block at a time;
4. receiver owns one fountain block state at a time;
5. FQR1 path remains available and unchanged;
6. version routing cannot send FQR2 text to the FQR1 assembler;
7. no signaling, TURN, signing, or repository-governance code changes are required for FQR2 core;
8. sequence overflow fails closed;
9. >8 MiB FQR2 cannot silently fall back to complete-file memory assembly.

Exact-head repository gates remain `CI`, `Browser Reliability`, `GitHub Pages Mirror`, and `Native Builds`. Passing hosted gates does not constitute physical optical validation.

## 17. Physical evidence gate

FQR2 production/default claims require a separate empirical ceremony on real Windows and Android devices.

Evidence should record, without stable unique device identifiers:

- platform and broad OS version class;
- display/camera resolution class where available;
- QR payload, ECC, and frame-interval preset;
- file size;
- accepted/duplicate/rejected part counts;
- completion time;
- whether scanning began at broadcast start or mid-cycle;
- peak JS heap where measurable;
- exact final-file equality/hash;
- PASS/FAIL.

The first implementation may exist as an explicit experimental mode before this ceremony, but README claims remain conservative. Raising `FQR2_MAX_FILE_BYTES`, introducing multi-QR lanes, or advertising throughput requires physical evidence.

## 18. Deferred work

Excluded from the first FQR2 implementation:

- 2x2 or larger multi-QR lanes;
- adaptive frame rate/payload size from live feedback;
- reverse optical acknowledgement channel;
- RaptorQ/precode matrix FEC;
- authenticated or encrypted optical envelopes;
- non-QR visual modulation;
- product cap above 64 MiB;
- multi-block decoder windows.

Each requires a separate design because it changes coding semantics, resource bounds, camera workload, or security/product claims.

## 19. Expected implementation boundary

The first implementation is expected to touch primarily:

- `packages/core/` for new FQR2 manifest, part, deterministic fountain, and bounded decoder primitives while preserving `optical.js` FQR1;
- `apps/native/src/` for block-cyclic send, exact version routing, receive orchestration, and progress UI;
- a new/shared storage module for OPFS random-access optical block persistence without changing online WebRTC receive semantics;
- `tests/core/`, `tests/native/`, and `tests/structure/`;
- README/protocol docs only after implementation behavior is exact-head verified.

The first FQR2 PR must not contain TURN, signaling-rate-limit, publisher-signing, release-governance, or branch-protection changes. Those remain independent tracks (#8, #9, #15, #16, #17, #19, #45, #46).

## 20. Acceptance criteria

FQR2 core is implementation-complete only when all are true:

- a test-only hosted RED commit proves absent FQR2 behavior;
- deterministic fountain vectors pass exactly;
- deterministic lossy-frame recovery passes;
- sender content memory is block-bounded by design and test;
- receiver fountain state is one-block/equation/sequence-cache bounded;
- verified blocks persist out of order without whole-file heap assembly;
- reopen restores only durably committed progress;
- every completed block passes SHA-256 before persistence;
- finalization requires exact file size and all blocks durable;
- FQR1 tests remain unchanged/green;
- exact-head CI, Browser Reliability, Pages, and Native are green;
- final diff contains no signaling, TURN, signing, release-governance, or repository-governance scope creep;
- documentation preserves experimental status and makes no unmeasured throughput/authentication claim.

Physical production-readiness remains a later evidence gate and is not implied by code completion.
