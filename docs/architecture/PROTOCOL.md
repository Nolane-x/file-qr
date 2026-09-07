# File QR Protocol v0.4

## Online lease and signaling

The web and native shells share the same rendezvous model. A sender creates a session through the signaling service and receives a 10-character Crockford Base32 receive code, a private sender token, and an absolute expiry time. The receive code is the receiver capability; the sender token is separately required to occupy the sender role. Signaling state expires exactly 600 seconds after session creation. File bytes never enter the signaling service.

The lease remains reusable while `Date.now() < expiresAt`. A room has one sender and at most one active receiver at a time, but completed or failed receiver attempts do not consume the remaining lease, so receivers may download sequentially during the same 10-minute window. A receiver already admitted before expiry may finish an already-open peer transfer after the signaling lease closes.

Each receiver admission receives a monotonic `attemptId`. `peer-ready`, WebRTC descriptions, and ICE candidates are associated with that attempt. The clients ignore stale signaling whose `attemptId` does not match the current peer attempt. Receiver readiness is persisted by signaling so a sender reconnect cannot lose an already-admitted receiver.

## ICE, STUN, and optional TURN

Each WebRTC attempt starts with the default Cloudflare and Google STUN servers. The client also requests optional TURN configuration from `POST /v1/turn-credentials` using the current lease code.

If TURN is unconfigured or unavailable, the normal product path continues with the default STUN configuration. When TURN is configured, the signaling service keeps the long-lived TURN key server-side, validates that the File QR lease is still alive, and returns only validated short-lived TURN ICE credentials. TURN capability does not change the file protocol and is not a universal-NAT-traversal guarantee.

## WebRTC transfer protocol v2

Every receiver attempt owns one WebRTC peer connection and one ordered `file-qr` RTCDataChannel. File QR control messages are JSON objects with explicit protocol version `v: 2`; legacy or future control versions are rejected instead of guessed compatible. Binary RTCDataChannel messages contain file bytes.

The protocol v2 transfer sequence is:

1. **`file-offer`** — after the ordered data channel opens, the sender announces `fileId`, file name, byte size, MIME type, and the default 64 KiB chunk size.
2. **`resume-request`** — the receiver opens its receive sink for the stable `fileId` and lease code, determines its existing partial length, validates that absolute byte offset is an integer in the inclusive range `0..file.size`, and sends that offset to the sender.
3. **Binary file chunks** — the sender reads and transmits bytes beginning exactly at the validated absolute byte offset. Chunks are ordered and backpressure-aware; progress is measured against the full file size rather than the remaining suffix only.
4. **`transfer-complete`** — after all bytes from the requested offset through the end of the file have been queued, the sender sends the stable `fileId` and full file size.
5. **`complete-ack`** — the receiver accepts completion only when identity, declared size, and locally received byte count all match. It finalizes the sink, queues `complete-ack`, and only then exposes the completed download. The sender treats the attempt as successful only after the matching acknowledgement arrives.

A failed or disconnected attempt may leave a resumable partial. OPFS-backed browser partial data can survive a retry/reload in the same browser profile; the in-memory fallback survives only within the current runtime. A later receiver attempt for the same offered file can request the validated absolute byte offset already present in its sink.

## Attempt isolation and ICE recovery

SDP and ICE messages are scoped to the current `attemptId`. Remote ICE candidates received before a remote description are buffered and flushed after that description is installed. Replayed readiness or stale signaling cannot replace an active or newer attempt.

The sender owns ICE restart to avoid offer glare. A disconnected state receives a bounded grace period; a hard failure permits at most one ICE restart for that receiver attempt. The receiver waits for the sender-owned recovery. A second hard failure ends only that attempt; it does not consume a still-open 600-second lease.

## Offline optical path

Optical v0.1 remains deliberately separate from online protocol v2 and is a conservative baseline, not a fountain-code claim. A file envelope contains UTF-8 metadata plus exact file bytes. The envelope is divided into versioned `FQR1` frames:

`FQR1|STREAM_ID|SEQUENCE|TOTAL|CRC32|BASE64URL_PAYLOAD`

Each QR frame has an independent CRC32. The receiver deduplicates frames, tracks missing sequence numbers, and reconstructs only after every frame is present. The sender loops the sequence so camera misses can be filled on later passes. CRC32 detects accidental corruption; it is not cryptographic authentication.

Future optical versions may add fountain/FEC blocks or non-QR visual modulation without changing the online protocol v2 contract.
