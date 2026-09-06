# Security

## v0.1 threat model

File QR is designed to avoid server-side file custody. The signaling service handles rendezvous metadata only; file payloads travel over WebRTC between peers or optically between a screen and camera.

### Online sessions

- Receive codes contain 50 bits of random Crockford Base32 entropy and expire after 600 seconds.
- A separate random sender token is required to occupy the sender role.
- A room admits at most one sender and one receiver, then marks the rendezvous consumed when the direct transfer opens.
- Durable Object alarms remove session state after expiry.
- File data is carried by an ordered WebRTC RTCDataChannel and is not routed through the signaling Worker.

### Optical sessions

- Optical v0.1 uses CRC32 to detect accidental frame corruption. **CRC32 is not authentication or cryptographic integrity.**
- Anyone with line-of-sight to the sender screen can capture optical frames. Treat offline optical transfer like showing the file to a camera in the same physical space.
- v0.1 does not claim fountain coding, forward secrecy for the optical payload, or resistance to an active camera/display adversary.

## Deployment responsibilities

Production operators should terminate signaling over HTTPS/WSS, keep Cloudflare credentials out of the repository, enable appropriate abuse/rate controls, sign Windows binaries, and use a protected Android release keystore. The checked-in Android workflow emits a debug-signed preview APK so that CI can produce an installable artifact without embedding a private signing key.

Please report security issues privately to the repository owner rather than posting exploit details in a public issue.
