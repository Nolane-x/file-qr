# File QR Protocol v0.1

## Online path

The web and native shells share the same rendezvous model: a sender creates a 10-character Crockford Base32 receive code and a private sender token through the signaling service. The code is a receiver capability. Signaling state expires 600 seconds after creation. File bytes never enter the signaling service.

After sender and receiver join the Durable Object room, they exchange WebRTC SDP and ICE candidates over WebSocket. The sender opens one ordered `file-qr` RTCDataChannel and sends a JSON `meta` control message, 64 KiB binary chunks, then a JSON `complete` message. A receiver already connected at the 10-minute boundary may finish over its existing peer channel.

## Offline optical path

Optical v0.1 is deliberately a baseline, not a fountain-code claim. A file envelope contains UTF-8 metadata plus exact file bytes. The envelope is divided into versioned `FQR1` frames:

`FQR1|STREAM_ID|SEQUENCE|TOTAL|CRC32|BASE64URL_PAYLOAD`

Each QR frame has an independent CRC32. The receiver deduplicates frames, tracks missing sequence numbers, and reconstructs only after every frame is present. The sender loops the sequence so camera misses can be filled on later passes. Future optical versions may add fountain/FEC blocks and non-QR visual modulation without changing the online protocol.
