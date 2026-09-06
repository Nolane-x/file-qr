# File QR

**Drop. Scan. Receive.**

File QR is a deliberately small file-transfer product for **Windows and Android**. The web path sends bytes peer-to-peer with WebRTC; the native app adds an experimental offline QR-streaming path for situations with no usable network.

## Product contract

- **Web:** drop a file → get a QR + 10-character receive code → receiver scans on Android or types the code on Windows → WebRTC data channel transfers the file.
- **Native:** the same network path plus **QR Stream** for offline screen-to-camera transfer.
- **10-minute rendezvous:** new receivers can join for 600 seconds. A peer transfer that already started may finish after the rendezvous expires.
- **No file server:** signaling stores session metadata only. File bytes are not uploaded to the signaling service.
- **No accounts, history, cloud drive, iOS, macOS, or Linux** in v0.1.

## Repository map

```text
apps/web/                 Vite web client for GitHub Pages
apps/native/              Tauri 2 shell for Windows + Android
packages/core/            transport-neutral protocol primitives
services/signaling/       Cloudflare Worker + Durable Object rendezvous
tests/                    protocol + structural release gates
docs/architecture/        wire-format and security notes
docs/superpowers/         approved design + implementation plan
.github/workflows/        CI, Pages, signaling and native builds
```

## Development

Requires Node.js 22+.

```bash
npm install
npm test
npm run build:web
npm run build:native-ui
npm run check:signaling
```

Run the web client:

```bash
VITE_SIGNALING_ORIGIN=https://your-worker.example.workers.dev npm --workspace @file-qr/web run dev
```

Run the native UI during development:

```bash
VITE_SIGNALING_ORIGIN=https://your-worker.example.workers.dev npm --workspace @file-qr/native run tauri -- dev
```

Tauri native builds additionally require Rust. Android builds require the Android SDK/NDK and Rust Android targets.

## Deploy

### 1. Signaling

Create repository secrets `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`, then run the **Deploy Signaling** workflow. The Durable Object stores only ephemeral rendezvous state and expires sessions after 600 seconds.

### 2. Web

Set repository variable `SIGNALING_ORIGIN` to the Worker origin. Enable GitHub Pages with **GitHub Actions** as its source. Push to `main`; `.github/workflows/pages.yml` builds and deploys `apps/web/dist`.

### 3. Native downloads

`.github/workflows/native.yml` builds an NSIS installer on Windows and an installable Android preview APK. Tags matching `v*` publish release assets with stable names used by the website download buttons:

```text
FileQR-Windows-x64-setup.exe
FileQR-Android-arm64.apk
```

The Android v0.1 artifact is intentionally a **debug-signed preview APK**. Replace it with a protected release keystore before calling the Android build production-signed. Windows code signing should likewise be added before a production trust claim.

## Offline QR Stream v0.1

The first optical format is intentionally conservative and falsifiable. It loops independent QR frames containing sequence number, total count, CRC32, and Base64URL payload. The receiver deduplicates frames and reconstructs only when all frames are present.

This is a baseline for measurement—not a claim that QR beats Wi-Fi. Large files should use the network path. The optical protocol is versioned so later releases can add fountain/FEC blocks and denser visual modulation without breaking the online protocol. See [`docs/architecture/PROTOCOL.md`](docs/architecture/PROTOCOL.md).

## Nolane UI Intelligence

File QR uses [Nolane UI Intelligence](https://github.com/Nolane-x/Nolane-UI-Intelligence) as a design/verification sidecar instead of copying its skill graph into this repository:

```bash
npm run nui:setup
python .nui/scripts/nui-agent-export --agent generic-cli --root .nui
```

The UI is modeled as explicit runtime states (`idle`, `preparing`, `ready`, `connecting`, `sending`, `receiving`, `verifying`, `done`, `expired`, `cancelled`, `failed`, `unsupported`) so design review can inspect real behavior rather than a single attractive screenshot.

## Security boundary

The short receive code is a 50-bit Crockford Base32 capability used to locate a session. The sender additionally receives a random private token. WebRTC encrypts the peer channel. Signaling is ephemeral and no file payload is persisted by it.

For the v0.1 threat model and non-claims, see [`SECURITY.md`](SECURITY.md).

## License

MIT. See [`LICENSE`](LICENSE).
