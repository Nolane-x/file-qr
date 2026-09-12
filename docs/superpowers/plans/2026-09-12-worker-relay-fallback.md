# Worker Relay Fallback Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an encrypted Worker/Durable Object relay fallback while keeping direct WebRTC preferred and removing Cloudflare Realtime/TURN activation from the critical path.

**Architecture:** `SessionRoom` remains the lease/attempt authority. A separate relay WebSocket carries bounded encrypted frames; browsers derive attempt/direction traffic keys from a QR-only 256-bit relay secret. Direct WebRTC is attempted first; relay is used only after terminal direct failure or an explicit evidence-only force-relay mode.

**Tech Stack:** JavaScript ESM, Node 24 tests, Web Crypto, WebSocket/WebRTC, Cloudflare Workers/Durable Objects, Playwright.

**Spec:** `docs/superpowers/specs/2026-09-12-worker-relay-fallback-design.md`

## Global Constraints

- HKDF-SHA-256 -> two AES-256-GCM traffic keys per attempt.
- 64 KiB plaintext chunk; 70 KiB maximum encoded frame.
- 8 unacknowledged data frames maximum; cumulative ACK at least every 4 frames/250 ms.
- 30 s relay idle timeout; maximum 4 relay attempts per lease.
- No file plaintext, ciphertext history, relay secret, or retransmission buffer in Durable Object storage.
- Manual-code receivers never silently enter encrypted relay mode.
- Keep optional TURN support dormant and intact.

---

### Task 1: Structured QR Relay Secret

**Files:** `apps/web/src/receive-payload.js`, `apps/web/src/main.js`, `tests/web/receive-payload.test.mjs`, `tests/structure/web-lease-runtime.test.mjs`

**Interfaces:** `generateRelaySecret()`, `buildReceivePayloadUrl(baseUrl, code, relaySecret)`, `parseReceivePayloadDetails(input) -> { code, relaySecret } | null`; preserve legacy `parseReceivePayload(input) -> code | null`.

- [ ] Write tests first: valid URL returns normalized code plus 43-char base64url secret; short/invalid secret fails; plain code returns `relaySecret:null`; legacy parser still returns only code.
- [ ] Run `node --test tests/web/receive-payload.test.mjs` and require RED because new API is absent.
- [ ] Implement strict 32-byte secret generation with `crypto.getRandomValues` and URL build/parse helpers.
- [ ] Create one secret per sender lease, include only in QR/link receive URL, retain on receiver only when parsed from structured URL.
- [ ] Run focused tests GREEN and commit `feat: bind relay secret to QR receive payload`.

### Task 2: Relay Frame + Crypto Core

**Files:** create `packages/core/relay-frame.js`, `apps/web/src/relay-crypto.js`, `tests/core/relay-frame.test.mjs`, `tests/web/relay-crypto.test.mjs`.

**Interfaces:** protocol v1; kinds `data/control/ack/abort`; frame header carries attempt, sequence, kind, plaintext length, nonce prefix; browser crypto derives direction-specific key and encrypts/decrypts with authenticated metadata.

- [ ] Write frame tests for valid parse and rejection of bad version/attempt/sequence/kind/length/64 KiB plaintext/70 KiB encoded limits.
- [ ] Verify RED; implement fixed network-byte-order binary envelope; verify GREEN.
- [ ] Write crypto RED tests for round-trip and failure on wrong secret, attempt, direction, header/ciphertext mutation, replay/non-monotonic sequence.
- [ ] Implement HKDF-SHA-256 + AES-256-GCM with 64-bit random prefix + uint32 sequence nonce; authenticated data binds version/code/attempt/direction/kind/sequence/length.
- [ ] Run both suites GREEN and commit `feat: add encrypted relay frame protocol`.

### Task 3: Attempt-Scoped Relay Authority

**Files:** create `services/signaling/src/relay-authority.js`, `tests/signaling/relay-authority.test.mjs`; modify `services/signaling/src/index.js` and `tests/structure/signaling-lease.test.mjs`.

**Interfaces:** issue opaque capability, store only SHA-256 hash, validate live lease + exact role + exact active attempt + relay-attempt ceiling.

- [ ] Write RED tests for expired/wrong role/wrong attempt/missing/wrong capability/fifth relay attempt.
- [ ] Implement pure authority helpers and make tests GREEN.
- [ ] On receiver signaling admission issue sender+receiver per-attempt capabilities; persist hashes only. Return receiver capability in `connected`, sender capability in `peer-ready`; clear on attempt close.
- [ ] Add structure assertion that raw capabilities are never persisted; run GREEN and commit `security: scope relay authority to live attempts`.

### Task 4: Dedicated Durable Object Relay Path

**Files:** create `services/signaling/src/relay-forwarder.js`, `tests/signaling/relay-forwarder.test.mjs`, `tests/structure/relay-boundary.test.mjs`; modify `services/signaling/src/index.js`.

**Public route:** `GET /v1/sessions/{code}/relay?role=sender|receiver&attemptId=<id>&cap=<opaque>&remaining=<bytes>`.

- [ ] Write RED tests for wrong attempt, oversize frame, non-monotonic sequence, missing peer, duplicate role socket, byte-budget/control-budget overflow and malformed threshold.
- [ ] Implement Node-testable forwarding state with data budget `remaining + max(1 MiB, ceil(remaining*0.02))` and 4 MiB control budget.
- [ ] Add `/relay` WebSocket admission. Tag relay sockets separately; relay `ArrayBuffer` must never enter `parseClientSignalingMessage`.
- [ ] Forward accepted ciphertext immediately to opposite role; never write frame bytes to storage; enforce 30 s progress timeout bounded by lease expiry.
- [ ] Run focused signaling/structure suites GREEN and commit `feat: add bounded durable object relay path`.

### Task 5: Browser Relay Transport + Backpressure

**Files:** create `apps/web/src/relay-transport.js`, `tests/web/relay-transport.test.mjs`; modify `apps/web/src/signaling.js`, `tests/core/signaling-client.test.mjs`.

**Interfaces:** `buildRelayWebSocketUrl`, `connectRelay`, `createWorkerRelayTransport` with `send`, `sendControl`, receive callbacks, close, cumulative ACK and max-in-flight window.

- [ ] Write RED URL tests proving attempt/capability/remaining are encoded and long-lived sender token is absent.
- [ ] Write RED transport tests proving ninth unacknowledged frame blocks, ACK releases waiters, ACK every four frames, decrypt/protocol failure closes fail-closed, and close rejects pending senders.
- [ ] Implement minimal relay client/transport; run GREEN and commit `feat: add browser worker relay transport`.

### Task 6: Direct-First Fallback + Resume

**Files:** create `apps/web/src/transport-policy.js`, `tests/web/transport-policy.test.mjs`; modify `apps/web/src/main.js`, `tests/structure/browser-resume-sync.test.mjs`, `tests/structure/web-ui.test.mjs`.

**State:** `idle -> connecting-direct -> direct | direct-exhausted -> connecting-relay -> relay -> completed`.

- [ ] Write RED policy tests: direct first, transient disconnect does not fallback, terminal exhaustion does, code-only receiver refuses relay, evidence force-relay works, no silent mid-byte transport splice.
- [ ] Implement pure policy and make tests GREEN.
- [ ] Integrate capabilities/QR secret into attempt state. On terminal direct failure before committed bytes, close WebRTC and connect relay for same attempt; code-only path instructs QR scan instead.
- [ ] Reuse existing metadata, chunking, receive sink, validated resume offset and completion semantics. New receiver attempt gets new keys/capabilities/sequence zero and resumes at saved offset.
- [ ] UI truth: `Direct connection`, `Trying another connection path…`, `Relayed securely`; diagnostics `direct` or `worker-relay`.
- [ ] Run policy/resume/UI suites GREEN and commit `feat: fall back to encrypted worker relay`.

### Task 7: Hosted Production Relay Evidence

**Files:** create `tests/browser/production-worker-relay.mjs`, `.github/workflows/worker-relay-evidence.yml`, `tests/structure/worker-relay-evidence-workflow.test.mjs`; update `README.md`, `SECURITY.md`, `docs/architecture/PROTOCOL.md`.

- [ ] Write RED structure tests requiring production origin, two browser peers, explicit force-relay evidence mode, random payload, independent source/received SHA-256 equality, sanitized artifact and no relay secret/capability/code/IP/file bytes.
- [ ] Implement Playwright production probe and pinned Actions workflow. Artifact `worker-relay-evidence.json` is emitted only after total PASS.
- [ ] Document direct-first relay, QR-only server-blind confidentiality, dormant optional TURN and hosted-vs-physical evidence distinction.
- [ ] Run full `npm test` GREEN and commit `ci: prove production worker relay path`.

### Task 8: Full Verification + Migration

- [ ] Run `npm test`, `npm run build:web`, `npm run build:native-ui`, `npm run check:signaling`, `npm run check:web-deploy`.
- [ ] Open/refresh draft implementation PR and require exact-head CI/Browser/Pages/Windows/Android GREEN.
- [ ] Verify no PR #9 publisher-signing/release paths were modified.
- [ ] Merge only through protected main after exact-head checks.
- [ ] Require production signaling deployment success, then run hosted Worker Relay Evidence and require exact SHA-256 equality.
- [ ] Supersede PR #8 rather than merge the Cloudflare-TURN-specific verifier.
- [ ] Reframe #45 as provider-independent restrictive-network relay proof and keep it OPEN until a real restrictive-network transfer passes.
- [ ] Re-check PR #9 ancestry and re-sync only if main moved, preserving its exact audited signing/release scope.

## Self-Review

Spec coverage includes QR secret, crypto, attempt authority, binary isolation, quotas/backpressure, resume, direct-first selection, UI truthfulness, hosted evidence, physical gate, TURN coexistence and PR #9 isolation. No placeholders remain; server capability is admission-only and QR relay secret is encryption-only.
