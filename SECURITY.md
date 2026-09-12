# Security

## v0.4 threat model

File QR is designed to avoid server-side file custody. Online file payloads use either an encrypted direct WebRTC RTCDataChannel or, after bounded terminal direct failure, a QR-authorized encrypted **Worker relay**. The Worker relay forwards ciphertext live and does not persist file plaintext, relay ciphertext history, or retransmission buffers. The offline path remains screen-to-camera QR Stream.

### Online sessions

- Receive codes contain 50 bits of random Crockford Base32 entropy and expire exactly 600 seconds after session creation. The receive code is a bearer capability, not an authenticated user identity.
- A separate random sender token is required to occupy the sender role. The receive code alone is not sufficient to become the sender.
- The 10-minute lease is reusable while `Date.now() < expiresAt`. A completed or failed receiver attempt does not consume the remaining lease.
- A room admits one sender; at most one receiver attempt is active at a time. Multiple receivers may download sequentially during the same live lease.
- Every receiver admission receives a monotonic `attemptId`. SDP, ICE candidates, receiver readiness, relay authority, and transfer-attempt state are isolated by that identity so stale messages from an older attempt are ignored rather than applied to a newer peer.
- A receiver admitted before lease expiry may finish an already-open transfer after signaling expires. No new receiver is admitted at or after the expiry instant.
- Sender signaling may reconnect while the lease is open. Receiver readiness is persisted so a reconnect cannot silently lose an already-admitted receiver.
- WebRTC ICE recovery permits at most one sender-owned ICE restart per receiver attempt; the passive peer waits rather than creating offer glare. A second hard failure exhausts direct recovery for that attempt.
- File QR is direct-first. A transient disconnect never activates Worker relay. Terminal direct exhaustion may switch to Worker relay only before new file bytes have been committed in that attempt. Once bytes have been committed, same-attempt transport splicing is blocked and recovery requires a new attempt/resume boundary.
- Durable Object alarms remove rendezvous/relay-control state after expiry. The service does not retain file bytes.
- Cloudflare STUN and Google STUN provide discovery redundancy. STUN is not file relay or file storage.

### Encrypted Worker relay boundary

The Worker relay deliberately separates **admission authority** from **payload confidentiality**.

- The sender creates one random 256-bit relay secret per lease. It is encoded only in the structured File QR QR/link and is not part of the manually typed 10-character code.
- A manual code receiver therefore does not and cannot silently enter encrypted Worker relay mode. When direct recovery is exhausted without a QR/link relay secret, the attempt fails with an instruction to scan the sender QR instead of downgrading confidentiality.
- The QR-only relay secret is never used as server admission authority. Signaling independently issues per-attempt sender/receiver relay capabilities. The Durable Object persists only capability hashes, not raw capabilities.
- Relay capabilities are **attempt-scoped** and role-scoped. Admission requires a live lease, the exact active attempt, the exact role and the matching capability hash.
- Browser peers derive direction-specific traffic keys from the QR-only secret with **HKDF-SHA-256** and encrypt relay frames with **AES-256-GCM**. The code, attempt identity, traffic direction and authenticated frame metadata are bound into key/AAD processing.
- Relay frame sequence numbers are monotonic. Replay, wrong-attempt frames, direction/role misuse, authentication failure and sequence violation fail closed.
- File data uses bounded 64 KiB plaintext chunks. The sender has at most 8 unacknowledged data frames in flight. The receiver emits cumulative encrypted acknowledgements at least every four data frames or 250 ms.
- The Worker enforces a 30-second relay idle timeout, no more than four relay attempts per lease, a bounded control budget, and a 512 MiB aggregate declared-data ceiling.
- After a receiver validates its resumable absolute offset, the sender may send a transport-local `relay-budget` declaration to tighten the server-visible remaining-byte quota. The quota may only decrease and only before the first data frame; the declaration is not forwarded to the peer.
- The Worker parses only the bounded relay envelope metadata needed for enforcement and forwards accepted ciphertext immediately to the opposite role. File plaintext, relay ciphertext history, the QR-only relay secret and retransmission buffers are never written to Durable Object storage.
- `?forceRelay=1` is an evidence-only mode used by deterministic browser verification. It is not a production transport selector exposed to users and still requires the QR-only secret.

The Worker is therefore not trusted with file plaintext, but it remains part of the availability and metadata threat model: it observes connection timing, role/attempt-scoped relay activity and bounded frame metadata, and it can drop/delay traffic. AES-GCM authentication prevents it from modifying ciphertext into accepted plaintext without detection, but the design does not claim traffic-analysis resistance or anonymity.

### Optional TURN boundary

- TURN remains an **optional** WebRTC ICE capability. Worker relay fallback does not depend on Cloudflare Realtime/TURN activation.
- The browser may request short-lived TURN credentials from `POST /v1/turn-credentials` using the current live File QR lease code.
- When TURN is not configured, the endpoint returns `404 {"error":"turn-not-configured"}` and the normal client continues with the default STUN configuration.
- Long-lived TURN key material remains server-side. When configured, the signaling Worker validates that the File QR lease is still alive before asking the TURN provider for short-lived ICE credentials.
- Repository automation separates Cloudflare Calls TURN-key authority from Worker secret-write authority and keeps production mutation on trusted `main`; generated key material is masked and rollback removes newly-written TURN secrets/key material if activation fails.
- TURN code presence is not proof that production TURN is active. Any TURN-relayed WebRTC claim requires its own real evidence.

### Evidence boundaries

The local Browser Reliability workflow exercises encrypted Worker relay against local Wrangler/Vite runtimes using fresh random bytes and exact independent SHA-256 equality. After the code is integrated to trusted `main` and production deployment succeeds, the manual secretless `Worker Relay Evidence` workflow performs the same class of proof against the canonical production web origin and publishes only sanitized PASS evidence.

Hosted evidence proves that the production Worker relay path can carry exact encrypted payload bytes in that hosted browser topology. It does **not** prove universal NAT traversal, every carrier/firewall topology, or physical restrictive-network behavior. A separate physical restrictive-network relay transfer remains required before making that broader claim.

### Web camera scanner and clipboard

- Browser camera permission is requested only after a user presses **Scan QR**.
- Camera streams are released after decode, cancel, reset, transfer start, failure, or page exit.
- Native Android requests camera permission only for a user-initiated scan, uses the back camera, and limits recognition to QR codes.
- Scanned QR strings are parsed for a File QR receive capability only. The application never navigates automatically to arbitrary scanned URLs.
- Clipboard reads happen only after the user presses **Paste**.

### Optical sessions

- Optical v0.1 uses CRC32 to detect accidental frame corruption. **CRC32 is not authentication or cryptographic integrity.**
- Anyone with line-of-sight to the sender screen can capture optical frames. Treat offline optical transfer like showing the file to a camera in the same physical space.
- FQR2 uses per-block SHA-256 for reconstruction integrity but does not authenticate the sender.
- Optical send/receive paths are intentionally size- and memory-bounded; larger files should use the network path when possible.

## Deployment responsibilities

Production operators should terminate signaling/relay traffic over HTTPS/WSS, keep Cloudflare and signing credentials out of the repository, use least-privilege Cloudflare tokens, sign Windows binaries, and protect the Android release keystore.

The checked-in main branch must not be described as shipping production-trusted native signatures until the real publisher credential paths have executed and post-build signature identity verification has passed. Preview build success is packaging evidence, not publisher-authenticity evidence.

Likewise, neither optional TURN support nor hosted Worker-relay evidence should be promoted beyond the evidence actually collected. Physical restrictive-network behavior remains a separate empirical gate.

Please report security issues privately to the repository owner rather than posting exploit details in a public issue.
