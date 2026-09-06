# File QR

**Drop. Scan. Receive.**

File QR is a deliberately small file-transfer product for **Windows and Android**. The browser path sends file bytes through an encrypted WebRTC data channel; the native app adds an experimental offline QR Stream path for situations with no usable network.

## v0.2 product contract

- **Web:** drop a file → get a QR + 10-character receive code → the other Windows/Android browser can **scan the QR with its camera**, paste a File QR link/code, or type the code → WebRTC transfers the file.
- **Native:** the same network path plus **QR Stream** for offline screen-to-camera transfer.
- **10-minute rendezvous:** new receivers can join for exactly 600 seconds. A data channel that already opened may finish after signaling expiry.
- **No cloud file storage:** the signaling Worker stores ephemeral rendezvous metadata only. File payloads do not enter the signaling service.
- **No accounts, history, cloud drive, chat, or manual transport selector.**
- Supported preview remains **Windows + Android**.

## v0.2 reliability + convenience

- Browser QR scanning on Android and Windows/webcam.
- Paste receive code or File QR receive URL.
- Screen Wake Lock during connecting/sending/receiving/verifying when the browser supports it.
- Transfer throughput + ETA.
- 30-second bounded direct-connection setup timeout instead of an indefinite connecting state.
- Cloudflare STUN + Google STUN provider redundancy.
- Early ICE candidates remain buffered until the remote description exists.
- WebRTC accepts injected ICE server configuration so short-lived TURN credentials can be added later without changing call sites.

**TURN relay is not enabled in v0.2.** Some restrictive NAT/firewall combinations may still fail. A future TURN milestone must mint short-lived relay credentials server-side; a long-lived TURN secret must never be shipped in browser code.

## Production

Web app:

```text
https://fileqr.nolane-file.workers.dev
```

Signaling health:

```text
https://file-qr-signaling.nolane-file.workers.dev/health
```

The old `file-qr-web.nolane-file.workers.dev` deployment is intentionally not deleted by v0.2, so it can remain a temporary compatibility endpoint.

## Downloads

Stable release asset names:

```text
FileQR-Windows-x64-setup.exe
FileQR-Android-arm64.apk
```

The website links to GitHub `releases/latest/download/...` for those two names. The Android workflow currently produces an installable **debug-signed preview APK**; Windows is not yet production code-signed. Do not describe either native binary as production-trusted signed until signing is configured and verified.

## Repository map

```text
apps/web/                 Vite web client + camera receive scanner
apps/native/              Tauri 2 shell for Windows + Android
packages/core/            transport-neutral protocol primitives
services/signaling/       Cloudflare Worker + Durable Object rendezvous
tests/                    protocol, runtime and structural release gates
docs/superpowers/         design specs + implementation plans
.github/workflows/        CI, web deployment, signaling and native release builds
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

Tauri native builds additionally require Rust. Android builds require the Android SDK/NDK and Rust Android targets. `npm --workspace @file-qr/native run android:init` initializes the generated Android project and injects the camera manifest permission required by optical receive.

## Web camera privacy

Camera access is requested only after the user presses **Scan QR**. The stream is released on decode, cancel, reset, transfer start, failure, or page exit. Scanned QR strings are parsed only for a File QR receive capability; arbitrary scanned URLs are **never navigated automatically**.

Clipboard reads are also user-initiated only through the **Paste** action.

## Offline QR Stream v0.1

The optical format remains intentionally conservative in v0.2: independent repeated `FQR1` frames with sequence number, total count, CRC32 and Base64URL payload. The receiver deduplicates frames and reconstructs only when all frames are present.

Optical send is capped at **8 MB** before the file is read into memory. Larger files should use Network mode. CRC32 detects accidental corruption but is **not** cryptographic authentication.

## Deployment

### Signaling

`GET /health` must report:

```json
{"ok":true,"service":"file-qr-signaling","ttlMs":600000}
```

The deployment smoke test also allocates a real ephemeral session through `POST /v1/sessions` so the Durable Object binding is exercised.

### Web

Pushes to `main` build the Vite app, deploy `apps/web/dist` as Cloudflare Workers Static Assets using `apps/web/wrangler.jsonc`, then smoke-test `https://fileqr.nolane-file.workers.dev/`.

### Native release

On `main`, the native workflow builds Windows NSIS + Android APK, verifies Android camera manifest requirements, then creates `v<package.json version>` only if that release does not already exist.

## Security boundary

The receive code is a 50-bit Crockford Base32 capability. The sender separately receives a private sender token. WebRTC encrypts the peer channel. Signaling is ephemeral and does not persist file payloads.

See [`SECURITY.md`](SECURITY.md) and [`docs/architecture/PROTOCOL.md`](docs/architecture/PROTOCOL.md).

## License

MIT. See [`LICENSE`](LICENSE).
