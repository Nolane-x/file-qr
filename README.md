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
apps/web/                 Vite web client for Cloudflare Workers Static Assets
apps/native/              Tauri 2 shell for Windows + Android
packages/core/            transport-neutral protocol primitives
services/signaling/       Cloudflare Worker + Durable Object rendezvous
tests/                    protocol + structural release gates
docs/architecture/        wire-format and security notes
docs/superpowers/         approved design + implementation plan
.github/workflows/        CI, web deploy, signaling and native builds
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

Tauri native builds additionally require Rust. Android builds require the Android SDK/NDK and Rust Android targets. Use `npm --workspace @file-qr/native run android:init` to initialize the generated Android project; this command also injects the `CAMERA` manifest permission required by QR Stream receive.

## Deploy

### 1. Signaling

The verified production rendezvous is:

```text
https://file-qr-signaling.nolane-file.workers.dev
```

`GET /health` must return `{"ok":true,"service":"file-qr-signaling","ttlMs":600000}`. The deployment smoke test also creates a real ephemeral session through `POST /v1/sessions`, so a green **Deploy Signaling** run verifies the Durable Object binding rather than only checking that the Worker uploaded.

For credentials, the workflow accepts repository secret `CLOUDFLARE_API_TOKEN` or the compatibility alias `CLOUDFLARE`, plus `CLOUDFLARE_ACCOUNT_ID` as either a repository secret or repository variable. Run **Deploy Signaling** manually when the Worker changes. The Durable Object stores only ephemeral rendezvous state and expires sessions after 600 seconds.

### 2. Web

The production static website is deployed as a Cloudflare Workers Static Assets project named `file-qr-web`:

```text
https://file-qr-web.nolane-file.workers.dev
```

Repository variable `SIGNALING_ORIGIN` may override the rendezvous origin. If it is not set, the web build falls back to the verified signaling Worker above. Pushes to `main` run `.github/workflows/pages.yml`, which builds `apps/web/dist`, deploys it with `apps/web/wrangler.jsonc`, and smoke-tests the live `workers.dev` URL. The workflow uses the same Cloudflare credential aliases as signaling and does not require GitHub Pages repository configuration.

### 3. Native downloads

`.github/workflows/native.yml` builds an NSIS installer on Windows and an installable Android preview APK. The Android job initializes the Tauri project through the repository wrapper, verifies `android.permission.CAMERA` plus an optional camera feature declaration in the generated manifest, and only then builds the APK.

On a push to `main`, the release job reads the root `package.json` version and creates `v<version>` only when that release does not already exist. It reuses the Windows and Android artifacts from the same verified workflow run and publishes the stable filenames used by the website download buttons:

```text
FileQR-Windows-x64-setup.exe
FileQR-Android-arm64.apk
```

The Android v0.1 artifact is intentionally a **debug-signed preview APK**. Replace it with a protected release keystore before calling the Android build production-signed. Windows code signing should likewise be added before a production trust claim.

## Offline QR Stream v0.1

The first optical format is intentionally conservative and falsifiable. It loops independent QR frames containing sequence number, total count, CRC32, and Base64URL payload. The receiver deduplicates frames and reconstructs only when all frames are present.

QR Stream v0.1 caps optical send at **8 MB** before reading the file into memory. Larger files are directed to Network mode. Android optical receive declares camera access explicitly; if camera access is denied or unavailable, users can remain in Network mode. This is a baseline for measurement—not a claim that QR beats Wi-Fi. The optical protocol is versioned so later releases can add fountain/FEC blocks and denser visual modulation without breaking the online protocol. See [`docs/architecture/PROTOCOL.md`](docs/architecture/PROTOCOL.md).

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
