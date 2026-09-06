# Security

## v0.2 threat model

File QR is designed to avoid server-side file custody. The signaling service handles ephemeral rendezvous metadata only; file payloads travel over an encrypted WebRTC RTCDataChannel between peers or optically between a screen and camera.

### Online sessions

- Receive codes contain 50 bits of random Crockford Base32 entropy and expire after exactly 600 seconds.
- A separate random sender token is required to occupy the sender role.
- A room admits at most one sender and one receiver, then marks the rendezvous consumed when the direct transfer opens.
- Durable Object alarms remove signaling state after expiry.
- File data is not routed through or persisted by the signaling Worker.
- v0.2 uses Cloudflare STUN and Google STUN for ICE discovery. STUN is not file relay/storage.
- TURN relay is **not enabled** in v0.2. Do not claim universal NAT traversal.
- Future TURN activation must keep the long-lived TURN key server-side and return only short-lived ICE credentials to clients.

### Web camera scanner

- Browser camera permission is requested only after a user presses **Scan QR**.
- Camera streams are released after decode, cancel, reset, transfer start, failure, or page exit.
- Scanned QR strings are parsed for a File QR receive capability only. The application never navigates automatically to arbitrary scanned URLs.
- Clipboard reads happen only after the user presses **Paste**.

### Optical sessions

- Optical v0.1 uses CRC32 to detect accidental frame corruption. **CRC32 is not authentication or cryptographic integrity.**
- Anyone with line-of-sight to the sender screen can capture optical frames. Treat offline optical transfer like showing the file to a camera in the same physical space.
- v0.2 does not claim fountain coding, forward secrecy for the optical payload, or resistance to an active camera/display adversary.

## Deployment responsibilities

Production operators should terminate signaling over HTTPS/WSS, keep Cloudflare credentials out of the repository, enable appropriate abuse/rate controls, sign Windows binaries, and use a protected Android release keystore. The checked-in Android workflow currently emits a debug-signed preview APK so CI can produce an installable artifact without embedding a private signing key.

Please report security issues privately to the repository owner rather than posting exploit details in a public issue.
