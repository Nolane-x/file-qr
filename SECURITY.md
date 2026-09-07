# Security

## v0.4 threat model

File QR is designed to avoid server-side file custody. The signaling service handles ephemeral rendezvous metadata only; file payloads travel over an encrypted WebRTC RTCDataChannel between peers or optically between a screen and camera.

### Online sessions

- Receive codes contain 50 bits of random Crockford Base32 entropy and expire exactly 600 seconds after session creation. The receive code is a bearer capability, not an authenticated user identity.
- A separate random sender token is required to occupy the sender role. The receive code alone is not sufficient to become the sender.
- The 10-minute lease is reusable while `Date.now() < expiresAt`. A completed or failed receiver attempt does not consume the remaining lease.
- A room admits one sender and at most one active receiver attempt at a time. Multiple receivers may download sequentially during the same live lease.
- Every receiver admission receives a monotonic `attemptId`. SDP, ICE candidates, receiver readiness, and transfer-attempt state are isolated by that identity so stale signaling from an older attempt is ignored rather than applied to a newer peer.
- A receiver admitted before lease expiry may finish an already-open WebRTC transfer after signaling expires. No new receiver is admitted at or after the expiry instant.
- Sender signaling may reconnect while the lease is open. Receiver readiness is persisted so a reconnect cannot silently lose an already-admitted receiver.
- WebRTC ICE recovery permits at most one sender-owned ICE restart per receiver attempt; the passive peer waits rather than creating offer glare. A second hard failure ends that attempt without consuming the remaining lease.
- Durable Object alarms remove signaling state after expiry. File bytes are not routed through or persisted by the signaling Worker.
- Cloudflare STUN and Google STUN provide discovery redundancy. STUN is not file relay or file storage.

### Optional TURN boundary

- The browser may request short-lived TURN credentials from `POST /v1/turn-credentials` using the current live File QR lease code.
- When TURN is not configured, the endpoint returns `404 {"error":"turn-not-configured"}` and the normal client falls back to the default STUN configuration.
- Long-lived TURN key material remains server-side. When configured, the signaling Worker validates that the File QR lease is still alive before asking the TURN provider for short-lived ICE credentials.
- Repository automation separates Cloudflare Calls TURN-key authority from Worker secret-write authority and keeps production mutation on trusted `main`; generated key material is masked and rollback removes newly-written TURN secrets/key material if activation fails.
- TURN support in the codebase is not by itself a production-readiness claim. Do not describe relay as production-ready until production credentials are configured and an actual relay-only transfer has been verified. File QR does not claim universal NAT traversal or success on every network.

### Web camera scanner and clipboard

- Browser camera permission is requested only after a user presses **Scan QR**.
- Camera streams are released after decode, cancel, reset, transfer start, failure, or page exit.
- Native Android requests camera permission only for a user-initiated scan, uses the back camera, and limits recognition to QR codes.
- Scanned QR strings are parsed for a File QR receive capability only. The application never navigates automatically to arbitrary scanned URLs.
- Clipboard reads happen only after the user presses **Paste**.

### Optical sessions

- Optical v0.1 uses CRC32 to detect accidental frame corruption. **CRC32 is not authentication or cryptographic integrity.**
- Anyone with line-of-sight to the sender screen can capture optical frames. Treat offline optical transfer like showing the file to a camera in the same physical space.
- v0.4 does not claim fountain coding, forward secrecy for the optical payload, or resistance to an active camera/display adversary.
- Optical send is intentionally size-bounded before the file is read into memory; larger files should use the network path.

## Deployment responsibilities

Production operators should terminate signaling over HTTPS/WSS, keep Cloudflare and signing credentials out of the repository, use least-privilege Cloudflare tokens, enable appropriate abuse/rate controls, sign Windows binaries, and protect the Android release keystore.

The checked-in main branch must not be described as shipping production-trusted native signatures until the real publisher credential paths have executed and post-build signature identity verification has passed. Preview build success is packaging evidence, not publisher-authenticity evidence.

Likewise, TURN must remain fail-closed in production claims until trusted bootstrap succeeds and relay-only evidence is recorded. Missing or insufficient TURN credentials are an external deployment blocker, not a reason to weaken the verifier.

Please report security issues privately to the repository owner rather than posting exploit details in a public issue.
