# File QR Worker Relay Fallback Design

## Status

Approved architecture direction: preserve WebRTC peer-to-peer as the preferred data path and add a production relay fallback on the existing Cloudflare Worker + Durable Object signaling deployment when direct WebRTC cannot establish a usable transfer path. This design intentionally removes Cloudflare Realtime TURN activation from the critical path.

Design base: protected `main@fc72768055165d368a03985569b4f7f39c24bea2`.

## Problem

File QR currently prefers direct WebRTC with public STUN and can optionally obtain short-lived Cloudflare TURN credentials from `POST /v1/turn-credentials`. The repository correctly refuses to claim production relay coverage until real relay evidence exists. Cloudflare Realtime/TURN activation now crosses a billing/payment-method boundary that the project owner does not want to depend on.

The project therefore needs a relay path that:

- does not require Cloudflare Realtime/TURN activation;
- does not require a VPS, public UDP service, or external paid relay;
- preserves direct WebRTC as the fast path;
- uses the already deployed Worker + Durable Object session authority;
- remains bounded by the existing 10-minute session lease and per-attempt isolation;
- carries file bytes without persisting file contents in Durable Object storage;
- preserves end-to-end payload integrity and resume semantics;
- is testable through deterministic hosted evidence and later real restrictive-network evidence;
- does not weaken the repository's fail-closed release, signing, signaling, or physical-evidence gates.

## Existing architecture to preserve

The existing signaling Worker owns session allocation, lease expiry, sender authentication, one active receiver attempt, monotonic `attemptId`, stale-attempt rejection, WebSocket rendezvous, TURN authorization, and abuse-rate-limit boundaries. `SessionRoom` is already the authoritative per-session coordination object.

The web client already separates signaling from data transfer. Transfer bytes flow over an ordered `RTCDataChannel`; signaling flows over the Worker WebSocket. The transfer core already defines chunking, control messages, resume offsets, progress, and a final transfer-complete marker. The WebRTC layer already accepts injected ICE configuration and implements one controlled ICE restart per attempt.

This design keeps those contracts rather than replacing them.

## Considered approaches

### A. Public/free TURN credentials

Rejected. It minimizes code but creates an external reliability, abuse, ownership, and privacy dependency that cannot be made authoritative by this repository. Public TURN credentials also conflict with the current fail-closed evidence model.

### B. Self-hosted coturn

Rejected for the project's zero-billing operating constraint. It is technically conventional and preserves WebRTC semantics, but it requires a continuously reachable host, public networking, and operational ownership outside the existing free deployment.

### C. Worker/Durable Object WebSocket relay fallback

Selected. The existing Worker deployment is already the trusted rendezvous authority. The relay can reuse the current session lease and attempt identity while introducing a dedicated binary-forwarding path with independent admission, framing, backpressure, quotas, and evidence. Direct WebRTC remains primary; the relay is a fallback transport, not a replacement for peer-to-peer transfer.

## High-level architecture

Introduce a transport boundary beneath the existing transfer state machine:

```text
File transfer state machine
        |
        v
TransferTransport
   |                 |
   |                 +--> WorkerRelayTransport (fallback)
   +--> WebRTCDataChannelTransport (preferred)
```

The application must not duplicate file-transfer semantics for each transport. Chunk production, receive sink behavior, resume offsets, progress, completion, and final hash/integrity rules stay above the transport boundary.

The selection flow is:

1. allocate/join the normal File QR session;
2. attempt WebRTC with STUN and the existing ICE-recovery policy;
3. if WebRTC connects, use `WebRTCDataChannelTransport` exactly as today;
4. if WebRTC reaches terminal exhaustion before useful transfer progress, negotiate relay fallback for the same active `attemptId`;
5. establish dedicated relay WebSockets through the same `SessionRoom`;
6. forward only bounded framed relay traffic for that attempt;
7. finish through the same transfer-complete/integrity pipeline;
8. close relay sockets without destroying the still-valid sender session lease.

A transport switch is allowed only before bytes have been committed for the current attempt, or after an explicit resumable restart boundary. Silent mid-chunk transport splicing is prohibited.

## Relay endpoint and session authority

Add a dedicated WebSocket route distinct from signaling, for example:

```text
GET /v1/sessions/{code}/relay?role=sender|receiver&attemptId=<n>&cap=<opaque>
```

The exact path may change during implementation, but the following authority rules are mandatory:

- the room must exist and its lease must still be live;
- `attemptId` must exactly equal the room's current active attempt;
- only one relay socket per role may be active for that attempt;
- the sender must authenticate with sender authority derived from the existing sender capability;
- the receiver must present a relay capability issued for that exact session/attempt;
- capabilities must be opaque, high entropy, short-lived, and never written to logs or evidence artifacts;
- stale attempts must receive no relay access even if a stale socket remains open;
- session expiry must close relay sockets and invalidate capabilities;
- closing one receiver attempt must not destroy the sender lease or future attempts.

The signaling WebSocket and relay WebSocket remain separate interfaces so binary relay traffic can never enter the JSON signaling parser or signaling message-size policy.

## Relay capability negotiation

The relay must not be open merely because a user knows the human receive code.

When the receiver is admitted for an `attemptId`, the room issues an opaque receiver relay capability bound to:

- session identity;
- active `attemptId`;
- role `receiver`;
- lease expiry.

The sender already possesses a private sender authority. The server may derive or issue a sender relay capability for the active attempt without exposing the long-lived sender token to relay frame metadata.

Capabilities are transport admission tokens only. They are not file-encryption keys.

## Payload confidentiality

Relay mode must not send plaintext file chunks to the Durable Object.

For QR-based joins, the sender generates a fresh 256-bit relay secret for the session and includes it in the structured receive payload carried by the QR code. The Worker receives the normal room identifier but never receives this relay secret as configuration or stored session metadata.

Both clients use Web Crypto only. For each `attemptId`, they derive two independent 256-bit traffic keys from the relay secret with HKDF-SHA-256: one for sender-to-receiver frames and one for receiver-to-sender frames. The HKDF `info` value binds protocol version, compact receive code, `attemptId`, and traffic direction. Each direction uses AES-256-GCM.

Each traffic direction generates a fresh 64-bit random nonce prefix when the relay socket is established. The AES-GCM 96-bit nonce is `noncePrefix || uint32(sequence)`. Sequence starts at zero, increments exactly once for every encrypted frame, and the connection aborts before sequence wrap. Because directions use distinct traffic keys and each new attempt derives fresh keys, nonce reuse across role, reconnect, and attempt boundaries is prohibited by construction.

Authenticated additional data contains protocol version, compact receive code, `attemptId`, traffic direction, frame kind, sequence, and declared plaintext length.

Required properties:

- a fresh 256-bit relay secret per sender lease;
- two distinct derived AES-256-GCM traffic keys per `attemptId`;
- HKDF-SHA-256 context binds room, attempt, version, and direction;
- unique 96-bit nonce for every encrypted frame under one traffic key;
- sequence, role/direction, kind, length, and attempt identity are authenticated;
- authentication failure aborts the attempt fail-closed;
- replayed or non-monotonic sequence aborts the relay attempt;
- the Worker forwards ciphertext and minimal routing metadata only;
- relay secret/key material is never logged, stored in Durable Object storage, uploaded as CI evidence, or written to repository configuration.

The human receive-code-only path cannot claim the same server-blind confidentiality because the code is already visible to the rendezvous service. Therefore automatic encrypted relay fallback is enabled only when the receiver joined with a structured payload containing the relay secret. A code-only receiver that exhausts direct WebRTC must be asked to scan the sender QR rather than silently downgrade confidentiality. A separate human-entered relay recovery secret is intentionally outside the first implementation.

This distinction must be visible in tests and documentation. The implementation must never label TLS-only Worker forwarding as end-to-end encrypted relay.

## Relay frame protocol

Relay traffic uses a compact binary envelope independent of WebRTC control-message JSON. Each frame must include enough authenticated metadata to reject replay, reordering, wrong-attempt traffic, and role confusion.

Conceptual fields:

```text
version
attemptId
sequence
kind            # data | control | ack | abort
plaintextLength
noncePrefix     # carried during relay handshake, not repeated in every data frame
ciphertext
```

The authenticated plaintext payload for `data` contains the existing transfer bytes. Control frames represent only transport-local events such as relay-ready, flow-control acknowledgement, resume boundary, and relay abort. Existing file-transfer completion and resume semantics remain owned by the transfer layer above.

Plaintext `data` payloads are capped at the existing 64 KiB transfer chunk size. The entire encoded relay frame, including metadata and AES-GCM tag, is capped at 70 KiB. A larger frame is rejected before forwarding. This keeps relay framing comfortably below platform WebSocket message ceilings and prevents a second data-chunk regime.

## Backpressure and bounded resource use

The relay must be safe under a slow receiver, disconnected peer, malicious client, or stalled browser.

The first implementation uses these hard defaults:

- maximum plaintext data chunk: 64 KiB;
- maximum encoded relay frame: 70 KiB;
- maximum unacknowledged data frames per direction: 8;
- therefore maximum application data intentionally in flight per direction: 512 KiB;
- receiver sends cumulative acknowledgement at least every 4 data frames and at least once every 250 ms while data is flowing;
- sender pauses at 8 unacknowledged frames and resumes only after cumulative acknowledgement reduces the window;
- relay socket idle timeout: 30 seconds without valid protocol progress, always bounded by lease expiry;
- protocol-violation threshold: first cryptographic/authentication/replay violation aborts immediately; structural malformed-frame violations abort after 3 within an attempt;
- maximum relay attempts per sender lease: 4; direct WebRTC attempts are unaffected;
- per-attempt forwarded ciphertext budget: declared remaining file bytes plus the greater of 1 MiB or 2% protocol overhead, with control/ack frames separately capped to 4 MiB total;
- a resumed attempt computes its data budget from the validated remaining byte count, not original file size.

The room forwards a valid frame only when the opposite relay socket for the same current attempt is attached. It does not retain file frames for later delivery and does not implement retransmission storage. Sender-side backpressure/retry logic owns unacknowledged chunks.

No file payload, ciphertext history, retransmission buffer, or relay secret may be written to Durable Object storage. Only small session/attempt admission state, counters, nonce-prefix registration, and abuse-control metadata may be persisted.

The Worker must never buffer an entire file or a large retransmission history.

## Resume behavior

File QR's existing resume offset remains authoritative. Relay mode does not invent a second resume model.

If a relay attempt disconnects:

1. the receiver keeps already committed bytes through the existing receive sink;
2. a new receiver attempt receives a new `attemptId` and therefore new derived traffic keys;
3. the receiver communicates its validated resume offset through the existing transfer protocol;
4. the sender restarts from that offset;
5. sequence numbers and nonce prefixes restart because the encryption keys are attempt-specific;
6. the new attempt receives a fresh per-attempt forwarding budget based on remaining bytes.

A stale relay socket from the previous attempt cannot append bytes to the new attempt.

## Client transport state machine

Add explicit transport state rather than scattered fallback booleans:

```text
idle
 -> connecting-direct
 -> direct
 -> direct-exhausted
 -> connecting-relay
 -> relay
 -> completed

Any active state may -> failed/aborted.
```

Rules:

- direct is always attempted first unless a test-only injection explicitly forces relay;
- a transient `disconnected` state still uses the existing grace/restart behavior;
- relay fallback begins only after direct recovery is exhausted or a deterministic relay-only test mode is enabled;
- transport choice is per receiver attempt;
- sender lease lifetime is independent of transport lifetime;
- UI progress and resume state do not reset merely because transport changed before transfer start;
- transport identity is recorded in sanitized diagnostics as `direct` or `worker-relay`, never as `turn`.

## UI behavior

The normal user path should remain simple.

- Preferred state: `Direct connection`.
- During recovery: `Trying another connection path…`.
- Successful fallback: `Relayed securely`.
- If the receiver entered only the human code and direct connectivity fails: explain that secure relay fallback requires scanning the sender QR; do not expose implementation jargon unless expanded by the user.
- Never claim `TURN`, `peer-to-peer`, or `end-to-end encrypted relay` when the corresponding condition is not true.

No new billing or Cloudflare Realtime setup step appears in product UI or operator setup.

## Server implementation boundaries

The existing `SessionRoom` remains session authority, but relay forwarding should be isolated from signaling parsing. Implementation should prefer focused helpers/modules for:

- relay admission/capability validation;
- binary frame parsing/validation;
- relay pair state and bounded counters;
- client-side relay crypto/framing;
- transport abstraction/adaptation.

Do not turn `services/signaling/src/index.js` or `apps/web/src/main.js` into monolithic relay implementations. Existing patterns may be extracted only where necessary for this feature.

## Abuse and privacy model

Threats covered:

- random Internet clients attempting to use the Worker as an open relay;
- stale-session and stale-attempt reuse;
- oversized frames;
- unbounded in-flight buffering;
- repeated protocol violations;
- replay/reordering within an encrypted relay attempt;
- passive observation of file plaintext by the relay infrastructure on QR-secured relay paths;
- credentials or keys leaking into logs/evidence.

Threats not claimed as solved:

- a compromised sender or receiver endpoint;
- denial of service against the Cloudflare account itself;
- server-blind confidentiality for human-code-only fallback without an out-of-band relay secret;
- universal availability on networks that block HTTPS/WSS to the File QR Worker origin.

Evidence and documentation must state these limits precisely.

## Verification strategy

Implementation follows TDD and must preserve every current required check.

### Unit/structure tests

Tests must prove at minimum:

- relay admission rejects expired session, wrong role, wrong attempt, stale capability, duplicate role socket, and missing capability;
- signaling parser never accepts relay binary frames;
- frame parser rejects oversize, malformed version, invalid sequence, wrong attempt, and invalid kind;
- HKDF/AES-GCM round trip succeeds for two clients sharing the QR relay secret;
- wrong secret, wrong attempt, modified metadata, modified ciphertext, replayed sequence, non-monotonic sequence, and nonce misuse paths fail closed;
- bounded 8-frame in-flight window applies backpressure and cannot grow without acknowledgements;
- 64 KiB plaintext and 70 KiB encoded frame ceilings are enforced;
- idle timeout, malformed-frame threshold, four-relay-attempt ceiling, and per-attempt byte budget fail closed;
- no file payload or ciphertext history is persisted to room storage;
- code-only join cannot silently enter the encrypted relay path;
- direct transport remains the default preference;
- fallback occurs only after direct exhaustion;
- resume uses the validated existing offset and a fresh attempt key.

### Browser integration tests

Add deterministic browser coverage that can force direct failure without relying on Internet topology. The test then establishes two clients through the production-compatible Worker relay path, transfers random bytes, and verifies exact payload integrity.

A separate test must prove direct WebRTC remains selected when direct connectivity succeeds.

### Hosted production relay evidence

Replace the TURN-specific proof contract with a provider-independent File QR relay proof. A genuine PASS requires:

- production signaling origin;
- real session allocation;
- two browser peers;
- forced direct-path unavailability or explicit evidence-mode relay selection;
- selected transport reported as `worker-relay` on both peers;
- random payload transferred through the production relay endpoint;
- exact source/received SHA-256 equality;
- sanitized evidence only;
- no relay secret, capability, receive code, IP address, or file content in artifacts.

A hosted PASS proves the production relay transport, not arbitrary restrictive-network behavior.

### Physical restrictive-network evidence

Issue #45 remains an empirical gate. After hosted proof is green, at least one real transfer must succeed on a topology where direct peer connectivity is unavailable or demonstrably blocked, with exact payload integrity and sanitized transport evidence.

## Migration of current TURN work

### Draft PR #8

Do not merge the existing TURN-specific verifier as-is. Preserve its useful fail-closed evidence ideas, but supersede the transport assumption. After this relay implementation is integrated, either:

- replace #8's three-file TURN verifier with a Worker-relay verifier on a freshly synchronized branch, or
- close #8 as superseded by a new relay-evidence PR if keeping history clearer.

No action on #8 occurs until the new relay implementation and its repository tests are ready.

### Issue #45

Retitle/reframe from Cloudflare TURN-specific physical proof to provider-independent production relay restrictive-network proof. Closure still requires hosted relay evidence plus a real restrictive-network transfer. The standard is not weakened.

### TURN bootstrap and `/v1/turn-credentials`

Do not remove TURN support in the first relay-fallback implementation. Keep it optional and dormant so a future operator may enable TURN without redesigning clients. Cloudflare Realtime billing/activation is no longer required for File QR's production fallback claim.

Once Worker relay evidence is mature, a later cleanup may deprecate Cloudflare-specific bootstrap machinery if maintaining two relay providers is no longer valuable. That cleanup is outside this design.

## Interaction with release/signing work

PR #9 and issues #16/#19 remain independent. This relay work must not modify the audited publisher-signing/release candidate branch. Any later synchronization must preserve its exact trust requirements and rerun fresh evidence.

The newly verified immutable-release repository setting is compatible with this design but does not prove relay behavior.

## Rollout

1. land design and implementation behind normal direct-first behavior;
2. deploy signaling Worker changes through the existing trusted deployment path;
3. verify direct path regression coverage;
4. run hosted production Worker-relay evidence;
5. update #8/#45 semantics only after evidence is real;
6. run physical restrictive-network evidence;
7. only then claim File QR has a production relay fallback independent of Cloudflare Realtime TURN.

No step may relabel synthetic/unit evidence as production or physical evidence.

## Success criteria

This design is complete only when implementation evidence demonstrates all of the following:

- direct WebRTC behavior remains available and preferred;
- File QR can complete a transfer through `worker-relay` with exact payload integrity when direct connectivity is unavailable;
- QR-secured relay file bytes are encrypted end to end before Worker forwarding with HKDF-SHA-256 + AES-256-GCM and unique nonces;
- relay admission is session/attempt scoped and cannot be used as an open generic relay;
- buffering and byte usage obey the fixed bounded-window/frame/attempt limits above;
- resume remains correct across relay attempt interruption;
- hosted relay proof is green on the production deployment;
- real restrictive-network evidence is separately recorded;
- no Cloudflare Realtime/TURN activation or payment method is required for the fallback path;
- existing release/signing/physical-camera trust gates remain intact.
