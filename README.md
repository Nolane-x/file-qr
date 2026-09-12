# File QR

**Drop. Scan. Receive.**

File QR is a deliberately small file-transfer product for **Windows and Android**. The browser path is **direct-first**: it prefers an encrypted WebRTC data channel, then can fall back to a QR-authorized end-to-end encrypted Worker relay when terminal direct recovery is exhausted before new bytes are committed. The native app also adds an experimental offline QR Stream path for situations with no usable network.

## v0.4 product contract

- **Web:** drop a file → get a QR + 10-character receive code → the other Windows/Android browser can **scan the QR with its camera**, paste a File QR link/code, or type the code. WebRTC remains the preferred direct path. A receiver that arrived through the structured QR/link may use the encrypted Worker relay fallback when the direct path is terminally unavailable; a manually typed code does not silently enter Worker relay because it does not carry the QR-only relay secret.
- **Native:** the same network path with a unified **Scan · Paste · Type** receive flow, plus **QR Stream** for offline screen-to-camera transfer. QR Stream v0.1 remains the default compatibility sender; v0.2 is an explicit experimental block-fountain mode.
- **Reusable 10-minute lease:** a QR/code remains reusable for exactly 600 seconds from session creation. Successful and failed downloads do not consume it; multiple receivers may download sequentially while only one receiver is active at a time.
- **Expiry boundary:** a new receiver is admitted only while `Date.now() < expiresAt`. A receiver admitted before expiry may finish an already-open transfer after the signaling lease expires.
- **Retry/resume:** network attempts are isolated with an `attemptId`. Protocol v2 resumes from a validated absolute byte offset; OPFS-backed partial data can survive a retry/reload in the same browser profile, while the in-memory fallback is runtime-only.
- **No cloud file storage:** the signaling service stores ephemeral rendezvous and bounded relay-control metadata only. The Worker relay forwards authenticated ciphertext live and does not persist file plaintext, relay ciphertext history, or retransmission buffers.
- **No accounts, history, cloud drive, chat, or manual production transport selector.**
- Supported preview remains **Windows + Android**.

## v0.4 session reliability

- The sender signaling lifecycle is separate from an individual transfer attempt, so one completed or failed receiver does not destroy the remaining lease.
- Signaling and SDP/ICE messages are isolated by per-receiver `attemptId`; stale candidates/descriptions from an older attempt are ignored.
- Receiver readiness survives a sender signaling reconnect, preventing a reconnect race from losing `peer-ready`.
- Browser QR scanning on Android and Windows/webcam.
- Native Windows reuses the existing WebView webcam scanner and receive parser.
- Native Android uses the Tauri barcode scanner with the back camera, QR-only format filtering and an explicit camera-permission gate.
- Native and web paste actions accept only a File QR receive code or File QR receive URL; arbitrary scanned/pasted URLs are never navigated automatically.
- Screen Wake Lock during connecting/sending/receiving/verifying when the browser supports it.
- Transfer throughput + ETA.
- 30-second bounded direct connection setup timeout instead of an indefinite connecting state.
- Cloudflare STUN + Google STUN provider redundancy.
- Early ICE candidates remain buffered until the remote description exists.
- WebRTC connection recovery allows **at most one ICE restart per receiver attempt**. Terminal direct exhaustion may enter the encrypted Worker relay only before new bytes have been committed in that attempt; otherwise the transfer fails closed and resumes in a new attempt.
- Selected-path diagnostics are informational only: **Direct · Relay · Relayed securely · Unknown**. `Relay` refers to a WebRTC relay candidate such as TURN; `Relayed securely` refers to File QR's encrypted Worker fallback. File QR does not expose a production transport selector.

## Encrypted Worker relay fallback

The Worker relay is a fallback transport, not server-side file custody. The sender creates a random 256-bit relay secret and places it only in the structured File QR QR/link. That secret is never sent to the signaling service as relay authority and is never stored by the Durable Object. A manually typed receive code therefore cannot silently activate this fallback.

For each receiver attempt, signaling separately issues attempt-scoped relay capabilities used only for admission. Browser peers derive direction-specific AES-256-GCM traffic keys from the QR-only secret with HKDF-SHA-256. The Worker sees enough framing metadata to enforce sequence, role, byte/control budgets and idle limits, but forwards encrypted frames immediately and stores no file plaintext or relay ciphertext history.

The normal product remains direct-first. A transient WebRTC disconnect stays in bounded direct recovery; Worker relay begins only after terminal direct exhaustion before newly committed bytes. `?forceRelay=1` exists only for deterministic evidence and is not a user-facing transport choice.

Hosted evidence is deliberately narrower than physical evidence. The trusted-main `Worker Relay Evidence` workflow proves the canonical production site can force the dedicated Worker relay, transfer a fresh random payload, and produce identical independent source/received SHA-256 hashes without publishing receive codes, relay secrets, capabilities, IP addresses, or file bytes. That hosted PASS does **not** prove every restrictive network works. A separate real **physical restrictive-network** transfer remains required for that claim.

## Optional TURN boundary

TURN remains an **optional** WebRTC ICE capability and is no longer the critical fallback dependency for File QR's Worker-relay path.

The browser requests optional credentials from `POST /v1/turn-credentials` using the current File QR lease code. If TURN is not configured, the endpoint returns `404 {"error":"turn-not-configured"}` and the client continues with the default STUN configuration. If TURN is configured, the signaling Worker keeps the long-lived Cloudflare TURN key/API token server-side, verifies that the File QR lease is still alive, and asks Cloudflare to mint short-lived ICE credentials. Long-lived TURN secrets are never shipped in browser source or checked into `wrangler.jsonc`.

Do not use TURN code presence as evidence that TURN is active. A real TURN-relayed WebRTC claim still requires its own production/physical evidence. Likewise, hosted Worker-relay evidence is not a universal-NAT-traversal guarantee.

## Production

Primary web app:

```text
https://fileqr.nolane-file.workers.dev
```

GitHub Pages mirror:

```text
https://nolane-x.github.io/file-qr/
```

The mirror serves the same static client and uses the same verified signaling rendezvous. Cloudflare remains the primary production origin; GitHub Pages is an independent fallback/mirror rather than a second signaling service.

Signaling health:

```text
https://file-qr-signaling.nolane-file.workers.dev/health
```

The old `file-qr-web.nolane-file.workers.dev` deployment is intentionally not deleted, so it can remain a temporary compatibility endpoint.

## Downloads

Stable release asset names:

```text
FileQR-Windows-x64-setup.exe
FileQR-Android-arm64.apk
```

The website links to GitHub `releases/latest/download/...` for those two names. The Android workflow currently produces an installable **debug-signed preview APK**; Windows is not yet production code-signed. Do not describe either native binary as production-trusted signed until signing is configured and verified.

A successful Android build/manifest gate proves packaging and permission configuration; it does **not** by itself prove physical-device camera behavior. Camera behavior remains a physical-device verification item unless that evidence is recorded separately.

## Repository map

```text
apps/web/                 Vite web client + camera receive scanner
apps/native/              Tauri 2 shell for Windows + Android
packages/core/            transport-neutral protocol primitives
services/signaling/       Cloudflare Worker + Durable Object rendezvous/relay authority
tests/                    protocol, runtime and structural release/evidence gates
docs/superpowers/         design specs + implementation plans
.github/workflows/        CI, production evidence, Cloudflare primary, GitHub Pages mirror, signaling and native builds
```

## Development

Requires Node.js 22+.

```bash
npm install
npm run verify
```

Run the web client:

```bash
VITE_SIGNALING_ORIGIN=https://your-worker.example.workers.dev npm --workspace @file-qr/web run dev -- --host 127.0.0.1 --port 5173 --strictPort
```

Run the native UI:

```bash
VITE_SIGNALING_ORIGIN=https://your-worker.example.workers.dev npm --workspace @file-qr/native run tauri -- dev
```

Tauri native builds additionally require Rust. Android builds require the Android SDK/NDK and Rust Android targets. `npm --workspace @file-qr/native run android:init` initializes the generated Android project and injects the camera manifest permission required by native QR scanning and optical receive.

## Camera + clipboard privacy

Camera access is user initiated. Web and native Windows open the WebView camera only after **Scan QR** is pressed and release it on decode, cancel, reset, transfer start, failure or page exit. Native Android invokes the Tauri barcode-scanner plugin only after **Scan QR** is pressed, requests camera permission when needed, uses the back camera and limits recognition to QR codes.

All scanned strings pass through the same File QR receive-capability parser; arbitrary scanned URLs are **never navigated automatically**. Clipboard reads are also user initiated only through the **Paste** action.

## Offline QR Stream

### v0.1 compatibility path

QR Stream v0.1 remains intentionally conservative: independent repeated `FQR1` frames with sequence number, total count, CRC32 and Base64URL payload. The receiver deduplicates frames and reconstructs only when all frames are present.

Optical v0.1 send is capped at **8 MiB** before the file is read into memory and retains its ten-minute broadcast stop. CRC32 detects accidental corruption but is **not** cryptographic authentication. The v0.1 format remains available and is the default offline sender mode.

### v0.2 experimental block-fountain path

QR Stream v0.2 (`FQR2`) is an **experimental** offline mode with an initial **64 MiB** admission cap. It keeps file processing bounded to one **64 KiB** block at a time and emits systematic plus deterministic repair symbols instead of requiring every original frame to be seen. The native receiver recognizes exact `FQR1|` and `FQR2|` prefixes and keeps the two decoders isolated.

FQR2 defaults to 768-byte source symbols. Per-frame CRC32 rejects corrupted frame payloads, while each reconstructed block must match its declared SHA-256 before it is persisted or exposed. SHA-256 here is an integrity check, **not sender authentication**.

The FQR2 receiver holds one incomplete block decoder at a time, bounds decoder equations and recent sequence identities, and drops newly observed FQR2 camera frames while an asynchronous FQR2 accept is already in flight instead of building an unbounded queue. Verified blocks are written at exact offsets; durable sidecar progress is updated only after the block data write succeeds.

Whole-file memory fallback is allowed only for files up to **8 MiB**. Larger FQR2 receives require persistent random-access storage such as OPFS and fail closed when that capability is unavailable. FQR2 does not inherit the v0.1 ten-minute broadcast stop; it continues until the user stops it or the runtime closes.

FQR2 is not a production-default or performance claim. No optical throughput, range, universal-camera compatibility, or production-readiness claim is made without separate physical Windows/Android camera evidence. The 64 MiB cap should not be raised and FQR2 should not become the default until that empirical gate exists.

## Deployment

### Signaling

`GET /health` must report:

```json
{"ok":true,"service":"file-qr-signaling","ttlMs":600000}
```

The deployment smoke test also allocates a real ephemeral session through `POST /v1/sessions` so the Durable Object binding is exercised.

### Web

Pushes to `main` run two isolated static-site deployments:

- `.github/workflows/pages.yml` builds with the default Vite base `/`, deploys `apps/web/dist` to the primary Cloudflare Workers Static Assets project, then smoke-tests `https://fileqr.nolane-file.workers.dev/`.
- `.github/workflows/github-pages.yml` builds with `VITE_BASE=/file-qr/`, verifies that generated asset URLs use the repository base, uploads the Pages artifact, and deploys it to the `github-pages` environment. Pull requests execute the mirror build gate but never deploy.

The GitHub Pages repository setting must use **GitHub Actions** as the publishing source. The mirror workflow fails closed if Pages is not enabled/configured; it never changes the Cloudflare deployment or signaling origin.

After the integrated Worker-relay code is on trusted `main` and production web/signaling deployment succeeds, `.github/workflows/worker-relay-evidence.yml` may be dispatched from `main`. It is secretless and publishes `worker-relay-evidence.json` only after exact payload integrity and dedicated relay-path assertions pass.

### Native release

On `main`, the native workflow builds Windows NSIS + Android APK, verifies Android camera manifest requirements, then creates `v<package.json version>` only if that release does not already exist.

## Security boundary

The receive code is a 50-bit Crockford Base32 capability. The sender separately receives a private sender token. Direct WebRTC encrypts the peer channel. The Worker relay has a separate QR-only 256-bit secret for end-to-end payload encryption and separate attempt-scoped admission capabilities; those authorities are intentionally not interchangeable. The signaling/relay service is ephemeral and does not persist file payloads or relay ciphertext history.

See [`SECURITY.md`](SECURITY.md) and [`docs/architecture/PROTOCOL.md`](docs/architecture/PROTOCOL.md).

## License

MIT. See [`LICENSE`](LICENSE).
