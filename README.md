# File QR

**Drop. Scan. Receive.**

File QR is a deliberately small file-transfer product for **Windows and Android**. The browser path sends file bytes through an encrypted WebRTC data channel; the native app adds an experimental offline QR Stream path for situations with no usable network.

## v0.4 product contract

- **Web:** drop a file → get a QR + 10-character receive code → the other Windows/Android browser can **scan the QR with its camera**, paste a File QR link/code, or type the code → WebRTC transfers the file.
- **Native:** the same network path with a unified **Scan · Paste · Type** receive flow, plus **QR Stream** for offline screen-to-camera transfer. QR Stream v0.1 remains the default compatibility sender; v0.2 is an explicit experimental block-fountain mode.
- **Reusable 10-minute lease:** a QR/code remains reusable for exactly 600 seconds from session creation. Successful and failed downloads do not consume it; multiple receivers may download sequentially while only one receiver is active at a time.
- **Expiry boundary:** a new receiver is admitted only while `Date.now() < expiresAt`. A receiver admitted before expiry may finish an already-open WebRTC transfer after the signaling lease expires.
- **Retry/resume:** network attempts are isolated with an `attemptId`. Protocol v2 resumes from a validated absolute byte offset; OPFS-backed partial data can survive a retry/reload in the same browser profile, while the in-memory fallback is runtime-only.
- **No cloud storage:** the signaling service stores ephemeral rendezvous metadata only and **does not store file bytes**.
- **No accounts, history, cloud drive, chat, or manual transport selector.**
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
- 30-second bounded connection setup timeout instead of an indefinite connecting state.
- Cloudflare STUN + Google STUN provider redundancy.
- Early ICE candidates remain buffered until the remote description exists.
- WebRTC connection recovery allows **at most one ICE restart per receiver attempt**. A second hard failure ends that attempt without consuming the remaining QR/code lease.
- Selected-path diagnostics are informational only: **Direct · Relay · Unknown**. File QR does not expose a transport selector.

## Optional TURN boundary

v0.4 includes the **TURN-ready security boundary**, not a claim that relay is active on every production deployment.

The browser requests optional credentials from `POST /v1/turn-credentials` using the current File QR lease code. If TURN is not configured, the endpoint returns `404 {"error":"turn-not-configured"}` and the client continues with the default STUN configuration. If TURN is configured, the signaling Worker keeps the long-lived Cloudflare TURN key/API token server-side, verifies that the File QR lease is still alive, and asks Cloudflare to mint short-lived ICE credentials. Long-lived TURN secrets are never shipped in browser source or checked into `wrangler.jsonc`.

Do **not** describe TURN relay as production-ready until real credentials are configured and a relay transfer is verified on a physical restrictive-network path. Likewise, File QR does not claim to work on every network.

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
services/signaling/       Cloudflare Worker + Durable Object rendezvous
tests/                    protocol, runtime and structural release gates
docs/superpowers/         design specs + implementation plans
.github/workflows/        CI, Cloudflare primary, GitHub Pages mirror, signaling and native release builds
```

## Development

Requires Node.js 22+.

```bash
npm install
npm run verify
```

Run the web client:

```bash
VITE_SIGNALING_ORIGIN=https://your-worker.example.workers.dev npm --workspace @file-qr/web run dev
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

### Native release

On `main`, the native workflow builds Windows NSIS + Android APK, verifies Android camera manifest requirements, then creates `v<package.json version>` only if that release does not already exist.

## Security boundary

The receive code is a 50-bit Crockford Base32 capability. The sender separately receives a private sender token. WebRTC encrypts the peer channel. The signaling service is ephemeral and does not persist file payloads.

See [`SECURITY.md`](SECURITY.md) and [`docs/architecture/PROTOCOL.md`](docs/architecture/PROTOCOL.md).

## License

MIT. See [`LICENSE`](LICENSE).
