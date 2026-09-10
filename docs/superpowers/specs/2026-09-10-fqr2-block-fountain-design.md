# FQR2 Block-Fountain Optical Transport — Design

Date: 2026-09-10
Status: design approved in chat; written-spec review required before implementation
Base: `main@0e08ee50385c40e1ad9db5d446136e0f25d11ac1`

## 1. Purpose

File QR v0.4 has a deliberately conservative offline optical path. `FQR1` materializes the complete file envelope, emits a fixed sequence of independent frames, loops that sequence, and requires the receiver to retain every unique payload chunk until all sequence numbers are present. The native product therefore caps optical send at 8 MiB and explicitly makes no hardware throughput claim.

FQR2 is the next optical protocol generation. Its goals are:

1. make receiver and sender working memory bounded by a small block rather than total file size;
2. tolerate missed QR frames without requiring one exact fixed sequence to be observed;
3. permit a receiver to join an ongoing broadcast without requiring frame zero;
4. persist already verified blocks so transient camera loss or process interruption does not discard all progress;
5. retain FQR1 decoding for backward compatibility;
6. keep the offline protocol separate from the online WebRTC/signaling protocol;
7. remain fail-closed under malformed or adversarial frame metadata;
8. make no new optical-throughput or universal-device compatibility claims without physical evidence.

This design intentionally does not attempt multi-QR-per-camera-frame modulation, non-QR visual modulation, RaptorQ, network feedback, or cryptographic source authentication in the first FQR2 implementation.

## 2. Existing constraints that remain authoritative

The following v0.4 boundaries do not change:

- online sessions still use the 600-second signaling lease and WebRTC protocol v2;
- offline QR Stream remains independent of the signaling service and does not upload file bytes;
- QR Stream data is not source-authenticated merely because it has a checksum or digest;
- FQR1 remains supported and continues to mean `FQR1|STREAM_ID|SEQUENCE|TOTAL|CRC32|BASE64URL_PAYLOAD`;
- camera access remains user initiated;
- no optical throughput claim is made without hardware benchmark evidence.

The FQR2 sender is not constrained by the online 600-second signaling lease. Offline broadcast lifetime is a UI/runtime concern, not a signaling capability lifetime. FQR2 therefore runs until the user stops it or the runtime is closed. The UI may warn about long-running broadcasts but must not impose the current FQR1 ten-minute hard stop on FQR2.

## 3. Chosen coding approach

FQR2 uses a **systematic LT-style fountain code per bounded file block**.

The design borrows the small, well-understood fountain primitive used by Blockchain Commons Multipart URs rather than importing the UR/CBOR/Bytewords envelope itself:

- the first `K` part sequence numbers for a block are systematic degree-1 source symbols;
- later sequence numbers are deterministic XOR mixtures of source symbols;
- mixed-part degree is chosen from a harmonic distribution biased toward low degrees;
- fragment selection is deterministically derived from the sequence number and block checksum;
- decoder reduction is peeling/XOR based.

Reference implementation guidance:

- Blockchain Commons Multipart UR Implementation Guide: https://github.com/BlockchainCommons/Research/blob/master/papers/bcr-2024-001-multipart-ur.md
- Blockchain Commons Animated QR overview: https://developer.blockchaincommons.com/qrs/

The project will reimplement only the required fountain primitive under File QR's own frame format. It will not copy an external library and will not add an npm dependency for FQR2.

RaptorQ is explicitly deferred. RFC 6330 specifies a systematic fountain code with excellent coding efficiency and large-block support, but its matrix/precode machinery is substantially larger than the bounded optical transport required for the first FQR2 iteration. Reference: https://www.rfc-editor.org/info/rfc6330/

## 4. Resource geometry

Initial FQR2 product constants are deliberately conservative and testable:

- `FQR2_DEFAULT_BLOCK_BYTES = 64 * 1024`;
- `FQR2_DEFAULT_SYMBOL_BYTES = 768`;
- `FQR2_MIN_SYMBOL_BYTES = 256`;
- `FQR2_MAX_SYMBOL_BYTES = 900`;
- `FQR2_MAX_SOURCE_SYMBOLS = 256`;
- `FQR2_MAX_FILE_BYTES = 64 * 1024 * 1024` for the first product release;
- `FQR2_MAX_BLOCKS = 1024` at the default 64 KiB geometry;
- metadata payload maximum: 2048 UTF-8 bytes after JSON serialization;
- part sequence number maximum: unsigned 32-bit integer;
- retained unresolved mixed equations: at most `3 * K` for one active block.

These are **product admission limits**, not claims about QR theoretical capacity. The architecture removes the O(file-size) RAM requirement, but the 64 MiB initial product cap remains until real Windows/Android optical benchmark evidence justifies raising it.

A block is divided into `K = ceil(blockLength / symbolBytes)` fixed-width source symbols. The final symbol is zero-padded to `symbolBytes` for XOR mixing; `blockLength` determines how much padding is discarded after decode.

No valid FQR2 frame may cause allocation proportional to an unchecked declared file size, block count, symbol count, or sequence number.

## 5. Stream identity and manifest

FQR2 uses a 12-character uppercase Crockford-style stream identifier generated from cryptographically random bytes. It is an identifier, not an authorization secret.

The sender repeatedly emits a manifest frame before each block visit:

`FQR2|M|STREAM_ID|FILE_SIZE|BLOCK_BYTES|SYMBOL_BYTES|BLOCK_COUNT|META_CRC32|META_BASE64URL`

`META_BASE64URL` is UTF-8 JSON containing only:

```json
{
  "name": "example.bin",
  "type": "application/octet-stream"
}
```

The receiver validates all numeric fields before decoding metadata, validates metadata length against the hard bound, checks `META_CRC32`, and then locks the immutable stream geometry for that `STREAM_ID`.

A later manifest for the same stream with different file size, geometry, block count, name, or MIME type is rejected without mutating accepted state.

A receiver that starts in the middle of a broadcast may ignore `P` frames until it receives a valid manifest. Because the sender repeats the manifest at every block boundary, joining does not require waiting for the entire file loop to return to its first frame.

## 6. Fountain part frame

A fountain part uses:

`FQR2|P|STREAM_ID|BLOCK_INDEX|SEQ_NUM|SEQ_LEN|BLOCK_LENGTH|BLOCK_SHA256|PART_CRC32|PAYLOAD_BASE64URL`

Field rules:

- `BLOCK_INDEX` is zero based and must be `< BLOCK_COUNT` from the locked manifest;
- `SEQ_NUM` is one based and must be in `1..0xffffffff`;
- `SEQ_LEN` is the source-symbol count `K` and must equal `ceil(BLOCK_LENGTH / SYMBOL_BYTES)`;
- `BLOCK_LENGTH` must be positive, no larger than the configured block size, and must match the exact final-block geometry implied by `FILE_SIZE`;
- `BLOCK_SHA256` is 64 lowercase hexadecimal characters and locks the decoded content for that block;
- `PART_CRC32` covers the decoded mixed payload bytes and detects corrupted individual QR payloads before fountain-state mutation;
- decoded payload length must equal exactly `SYMBOL_BYTES` except that a future protocol version may define another rule; FQR2 does not guess.

The receiver locks `BLOCK_SHA256`, `SEQ_LEN`, and `BLOCK_LENGTH` on the first accepted part for a block. Conflicting parts for the same stream/block are rejected without state mutation.

`BLOCK_SHA256` provides strong corruption detection for the reconstructed block. It does **not** authenticate who created the QR stream because an active attacker could replace both data and digest.

## 7. Deterministic fountain selection

For each block, source symbols are indexed `0..K-1`.

For `1 <= SEQ_NUM <= K`, the frame is systematic and contains source symbol `SEQ_NUM - 1` unchanged.

For `SEQ_NUM > K`, FQR2 follows the Multipart-UR-style deterministic fragment-selection primitive:

1. combine the unsigned big-endian `SEQ_NUM` with the block's CRC32 value;
2. hash that seed material with SHA-256;
3. initialize a specified Xoshiro256 PRNG from the 256-bit seed;
4. choose a degree from weights proportional to `1/d` for `d = 1..K`;
5. partially Fisher-Yates-shuffle `0..K-1` and select exactly `degree` distinct source indexes;
6. XOR those fixed-width source symbols to create the mixed payload.

The production implementation must include deterministic cross-runtime test vectors for seed derivation, degree choice, selected indexes, and mixed payload bytes. Numeric behavior may not depend on host endianness or implementation-defined integer overflow.

The PRNG and sampler are transport coding tools, not security primitives. No security property is based on their unpredictability.

## 8. Sender schedule and bounded memory

The sender does not call `file.arrayBuffer()` for the complete file and does not call the FQR1 whole-envelope encoder.

It operates as a cyclic block broadcaster:

1. emit the manifest;
2. load exactly one `file.slice(blockStart, blockEnd)` into memory;
3. compute the block CRC32 and SHA-256;
4. partition that block into source symbols;
5. emit exactly `K` part frames for that block visit;
6. discard the block/symbol working set;
7. move to the next block;
8. after the final block, increment the broadcast cycle and start again until stopped.

On cycle zero, each block visit emits sequence numbers `1..K`, so the first complete, lossless observation is purely systematic.

On cycle `c > 0`, each block visit emits the next non-overlapping `K` sequence numbers:

`SEQ_NUM = c * K + localIndex + 1`

Thus every later visit produces fresh deterministic repair parts rather than replaying the same repair set.

The sender's file-content working memory is therefore O(block size), plus small encoder metadata. It may retain O(blockCount) scalar progress metadata if needed by UI, but it must not retain all encoded QR strings or all file blocks.

The implementation initially keeps the existing single-QR renderer. QR error-correction level, payload size, and frame interval remain implementation presets and must not be described as optimal until measured on physical hardware.

## 9. Decoder and equation bounds

The decoder owns at most one active fountain block working set at a time. Completed blocks are persisted and removed from fountain memory.

For the active block it tracks:

- solved source symbols by index;
- unresolved mixed equations `{indexes, payload}`;
- seen/rejected sequence identities for bounded duplicate suppression;
- immutable block geometry and expected SHA-256.

On part acceptance:

1. validate the complete frame and CRC32 before mutation;
2. reconstruct the deterministic source-index set from `SEQ_NUM`;
3. XOR away already solved source symbols;
4. discard an equation reduced to degree zero when it is consistent;
5. promote degree-one equations to solved symbols;
6. recursively reduce retained equations when a new source symbol is solved;
7. deduplicate equivalent/replayed equations;
8. never retain more than `3 * K` unresolved equations.

If the unresolved-equation cap is full, the decoder must remain live rather than permanently reject all future repair information. It evicts one least-useful retained equation using a deterministic policy: highest remaining degree first, then oldest insertion order. A new lower-degree equation may therefore replace a less useful high-degree equation.

A block is complete only after all `K` source symbols are solved, padding is removed according to `BLOCK_LENGTH`, and SHA-256 of the reconstructed block equals `BLOCK_SHA256`.

A hash mismatch discards only that block's fountain state and never marks the block persisted/complete.

## 10. Persistent block sink

FQR2 requires random-access persistence so a receiver may join mid-broadcast and finish blocks out of order without retaining the whole file in heap memory.

A new optical block-storage abstraction will be separate from the online sequential receive sink. Its conceptual interface is:

```text
open(manifest) -> store
store.hasBlock(index)
store.writeVerifiedBlock(index, bytes, blockSha256)
store.completedBlocks
store.finalize()
store.abort({ discard })
store.cleanup()
```

Primary implementation: OPFS.

The OPFS backend maintains:

- one `<stream>.fqr2.part` random-access file;
- one small `<stream>.fqr2.json` sidecar containing validated immutable manifest fields, a completed-block bitmap/list, and the expected hash for every block already committed;
- durability checkpoint after each verified block.

`writeVerifiedBlock()` seeks to `BLOCK_INDEX * BLOCK_BYTES` and writes only after block SHA-256 verification succeeds. The sidecar is updated only after the data write is closed/checkpointed successfully.

On restart, FQR2 may reopen a matching sidecar and skip already completed blocks. Manifest mismatch, malformed sidecar state, impossible file length, or conflicting committed hash fails closed and discards/requires explicit cleanup rather than guessing compatibility.

For FQR2 payloads above the legacy 8 MiB memory ceiling, lack of OPFS/random-access persistent storage is a capability failure, not permission to materialize the complete file in RAM. The UI must tell the user that large offline receive is unavailable on that runtime. Small FQR2 transfers may use a bounded memory fallback only if the complete admitted file is within the existing 8 MiB legacy memory ceiling.

The implementation must verify OPFS behavior in the existing browser/native test harnesses where supported and retain a physical-device evidence requirement before claiming broad Windows/Android support for large optical files.

## 11. Receiver scheduling across blocks

After the manifest is known, the receiver selects the first incomplete block for which it sees a valid part as its active block. Frames for already completed blocks are ignored.

While an active block is unresolved, frames belonging to other blocks are validated only enough to reject malformed input and then ignored; they are not accumulated in memory. This preserves the one-block memory bound.

When the active block completes and is persisted, the receiver releases its fountain state and may adopt the next observed incomplete block.

This policy trades some optical efficiency for a simple, provable memory bound. Multi-block decoder windows are deferred until physical evidence shows they are worth the added state and memory complexity.

Progress is reported as two levels:

- file progress: verified/persisted blocks over `BLOCK_COUNT`;
- active block progress: solved source symbols over `K` plus decoder equation state.

## 12. Backward compatibility and version routing

FQR1 and FQR2 parsers remain explicit and separate.

- `decodeOpticalFrame()` continues to decode only FQR1 unless deliberately renamed behind a compatibility wrapper;
- FQR2 gets its own parser/encoder/fountain classes;
- the native optical receiver routes on the exact prefix `FQR1|` or `FQR2|`;
- unknown versions are ignored/rejected as unsupported, never guessed compatible;
- FQR2 must not change the semantics or test vectors of FQR1.

FQR1 send remains available as a compatibility path for the current small-file behavior during the initial FQR2 rollout. Product UI may make FQR2 the default only after physical camera evidence is recorded.

## 13. Security and abuse boundaries

FQR2 treats camera input as hostile untrusted text.

Before allocation or state mutation, parsers must bound and validate:

- total frame text length;
- exact field count and version/type;
- stream identifier syntax;
- file size;
- metadata length;
- block count/index;
- block/symbol sizes;
- source symbol count;
- sequence number;
- hash/checksum syntax;
- Base64URL payload decoded length.

Decoder state must remain bounded even under endless unique repair sequence numbers. A hostile sender must not be able to force O(sequence-number), O(file-size), or unbounded-equation memory.

File names from manifest metadata are display/download metadata only. Existing filename safety behavior must remain in force; FQR2 must never interpret metadata as a filesystem path supplied by the sender.

CRC32 is retained as a fast frame-corruption filter. SHA-256 protects reconstructed-block integrity. Neither provides sender authenticity. Documentation must preserve that distinction.

## 14. Failure semantics

All protocol failures are block/stream scoped and fail closed:

- malformed manifest: no stream state created;
- manifest conflict: reject conflicting frame, preserve previously locked stream;
- malformed part or CRC mismatch: reject part, no decoder mutation;
- geometry/hash conflict: reject part, no decoder mutation;
- equation limit: deterministic eviction, never unbounded growth;
- block SHA mismatch: discard unresolved/solved state for that block, do not commit;
- persistence write/checkpoint failure: do not mark block complete;
- OPFS unavailable for a file above the bounded memory fallback: stop with explicit capability error;
- finalization failure: preserve verified partial state when safe so the user can retry finalization.

The receiver must never synthesize a completed file unless every block is independently verified and persisted.

## 15. UI behavior

The native QR Stream panel becomes version-aware without becoming a transport-control dashboard.

Sender UI shows:

- selected file;
- `QR Stream v0.2 (experimental)`;
- current block / total blocks;
- broadcast cycle;
- explicit Stop action;
- no implied completion state because the sender receives no feedback.

Receiver UI shows:

- verified blocks / total blocks;
- active block solved-symbol progress;
- recovery/resume indication when prior persisted blocks are found;
- explicit storage-capability error when large FQR2 persistence is unavailable.

No UI copy may claim a guaranteed Mbps/KBps rate, maximum distance, universal camera compatibility, or universal file-size practicality before physical benchmark evidence exists.

## 16. Testing strategy and required TDD lineage

Implementation must proceed RED -> GREEN. The first implementation PR must preserve a test-only RED commit before production code.

Core unit tests must cover at least:

1. FQR2 manifest round trip and all numeric hard bounds;
2. part round trip and CRC corruption rejection;
3. systematic `SEQ_NUM <= K` source mapping;
4. deterministic mixed-part test vectors for degree/index selection;
5. recovery with randomly omitted systematic frames plus later repair parts;
6. duplicate/mixed equation reduction;
7. conflicting block hash/geometry rejection without mutation;
8. equation-cap eviction and bounded retained state under thousands of unique repair parts;
9. block SHA mismatch never commits;
10. FQR1 vectors remain byte-for-byte compatible.

Storage tests must cover at least:

1. out-of-order verified block writes at correct offsets;
2. completed-block sidecar persistence and reopen;
3. crash/checkpoint model where metadata is never ahead of durable block data;
4. manifest mismatch rejection;
5. malformed sidecar rejection;
6. final file exact-byte equality;
7. memory fallback refuses files above the legacy 8 MiB bound.

Structural/native tests must prove:

1. FQR2 sender never calls whole-file `file.arrayBuffer()`;
2. encoded-frame arrays are not materialized for the full file;
3. receiver holds only one fountain block state;
4. old 8 MiB FQR1 path remains intact;
5. FQR2 version routing cannot feed FQR2 text into the FQR1 assembler;
6. no online signaling/WebRTC protocol files change as part of FQR2 core implementation unless a separately approved design requires it.

Exact-head repository gates remain the established `CI`, `Browser Reliability`, `GitHub Pages Mirror`, and `Native Builds` workflows. FQR2 may not be described as physically validated merely because these hosted gates pass.

## 17. Physical evidence gate

FQR2 production/default claims require a separate empirical ceremony using real Windows and Android devices.

At minimum the benchmark must record, without unique device identifiers:

- platform class and OS version class;
- camera/display resolution class where available;
- QR payload preset, ECC preset, and frame interval;
- file size;
- observed frame accept/loss counts;
- time to verified completion;
- whether receiver started at frame zero or mid-broadcast;
- peak JS heap where measurable;
- exact final file hash equality;
- PASS/FAIL.

The first implementation may ship behind the explicit experimental QR Stream mode before this evidence exists, but README claims must remain conservative. Raising the 64 MiB product cap, enabling multi-QR lanes, or advertising throughput requires this evidence.

## 18. Deferred follow-on work

The following are intentionally excluded from the first FQR2 implementation:

- 2x2 or higher multi-QR lanes per rendered frame;
- adaptive frame rate or payload size based on live decoder feedback;
- bidirectional optical acknowledgement/control channel;
- RaptorQ or other matrix/precode FEC;
- authenticated/encrypted offline optical envelopes;
- non-QR modulation;
- automatic product-cap increase above 64 MiB.

Each of those changes must be evaluated as a separate design because they alter camera workload, coding semantics, security claims, or resource bounds.

## 19. Implementation boundary

The expected first implementation touches primarily:

- `packages/core/` — new FQR2 manifest/part/fountain primitives while preserving `optical.js` FQR1;
- `apps/native/src/` — block-cyclic sender, version router, receiver orchestration, progress UI;
- `apps/web/src/` or a new shared storage module — only the minimal reusable OPFS random-access block store, without changing online transfer semantics;
- `tests/core/`, `tests/native/`, `tests/structure/` — deterministic fountain, resource-bound, persistence, and compatibility tests;
- README/protocol docs only after implementation behavior is exact-head verified.

The first FQR2 PR must not include production-release signing, TURN, signaling-rate-limit, or repository-governance changes. Those remain independent trust tracks (#8, #9, #15, #16, #17, #19, #45, #46).

## 20. Acceptance criteria

FQR2 core is implementation-complete only when all of the following are true:

- a test-only RED commit proves missing FQR2 behavior;
- deterministic fountain vectors pass;
- lossy-frame recovery passes deterministically;
- sender file-content memory is block bounded by design and structural test;
- receiver fountain memory is one-block/equation-cap bounded;
- verified blocks persist out of order without whole-file heap assembly;
- restart/reopen retains only durably committed block progress;
- FQR1 tests remain unchanged/green;
- exact-head CI/Browser/Pages/Native are green;
- final diff contains no signaling, TURN, signing, or governance scope creep;
- documentation states experimental status and does not claim unmeasured throughput or authentication.

Physical production-readiness is a later evidence gate and is not implied by implementation completion.
