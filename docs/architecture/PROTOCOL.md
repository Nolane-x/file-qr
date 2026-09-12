# File QR Protocol v0.4

## Online lease and signaling

The web and native shells share the same rendezvous model. A sender creates a session through the signaling service and receives a 10-character Crockford Base32 receive code, a private sender token, and an absolute expiry time. The receive code is the receiver capability; the sender token is separately required to occupy the sender role. Signaling state expires exactly 600 seconds after session creation.

The lease remains reusable while `Date.now() < expiresAt`. A room has one sender; at most one receiver attempt is active at a time. Completed or failed receiver attempts do not consume the remaining lease, so receivers may download sequentially during the same 10-minute window. A receiver already admitted before expiry may finish an already-open transfer after the signaling lease closes.

Each receiver admission receives a monotonic `attemptId`. `peer-ready`, WebRTC descriptions, ICE candidates, Worker-relay capabilities and transfer-attempt state are associated with that attempt. The clients ignore stale signaling whose `attemptId` does not match the current attempt. Receiver readiness is persisted by signaling so a sender reconnect cannot lose an already-admitted receiver.

## ICE, STUN, and optional TURN

Each direct WebRTC attempt starts with the default Cloudflare and Google STUN servers. The client also requests optional TURN configuration from `POST /v1/turn-credentials` using the current lease code.

If TURN is unconfigured or unavailable, the normal product path continues with the default STUN configuration. When TURN is configured, the signaling service keeps the long-lived TURN key server-side, validates that the File QR lease is still alive, and returns only validated short-lived TURN ICE credentials. TURN capability does not change the file protocol and is not a universal-NAT-traversal guarantee.

TURN remains optional. The encrypted Worker relay described below is a separate File QR transport and does not require Cloudflare Realtime/TURN activation.

## Direct-first transport policy

The normal online path is direct-first:

`idle -> connecting-direct -> direct | direct-exhausted -> connecting-relay -> relay -> completed`

A transient direct disconnect remains inside bounded WebRTC recovery. The sender owns at most one ICE restart per receiver attempt so the peers do not create offer glare. Worker relay is considered only after terminal direct exhaustion and only while no new file bytes have been committed in that attempt. If committed bytes are already non-zero, a same-attempt transport switch/splice is blocked; the attempt fails closed and a later receiver attempt may resume from the durable absolute byte offset.

A manually typed receive code has no QR relay secret and therefore cannot silently enter Worker relay. It remains on the direct/optional-TURN WebRTC path. `?forceRelay=1` is an **evidence-only** mode that skips direct WebRTC so CI can deterministically prove the Worker relay; it still requires a valid structured QR/link secret and is not a user-facing production transport selector.

## Encrypted Worker relay

### Structured QR secret and admission authority

When a sender lease is created, the browser generates an independent 32-byte (256-bit) random relay secret. The structured receive URL carries the receive code and relay secret in the **URL fragment** (`#receive=...&relay=...`), not in the HTTP query. URL fragments are not included in the navigation request to the web origin, so the relay secret is not transmitted to the web server merely by opening the QR/link. The receiver parses the fragment locally and immediately scrubs that fragment from the browser-visible URL before starting the transfer. Legacy `?receive=...` remains code-only compatibility input; any `relay` value supplied in the HTTP query is rejected fail-closed. The secret is base64url without padding and is intended to travel only through the QR/link. The signaling service does not need the relay secret for admission and does not persist it.

Server admission uses a different authority. Every receiver attempt gets role-specific opaque relay capabilities bound to the live lease and exact `attemptId`. The receiver capability is returned with its signaling `connected` handshake; the sender capability is delivered in the matching `peer-ready`. The Durable Object stores only capability hashes. Raw capabilities are not persisted.

A relay WebSocket is admitted through:

`GET /v1/sessions/{code}/relay?role=sender|receiver&attemptId=<id>&cap=<opaque>&remaining=<bytes>&nonce=<prefix>`

`remaining` is required for the sender and omitted by the receiver. The long-lived sender signaling token is not placed in the relay URL. Admission requires a live lease, exact active attempt, correct role and matching attempt-scoped capability.

### Traffic keys and authenticated frames

The two browsers derive independent traffic keys for `sender-to-receiver` and `receiver-to-sender` with **HKDF-SHA-256** from the QR-only relay secret. Key derivation binds the compact receive code, `attemptId` and traffic direction. Relay payloads are protected with **AES-256-GCM**.

Each encrypted frame uses protocol v1 relay framing and carries bounded authenticated metadata: protocol version, attempt identity, monotonic uint32 sequence, frame kind and plaintext length. The frame kinds are `data`, `control`, `ack`, and `abort`. The per-direction random 64-bit nonce prefix plus sequence number forms the 96-bit AES-GCM nonce. The authenticated data also binds the receive code and traffic direction.

Replay, non-monotonic sequence, wrong attempt, wrong direction, modified header/ciphertext, authentication failure and nonce-sequence exhaustion fail closed.

File `data` frames contain at most **64 KiB** plaintext, and the encoded frame is bounded to the relay protocol maximum. The sender may have at most **8 unacknowledged** data frames in flight. The receiver sends cumulative encrypted ACKs at least **every 4 data frames or 250 ms**, whichever occurs first. This bound is independent of browser `bufferedAmount` and prevents unbounded client retransmission pressure.

### Relay forwarding and quotas

The Durable Object tags signaling and relay sockets separately. Relay binary frames never enter the JSON signaling parser. Accepted ciphertext is forwarded immediately to the opposite relay role and is not written to Durable Object storage. The Worker persists only the bounded lease/attempt/capability/quota metadata required to enforce the protocol; it keeps no file plaintext, relay ciphertext history, or retransmission buffer.

The sender's initial relay admission declares a conservative remaining-byte ceiling. After the encrypted `resume-request` is received and its absolute offset has been **validated** against the offered file size, the sender sends a transport-local plaintext JSON declaration:

`{"type":"relay-budget","remaining":<file.size - validatedOffset>}`

This `relay-budget` message is not part of the encrypted peer control stream and is not forwarded to the receiver. It exists only so the Worker can tighten its forwarding quota after the receiver's encrypted resume decision. The declaration is accepted only from the sender, only before the first data frame, and only when it decreases or preserves the current remaining-byte ceiling. Any attempt to increase the quota or change it after data begins fails closed.

The sender data budget is the declared remaining plaintext plus bounded framing allowance. Relay control traffic has its own fixed budget. One lease may start at most **4 relay attempts**; aggregate declared sender bytes are bounded to 512 MiB. A relay path that makes no valid protocol progress for **30 s** is closed, while the exact 600-second lease expiry remains authoritative.

### Shared transfer semantics and resume

Worker relay does not invent a second file-transfer state machine. Direct WebRTC and Worker relay reuse the same protocol-v2 logical controls:

1. **`file-offer`** — sender announces stable `fileId`, file name, byte size, MIME type, and default 64 KiB chunk size.
2. **`resume-request`** — receiver opens the receive sink for that lease/file identity, determines the durable partial length, validates the absolute offset in `0..file.size`, then sends the offset.
3. **File data** — direct mode uses ordered RTCDataChannel binary chunks; Worker-relay mode uses ordered authenticated encrypted `data` frames. Both begin exactly at the validated absolute offset.
4. **`transfer-complete`** — sender declares stable `fileId` and full file size after all requested bytes have been sent.
5. **`complete-ack`** — receiver accepts completion only after identity, size and local byte count match, finalizes the sink, then acknowledges. Sender success is authoritative only after the matching acknowledgement.

A new receiver attempt gets a new `attemptId`, new admission capabilities, fresh relay nonce prefixes and sequence zero. A durable partial may be resumed in that new attempt from its validated absolute offset. Same-attempt direct/relay splicing after committed data is explicitly blocked.

## WebRTC transfer protocol v2

Every direct receiver attempt owns one WebRTC peer connection and one ordered `file-qr` RTCDataChannel. File QR control messages are JSON objects with explicit protocol version `v: 2`; legacy or future control versions are rejected instead of guessed compatible. Binary RTCDataChannel messages contain file bytes.

The direct transfer sequence is the same `file-offer` → `resume-request` → file bytes → `transfer-complete` → `complete-ack` sequence defined above. Chunks are ordered and backpressure-aware; progress is measured against the full file size rather than the remaining suffix only.

A failed or disconnected attempt may leave a resumable partial. OPFS-backed browser partial data can survive a retry/reload in the same browser profile; the in-memory fallback survives only within the current runtime. A later receiver attempt for the same offered file can request the validated absolute byte offset already present in its sink.

## Attempt isolation and direct ICE recovery

SDP and ICE messages are scoped to the current `attemptId`. Remote ICE candidates received before a remote description are buffered and flushed after that description is installed. Replayed readiness or stale signaling cannot replace an active or newer attempt.

The sender owns ICE restart to avoid offer glare. A disconnected state receives a bounded grace period; a hard failure permits at most one ICE restart for that receiver attempt. The receiver waits for the sender-owned recovery. Terminal direct exhaustion either activates eligible QR-authorized Worker relay before any newly committed bytes or ends only that attempt; it does not consume a still-open 600-second lease.

## Hosted Worker-relay evidence

Browser Reliability starts local Wrangler signaling and Vite web runtimes and performs an explicit `forceRelay=1` transfer with fresh random bytes. It observes the dedicated `/relay` WebSocket on both peers and requires independent source and received SHA-256 equality. The test additionally requires the QR relay authority to reside in the URL fragment and verifies that the receiving page scrubs that fragment after consuming it.

After this implementation is integrated and deployed from trusted `main`, the manual `Worker Relay Evidence` workflow repeats the proof against `https://fileqr.nolane-file.workers.dev`. Its artifact contains only sanitized result metadata and hashes; receive codes, sender tokens, relay capabilities, QR relay secrets, client IPs and file bytes are excluded.

Hosted evidence proves the deployed relay path in that topology. It is not a substitute for physical restrictive-network evidence and does not establish universal connectivity.

## Offline optical path

The optical path is versioned separately from online protocol v2 and Worker relay. It does not use signaling, STUN, TURN, the online lease, or the QR-only relay secret, and neither optical version authenticates the sender.

### QR Stream v0.1 compatibility format

Optical v0.1 remains the conservative compatibility path. A file envelope contains UTF-8 metadata plus exact file bytes. The envelope is divided into independent frames:

`FQR1|STREAM_ID|SEQUENCE|TOTAL|CRC32|BASE64URL_PAYLOAD`

Each frame has an independent CRC32. The receiver deduplicates frames, tracks missing sequence numbers, and reconstructs only after every frame is present. The sender loops the sequence so camera misses can be filled on later passes. CRC32 detects accidental corruption; it is not cryptographic authentication. The existing v0.1 sender keeps its 8 MiB admission limit and ten-minute broadcast stop.

### QR Stream v0.2 experimental block-fountain format

FQR2 is an experimental offline transport. The initial implementation admits files up to **64 MiB**, uses fixed **64 KiB logical blocks**, defaults to **768-byte source symbols**, and keeps FQR1 available as the default compatibility sender mode. The native camera receiver routes exact `FQR1|` and `FQR2|` prefixes before either decoder mutates state.

A manifest frame is:

`FQR2|M|STREAM_ID|FILE_SIZE|BLOCK_BYTES|SYMBOL_BYTES|BLOCK_COUNT|METADATA_CRC32|BASE64URL_METADATA`

A part frame is:

`FQR2|P|STREAM_ID|BLOCK_INDEX|SEQ_NUM|SEQ_LEN|BLOCK_LENGTH|BLOCK_SHA256|PAYLOAD_CRC32|BASE64URL_PAYLOAD`

FQR2 uses a 12-character Crockford-style stream identifier. `BLOCK_BYTES` is fixed at `65536`. `SYMBOL_BYTES` is bounded to 256..900 bytes and defaults to 768. Metadata is UTF-8 JSON containing only `name` and `type`, is capped at 2048 bytes, and is protected by CRC32. Part payloads are also CRC32-checked before decoding.

For each block, sequence numbers `1..K` are systematic source symbols. Later sequence numbers deterministically select and XOR source-symbol indexes using the protocol's SHA-256-bound xoshiro256** selector and harmonic degree distribution. These repair symbols are deterministic protocol behavior, not sender authentication.

The receiver owns at most one incomplete block decoder at a time. Unknown/other-block parts are not queued while another block is active. Unresolved equations are capped at `3 * K`, and remembered sequence identities are capped at `4 * K`, with deterministic eviction. Camera ingestion is single-flight; a frame observed while asynchronous FQR2 acceptance is already running is dropped rather than accumulated in an unbounded queue.

CRC32 filters corrupted individual frame payloads. A reconstructed block is not durable or exposed until its declared SHA-256 digest matches. SHA-256 provides block integrity against accidental/corrupt reconstruction but does **not** authenticate who generated the stream.

Verified blocks are written at exact offsets to random-access persistent storage, with block data committed before sidecar progress. Reopen trusts only sidecar-recorded committed blocks whose manifest identity and durable byte boundaries validate. Whole-file memory fallback is allowed only when `FILE_SIZE <= 8 MiB`; larger FQR2 receives fail closed when persistent random-access storage is unavailable. Finalization requires every logical block and the exact declared file size.

The FQR2 sender reads one 64 KiB block at a time through file slices and does not pre-read the whole file or precompute all frames. FQR2 continues until explicitly stopped/runtime close and does not inherit the v0.1 ten-minute broadcast stop.

FQR2 remains experimental: this protocol description is not a throughput, range, universal-camera, sender-authentication, or production-readiness claim. Physical Windows/Android camera evidence is required before raising limits, making FQR2 the default, or publishing performance claims.
