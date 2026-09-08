# Pre-merge Native Publisher Proof Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a trusted, manual, main-only GitHub Actions proof path that signs exact candidate Windows and Android artifacts with real publisher credentials without ever exposing those credentials to candidate source code.

**Architecture:** A trusted workflow already present on `main` accepts an exact `candidate_sha`. Secretless build jobs checkout and build that candidate, then upload only opaque unsigned candidate artifacts. Separate secret-bearing signer jobs do not checkout any repository source; they download only those artifacts, sign and verify them with inline trusted workflow logic, destroy signing material, and upload sanitized proof JSON. A final secretless evidence job aggregates platform proof into one fail-closed evidence artifact bound to the exact candidate SHA and artifact digests.

**Tech Stack:** GitHub Actions, Tauri v2, Node.js 24 for candidate builds only, Rust stable, Windows PowerShell/AuthentiCode/signtool, Android SDK 36 build-tools (`zipalign`, `apksigner`, `keytool`), shell/Python 3 for sanitized evidence aggregation, Node's built-in test runner for structural tests.

**Spec:** `docs/superpowers/specs/2026-09-08-premerge-native-publisher-proof-design.md`

## Global Constraints

- The proof workflow is `workflow_dispatch` only.
- The proof workflow must refuse any dispatch whose workflow ref is not `refs/heads/main`.
- `candidate_sha` must be exactly 40 hexadecimal characters and the checked-out candidate HEAD must equal it byte-for-byte.
- Candidate build jobs receive no publisher secrets.
- Secret-bearing signer jobs must not checkout candidate source, install candidate dependencies, execute candidate scripts, run Tauri/Gradle from candidate source, or execute the candidate application binary.
- The only candidate data entering signer jobs is an opaque artifact plus non-secret metadata.
- Windows publisher secrets are `WINDOWS_CERTIFICATE` and `WINDOWS_CERTIFICATE_PASSWORD`.
- Android publisher secrets are `ANDROID_KEY_BASE64`, `ANDROID_KEY_PASSWORD`, and `ANDROID_KEY_ALIAS`.
- Windows proof requires a private-key certificate that is unexpired, has Code Signing EKU `1.3.6.1.5.5.7.3.3`, produces Authenticode `Valid`, and matches the selected certificate thumbprint.
- Android proof must align the unsigned APK before signing, must verify with `apksigner verify --verbose --print-certs`, and must bind signer SHA-256 to the configured keystore certificate SHA-256.
- Signing material must be cleaned with `if: always()` / `finally` semantics.
- No signed candidate binary is persisted as the final evidence artifact; only sanitized proof JSON is retained.
- Final evidence must bind the exact candidate SHA, workflow run ID/attempt, unsigned input digests, signed output digests, Windows signer thumbprint, Android certificate SHA-256, platform status, and observation time.
- No password, base64 keystore/PFX content, TURN material, private key, device identifier, or certificate private material may be serialized.
- Any platform failure is fail-closed. A PASS claim requires both signer jobs and the final evidence assertion to succeed.
- Post-merge `main` Native Builds remains the authoritative integrated production-signing proof; this workflow is only the pre-merge credential/artifact proof seam.

---

### Task 1: Lock the trusted-workflow security contract with RED tests

**Files:**
- Create: `tests/structure/premerge-native-publisher-proof.test.mjs`
- Create later in Task 2: `.github/workflows/premerge-native-publisher-proof.yml`

**Interfaces:**
- Consumes: the design spec and repository workflow conventions.
- Produces: structural contracts that every later workflow task must satisfy.

- [ ] **Step 1: Write the failing structural test before the workflow exists**

Create `tests/structure/premerge-native-publisher-proof.test.mjs` with Node built-in tests that read `../../.github/workflows/premerge-native-publisher-proof.yml` only if it exists, otherwise fail with a clear assertion. The test suite must assert all of the following exact contracts:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const workflowUrl = new URL('../../.github/workflows/premerge-native-publisher-proof.yml', import.meta.url);
assert.ok(fs.existsSync(workflowUrl), 'trusted pre-merge publisher proof workflow must exist');
const workflow = fs.readFileSync(workflowUrl, 'utf8');

function section(start, end) {
  const from = workflow.indexOf(start);
  assert.ok(from >= 0, `missing section: ${start}`);
  const to = end ? workflow.indexOf(end, from + start.length) : workflow.length;
  assert.ok(to > from, `missing section boundary after: ${start}`);
  return workflow.slice(from, to);
}

test('publisher proof is manual and main-only', () => {
  assert.match(workflow, /workflow_dispatch:/);
  assert.match(workflow, /candidate_sha:/);
  assert.doesNotMatch(workflow, /\n\s{2}(pull_request|pull_request_target|push|workflow_run):/);
  assert.match(workflow, /github\.ref\s*==\s*['"]refs\/heads\/main['"]/);
  assert.match(workflow, /\^\[0-9a-fA-F\]\{40\}\$/);
});

test('candidate build jobs are secretless and bind exact checkout SHA', () => {
  const builds = section('  build_windows:', '  sign_windows:') + section('  build_android:', '  sign_android:');
  assert.doesNotMatch(builds, /secrets\./);
  assert.match(builds, /actions\/checkout@v6/);
  assert.match(builds, /inputs\.candidate_sha/);
  assert.match(builds, /git rev-parse HEAD/);
  assert.match(builds, /candidate SHA mismatch/i);
});

test('secret-bearing signer jobs never execute candidate repository code', () => {
  const windows = section('  sign_windows:', '  build_android:');
  const android = section('  sign_android:', '  evidence:');
  for (const signer of [windows, android]) {
    assert.doesNotMatch(signer, /actions\/checkout/);
    assert.doesNotMatch(signer, /npm (?:install|ci|run)/);
    assert.doesNotMatch(signer, /\bnode\b/);
    assert.doesNotMatch(signer, /\btauri\b/i);
    assert.doesNotMatch(signer, /\bgradle(?:w)?\b/i);
  }
  assert.match(windows, /WINDOWS_CERTIFICATE/);
  assert.match(windows, /WINDOWS_CERTIFICATE_PASSWORD/);
  assert.match(android, /ANDROID_KEY_BASE64/);
  assert.match(android, /ANDROID_KEY_PASSWORD/);
  assert.match(android, /ANDROID_KEY_ALIAS/);
});

test('Windows signer proves publisher identity and cleanup', () => {
  const windows = section('  sign_windows:', '  build_android:');
  assert.match(windows, /1\.3\.6\.1\.5\.5\.7\.3\.3/);
  assert.match(windows, /signtool(?:\.exe)?/i);
  assert.match(windows, /Get-AuthenticodeSignature/);
  assert.match(windows, /Status[^\n]*Valid/);
  assert.match(windows, /Thumbprint/);
  assert.match(windows, /if:\s*always\(\)/);
  assert.match(windows, /Remove-Item/);
});

test('Android signer aligns, signs, verifies identity and cleans up', () => {
  const android = section('  sign_android:', '  evidence:');
  assert.match(android, /zipalign/);
  assert.match(android, /apksigner\s+sign/);
  assert.match(android, /apksigner\s+verify/);
  assert.match(android, /keytool\s+-exportcert/);
  assert.match(android, /SHA-256 digest/);
  assert.match(android, /if:\s*always\(\)/);
  assert.match(android, /rm\s+-f/);
});

test('sanitized evidence binds exact candidate and artifact identities', () => {
  const evidence = section('  evidence:');
  assert.match(evidence, /candidateSha/);
  assert.match(evidence, /workflowRunId/);
  assert.match(evidence, /workflowRunAttempt/);
  assert.match(evidence, /inputSha256/);
  assert.match(evidence, /signedSha256/);
  assert.match(evidence, /signerThumbprint/);
  assert.match(evidence, /certificateSha256/);
  assert.match(evidence, /observedAt/);
  assert.match(evidence, /actions\/upload-artifact@v4/);
  assert.doesNotMatch(evidence, /WINDOWS_CERTIFICATE_PASSWORD|ANDROID_KEY_PASSWORD|ANDROID_KEY_BASE64/);
});
```

- [ ] **Step 2: Run the new test and prove RED**

Run:

```bash
node --test tests/structure/premerge-native-publisher-proof.test.mjs
```

Expected: FAIL because `.github/workflows/premerge-native-publisher-proof.yml` does not exist.

- [ ] **Step 3: Commit only the RED test**

```bash
git add tests/structure/premerge-native-publisher-proof.test.mjs
git commit -m "test: require trusted premerge publisher proof"
```

---

### Task 2: Add manual main-only secretless candidate build jobs

**Files:**
- Create: `.github/workflows/premerge-native-publisher-proof.yml`
- Test: `tests/structure/premerge-native-publisher-proof.test.mjs`

**Interfaces:**
- Consumes: workflow input `candidate_sha: string`.
- Produces: Actions artifacts `publisher-proof-windows-candidate` containing `FileQR-Windows-x64-unsigned.exe` and `publisher-proof-android-candidate` containing `FileQR-Android-arm64-unsigned.apk`.

- [ ] **Step 1: Add the workflow skeleton and trusted dispatch guard**

Start the workflow with exactly these trust properties:

```yaml
name: Pre-merge Native Publisher Proof

on:
  workflow_dispatch:
    inputs:
      candidate_sha:
        description: Exact 40-hex candidate commit SHA from Nolane-x/file-qr
        required: true
        type: string

permissions:
  contents: read

jobs:
  validate:
    if: github.ref == 'refs/heads/main'
    runs-on: ubuntu-latest
    outputs:
      candidate_sha: ${{ steps.candidate.outputs.sha }}
    steps:
      - name: Validate exact candidate SHA syntax
        id: candidate
        shell: bash
        env:
          CANDIDATE_SHA: ${{ inputs.candidate_sha }}
        run: |
          set -euo pipefail
          if ! [[ "$CANDIDATE_SHA" =~ ^[0-9a-fA-F]{40}$ ]]; then
            echo 'candidate_sha must be exactly 40 hexadecimal characters.' >&2
            exit 1
          fi
          echo "sha=$(printf '%s' "$CANDIDATE_SHA" | tr '[:upper:]' '[:lower:]')" >> "$GITHUB_OUTPUT"
```

Do not add any other trigger.

- [ ] **Step 2: Add the Windows secretless candidate build**

The `build_windows` job must `needs: validate`, checkout only `${{ needs.validate.outputs.candidate_sha }}`, assert exact HEAD equality, build the NSIS candidate with no signing secret, normalize it to `FileQR-Windows-x64-unsigned.exe`, compute SHA-256 for logs, and upload it.

Required build steps:

```yaml
  build_windows:
    needs: validate
    runs-on: windows-latest
    steps:
      - uses: actions/checkout@v6
        with:
          ref: ${{ needs.validate.outputs.candidate_sha }}
          persist-credentials: false
      - name: Bind checkout to exact candidate SHA
        shell: pwsh
        env:
          EXPECTED_SHA: ${{ needs.validate.outputs.candidate_sha }}
        run: |
          $actual = (git rev-parse HEAD).Trim().ToLowerInvariant()
          if ($actual -ne $env:EXPECTED_SHA.ToLowerInvariant()) { throw 'candidate SHA mismatch after checkout' }
      - uses: actions/setup-node@v6
        with:
          node-version: 24
      - uses: dtolnay/rust-toolchain@stable
      - run: npm install
      - name: Build unsigned Windows NSIS candidate
        run: npx tauri build --bundles nsis
        working-directory: apps/native
        env:
          VITE_SIGNALING_ORIGIN: ${{ vars.SIGNALING_ORIGIN || 'https://file-qr-signaling.nolane-file.workers.dev' }}
      - name: Normalize opaque Windows candidate
        shell: pwsh
        run: |
          New-Item -ItemType Directory -Force -Path publisher-proof | Out-Null
          $installer = Get-ChildItem apps/native/src-tauri/target/release/bundle/nsis/*.exe | Select-Object -First 1
          if ($null -eq $installer) { throw 'Windows NSIS candidate was not produced.' }
          Copy-Item $installer.FullName publisher-proof/FileQR-Windows-x64-unsigned.exe
          Get-FileHash publisher-proof/FileQR-Windows-x64-unsigned.exe -Algorithm SHA256
      - uses: actions/upload-artifact@v4
        with:
          name: publisher-proof-windows-candidate
          path: publisher-proof/FileQR-Windows-x64-unsigned.exe
          if-no-files-found: error
```

No `${{ secrets.* }}` expression is permitted in this job.

- [ ] **Step 3: Add the Android secretless unsigned-release candidate build**

The `build_android` job must `needs: validate`, checkout only the exact candidate SHA, initialize the generated Android project, build a non-debug release APK without publisher signing configuration, require an actual `*release-unsigned.apk`, normalize it, and upload it.

Required core:

```yaml
  build_android:
    needs: validate
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v6
        with:
          ref: ${{ needs.validate.outputs.candidate_sha }}
          persist-credentials: false
      - name: Bind checkout to exact candidate SHA
        shell: bash
        env:
          EXPECTED_SHA: ${{ needs.validate.outputs.candidate_sha }}
        run: |
          set -euo pipefail
          actual="$(git rev-parse HEAD | tr '[:upper:]' '[:lower:]')"
          test "$actual" = "$(printf '%s' "$EXPECTED_SHA" | tr '[:upper:]' '[:lower:]')" || {
            echo 'candidate SHA mismatch after checkout' >&2
            exit 1
          }
      - uses: actions/setup-node@v6
        with:
          node-version: 24
      - uses: android-actions/setup-android@v3
      - uses: dtolnay/rust-toolchain@stable
        with:
          targets: aarch64-linux-android,armv7-linux-androideabi,i686-linux-android,x86_64-linux-android
      - name: Install Android build tools
        run: sdkmanager "platform-tools" "platforms;android-36" "build-tools;36.0.0" "ndk;27.0.12077973"
      - run: npm install
      - name: Initialize Android project
        run: npm run android:init
        working-directory: apps/native
      - name: Build unsigned Android release candidate
        run: npx tauri android build --apk --target aarch64
        working-directory: apps/native
        env:
          NDK_HOME: ${{ env.ANDROID_HOME }}/ndk/27.0.12077973
          VITE_SIGNALING_ORIGIN: ${{ vars.SIGNALING_ORIGIN || 'https://file-qr-signaling.nolane-file.workers.dev' }}
      - name: Normalize opaque unsigned Android candidate
        shell: bash
        run: |
          set -euo pipefail
          mkdir -p publisher-proof
          apk="$(find apps/native/src-tauri/gen/android -type f -name '*release-unsigned.apk' -print -quit)"
          test -n "$apk" || { echo 'Unsigned Android release APK was not produced.' >&2; exit 1; }
          cp "$apk" publisher-proof/FileQR-Android-arm64-unsigned.apk
          sha256sum publisher-proof/FileQR-Android-arm64-unsigned.apk
      - uses: actions/upload-artifact@v4
        with:
          name: publisher-proof-android-candidate
          path: publisher-proof/FileQR-Android-arm64-unsigned.apk
          if-no-files-found: error
```

The Android build task must fail rather than fall back to a debug-signed APK if the unsigned release file is absent.

- [ ] **Step 4: Run the structural test**

Run:

```bash
node --test tests/structure/premerge-native-publisher-proof.test.mjs
```

Expected at this stage: still FAIL because signer/evidence sections are intentionally incomplete.

- [ ] **Step 5: Commit the secretless build layer**

```bash
git add .github/workflows/premerge-native-publisher-proof.yml
git commit -m "ci: build exact premerge publisher candidates"
```

---

### Task 3: Add isolated Windows and Android publisher signer jobs

**Files:**
- Modify: `.github/workflows/premerge-native-publisher-proof.yml`
- Test: `tests/structure/premerge-native-publisher-proof.test.mjs`

**Interfaces:**
- Consumes: unsigned candidate artifacts from Task 2 and the five repository publisher secrets.
- Produces: `publisher-proof-windows-result/windows-proof.json` and `publisher-proof-android-result/android-proof.json`; no signed application artifact is retained.

- [ ] **Step 1: Add the Windows signer with no repository checkout**

`sign_windows` must `needs: [validate, build_windows]`, download only `publisher-proof-windows-candidate`, import the PFX, validate publisher certificate properties, sign the opaque installer with Windows SDK `signtool.exe`, verify Authenticode and thumbprint equality, write sanitized proof JSON, then clean PFX/imported certs regardless of outcome.

The job must not contain `actions/checkout`, `npm`, `node`, `tauri`, or candidate-script execution.

Use repository secrets only in the signing step environment:

```yaml
          WINDOWS_CERTIFICATE: ${{ secrets.WINDOWS_CERTIFICATE }}
          WINDOWS_CERTIFICATE_PASSWORD: ${{ secrets.WINDOWS_CERTIFICATE_PASSWORD }}
```

The PowerShell signing logic must:

```powershell
$inputPath = 'candidate/FileQR-Windows-x64-unsigned.exe'
$signedPath = 'signed/FileQR-Windows-x64-signed.exe'
$pfxPath = Join-Path $env:RUNNER_TEMP 'file-qr-premerge-publisher.pfx'
$status = 'FAIL'
$signerThumbprint = $null
$inputSha256 = (Get-FileHash $inputPath -Algorithm SHA256).Hash.ToLowerInvariant()
$signedSha256 = $null
$importedThumbprints = @()
try {
  if ([string]::IsNullOrWhiteSpace($env:WINDOWS_CERTIFICATE)) { throw 'WINDOWS_CERTIFICATE is required.' }
  if ([string]::IsNullOrWhiteSpace($env:WINDOWS_CERTIFICATE_PASSWORD)) { throw 'WINDOWS_CERTIFICATE_PASSWORD is required.' }
  $base64 = ($env:WINDOWS_CERTIFICATE -replace '\s', '')
  [IO.File]::WriteAllBytes($pfxPath, [Convert]::FromBase64String($base64))
  $password = ConvertTo-SecureString -String $env:WINDOWS_CERTIFICATE_PASSWORD -Force -AsPlainText
  $imported = @(Import-PfxCertificate -FilePath $pfxPath -CertStoreLocation 'Cert:\CurrentUser\My' -Password $password)
  $importedThumbprints = @($imported | ForEach-Object { $_.Thumbprint } | Where-Object { $_ })
  $cert = $imported | Where-Object { $_.HasPrivateKey } | Select-Object -First 1
  if ($null -eq $cert) { throw 'Publisher certificate has no private key.' }
  if ($cert.NotAfter.ToUniversalTime() -le [DateTime]::UtcNow) { throw 'Publisher certificate is expired.' }
  $eku = @($cert.EnhancedKeyUsageList | ForEach-Object { $_.ObjectId.Value })
  if ($eku -notcontains '1.3.6.1.5.5.7.3.3') { throw 'Publisher certificate lacks Code Signing EKU.' }
  $signerThumbprint = $cert.Thumbprint.ToLowerInvariant()
  New-Item -ItemType Directory -Force -Path signed | Out-Null
  Copy-Item $inputPath $signedPath
  $signtool = Get-ChildItem "${env:ProgramFiles(x86)}\Windows Kits\10\bin" -Recurse -Filter signtool.exe |
    Sort-Object FullName -Descending | Select-Object -First 1
  if ($null -eq $signtool) { throw 'signtool.exe was not found.' }
  & $signtool.FullName sign /sha1 $cert.Thumbprint /fd SHA256 /tr $env:WINDOWS_TIMESTAMP_URL /td SHA256 $signedPath
  if ($LASTEXITCODE -ne 0) { throw 'signtool failed.' }
  $signature = Get-AuthenticodeSignature $signedPath
  if ($signature.Status -ne 'Valid') { throw "Authenticode verification failed: $($signature.Status)" }
  if ($signature.SignerCertificate.Thumbprint.ToLowerInvariant() -ne $signerThumbprint) { throw 'Signer thumbprint mismatch.' }
  $signedSha256 = (Get-FileHash $signedPath -Algorithm SHA256).Hash.ToLowerInvariant()
  $status = 'PASS'
} finally {
  New-Item -ItemType Directory -Force -Path proof | Out-Null
  [ordered]@{
    platform = 'windows'
    candidateSha = $env:CANDIDATE_SHA.ToLowerInvariant()
    status = $status
    inputSha256 = $inputSha256
    signedSha256 = $signedSha256
    signerThumbprint = $signerThumbprint
    observedAt = [DateTime]::UtcNow.ToString('o')
  } | ConvertTo-Json -Depth 4 | Set-Content -Encoding utf8 proof/windows-proof.json
  Remove-Item $pfxPath -Force -ErrorAction SilentlyContinue
  foreach ($thumbprint in $importedThumbprints) {
    Remove-Item "Cert:\CurrentUser\My\$thumbprint" -Force -ErrorAction SilentlyContinue
  }
}
```

Set `WINDOWS_TIMESTAMP_URL` from `${{ vars.WINDOWS_TIMESTAMP_URL || 'http://timestamp.comodoca.com' }}`. Add a following `if: always()` artifact upload for `proof/windows-proof.json`.

- [ ] **Step 2: Add the Android signer with no repository checkout**

`sign_android` must `needs: [validate, build_android]`, setup Android build-tools, download only `publisher-proof-android-candidate`, decode the keystore into runner temp, validate alias/certificate, `zipalign` before signing, sign with `apksigner`, verify signer identity, write sanitized proof, and always remove JKS/aligned/signed temporary files.

Secrets are restricted to the signing step environment:

```yaml
          ANDROID_KEY_BASE64: ${{ secrets.ANDROID_KEY_BASE64 }}
          ANDROID_KEY_PASSWORD: ${{ secrets.ANDROID_KEY_PASSWORD }}
          ANDROID_KEY_ALIAS: ${{ secrets.ANDROID_KEY_ALIAS }}
```

Use this fail-closed shell pattern:

```bash
set -euo pipefail
mkdir -p proof signed
input='candidate/FileQR-Android-arm64-unsigned.apk'
aligned="$RUNNER_TEMP/file-qr-premerge-aligned.apk"
signed="$RUNNER_TEMP/file-qr-premerge-signed.apk"
keystore="$RUNNER_TEMP/file-qr-premerge-release.jks"
status='FAIL'
input_sha256="$(sha256sum "$input" | cut -d' ' -f1)"
signed_sha256=''
certificate_sha256=''
write_proof() {
  python3 - "$CANDIDATE_SHA" "$status" "$input_sha256" "$signed_sha256" "$certificate_sha256" <<'PY'
import json, sys
from datetime import datetime, timezone
candidate, status, input_digest, signed_digest, cert_digest = sys.argv[1:]
with open('proof/android-proof.json', 'w', encoding='utf-8') as handle:
    json.dump({
        'platform': 'android',
        'candidateSha': candidate.lower(),
        'status': status,
        'inputSha256': input_digest,
        'signedSha256': signed_digest or None,
        'certificateSha256': cert_digest or None,
        'observedAt': datetime.now(timezone.utc).isoformat(),
    }, handle, indent=2)
PY
}
cleanup() {
  rc=$?
  write_proof || true
  rm -f "$keystore" "$aligned" "$signed"
  exit "$rc"
}
trap cleanup EXIT

test -n "$ANDROID_KEY_BASE64" || { echo 'ANDROID_KEY_BASE64 is required.' >&2; exit 1; }
test -n "$ANDROID_KEY_PASSWORD" || { echo 'ANDROID_KEY_PASSWORD is required.' >&2; exit 1; }
test -n "$ANDROID_KEY_ALIAS" || { echo 'ANDROID_KEY_ALIAS is required.' >&2; exit 1; }
printf '%s' "$ANDROID_KEY_BASE64" | base64 -d > "$keystore"
chmod 600 "$keystore"
keytool -list -keystore "$keystore" -storepass "$ANDROID_KEY_PASSWORD" -alias "$ANDROID_KEY_ALIAS" >/dev/null
certificate_sha256="$(keytool -exportcert -keystore "$keystore" -storepass "$ANDROID_KEY_PASSWORD" -alias "$ANDROID_KEY_ALIAS" | sha256sum | cut -d' ' -f1)"
zipalign -f -p 4 "$input" "$aligned"
apksigner sign --ks "$keystore" --ks-key-alias "$ANDROID_KEY_ALIAS" --ks-pass env:ANDROID_KEY_PASSWORD --key-pass env:ANDROID_KEY_PASSWORD --out "$signed" "$aligned"
signer_output="$(apksigner verify --verbose --print-certs "$signed")"
signer_sha256="$(printf '%s\n' "$signer_output" | awk -F': ' '/^Signer #1 certificate SHA-256 digest:/ { value=$2; gsub(/:/, "", value); print tolower(value); exit }')"
test -n "$signer_sha256" || { echo 'Android signer SHA-256 digest missing.' >&2; exit 1; }
test "$signer_sha256" = "$(printf '%s' "$certificate_sha256" | tr '[:upper:]' '[:lower:]')" || {
  echo 'Android signer certificate mismatch.' >&2
  exit 1
}
signed_sha256="$(sha256sum "$signed" | cut -d' ' -f1)"
status='PASS'
```

Add a following `if: always()` upload of `proof/android-proof.json` as `publisher-proof-android-result`.

- [ ] **Step 3: Re-run the structural test**

Run:

```bash
node --test tests/structure/premerge-native-publisher-proof.test.mjs
```

Expected: signer isolation/identity/cleanup assertions PASS; evidence assertions may still fail until Task 4.

- [ ] **Step 4: Commit the signer isolation layer**

```bash
git add .github/workflows/premerge-native-publisher-proof.yml
git commit -m "ci: isolate premerge publisher signer jobs"
```

---

### Task 4: Aggregate sanitized evidence and make PASS fail-closed

**Files:**
- Modify: `.github/workflows/premerge-native-publisher-proof.yml`
- Test: `tests/structure/premerge-native-publisher-proof.test.mjs`

**Interfaces:**
- Consumes: `windows-proof.json`, `android-proof.json`, `needs.*.result`, candidate SHA, GitHub run metadata.
- Produces: `premerge-native-publisher-proof-${{ github.run_id }}/premerge-native-publisher-proof.json` and a workflow failure if either platform is not a verified PASS.

- [ ] **Step 1: Add an `evidence` job that always runs after both signer jobs**

Required job shape:

```yaml
  evidence:
    if: always()
    needs: [validate, sign_windows, sign_android]
    runs-on: ubuntu-latest
    steps:
      - name: Download Windows sanitized proof
        continue-on-error: true
        uses: actions/download-artifact@v5
        with:
          name: publisher-proof-windows-result
          path: proof/windows
      - name: Download Android sanitized proof
        continue-on-error: true
        uses: actions/download-artifact@v5
        with:
          name: publisher-proof-android-result
          path: proof/android
```

- [ ] **Step 2: Generate one canonical evidence JSON without repository checkout**

Use inline Python only in this secretless job. It must read proof files if present, compare each `candidateSha` to the exact requested candidate, verify every digest/identity field is lowercase 64-hex (Windows thumbprint is 40-hex), and set `overallStatus` to `PASS` only when both `needs.sign_windows.result` and `needs.sign_android.result` are `success` and both proof JSON statuses are `PASS`.

The emitted JSON schema must be:

```json
{
  "schemaVersion": 1,
  "candidateSha": "<40-hex>",
  "workflowRunId": "<run id>",
  "workflowRunAttempt": "<attempt>",
  "overallStatus": "PASS|FAIL",
  "windows": {
    "status": "PASS|FAIL|MISSING",
    "inputSha256": "<64-hex-or-null>",
    "signedSha256": "<64-hex-or-null>",
    "signerThumbprint": "<40-hex-or-null>"
  },
  "android": {
    "status": "PASS|FAIL|MISSING",
    "inputSha256": "<64-hex-or-null>",
    "signedSha256": "<64-hex-or-null>",
    "certificateSha256": "<64-hex-or-null>"
  },
  "observedAt": "<UTC ISO-8601>"
}
```

The generator must write `overall_pass=true|false` to `$GITHUB_OUTPUT`.

- [ ] **Step 3: Upload evidence before asserting PASS**

```yaml
      - uses: actions/upload-artifact@v4
        if: always()
        with:
          name: premerge-native-publisher-proof-${{ github.run_id }}
          path: evidence/premerge-native-publisher-proof.json
          if-no-files-found: error

      - name: Require both publisher proofs to pass
        if: always()
        shell: bash
        env:
          OVERALL_PASS: ${{ steps.aggregate.outputs.overall_pass }}
        run: |
          test "$OVERALL_PASS" = 'true' || {
            echo 'Pre-merge publisher proof did not pass for both platforms.' >&2
            exit 1
          }
```

The upload must happen before the final assertion so a sanitized FAIL artifact survives a failed proof run.

- [ ] **Step 4: Run the targeted test and full test suite**

Run:

```bash
node --test tests/structure/premerge-native-publisher-proof.test.mjs
npm test
```

Expected: targeted test PASS; full repository test suite PASS with zero failures.

- [ ] **Step 5: Commit the evidence layer**

```bash
git add .github/workflows/premerge-native-publisher-proof.yml tests/structure/premerge-native-publisher-proof.test.mjs
git commit -m "ci: record sanitized premerge publisher evidence"
```

---

### Task 5: Exact-head verification, trusted deployment to main, and #9 proof handoff

**Files:**
- Modify: PR description only after evidence is available.
- No application/runtime file changes.

**Interfaces:**
- Consumes: final implementation branch SHA and PR #9 candidate SHA `c6eb1ceb5dff6eb16fe7e5831ce947488967fd0b` unless #9 moves.
- Produces: trusted workflow on `main`, then a manual evidence run that either proves publisher credentials for exact #9 head or fails closed with an external credential blocker.

- [ ] **Step 1: Run all ordinary PR gates on the implementation exact head**

Require fresh exact-head results for:

```text
CI
Browser Reliability
GitHub Pages Mirror
Native Builds
```

Do not count a previous head's GREEN as final evidence.

- [ ] **Step 2: Self-review the full implementation diff**

Verify line-by-line that:

```text
- no build job has secrets.*
- no signer job checks out repository code
- no signer job runs npm/node/Tauri/Gradle/candidate executables
- only opaque artifacts cross into signer jobs
- secret values are never echoed or serialized
- signed application binaries are not uploaded as final proof artifacts
- cleanup runs on success and failure paths
- evidence is exact-SHA/digest/certificate bound
- final PASS assertion is downstream of evidence upload
```

- [ ] **Step 3: Merge the trusted workflow through a PR only after exact-head GREEN**

Use squash merge with expected-head protection. Do not direct-push `main`.

- [ ] **Step 4: Dispatch the now-trusted workflow from `main` against the exact current PR #9 head**

Input:

```text
candidate_sha=c6eb1ceb5dff6eb16fe7e5831ce947488967fd0b
```

If PR #9 has moved, use its new exact 40-hex head instead and update the proof record.

- [ ] **Step 5: Review resulting evidence**

PASS requires all of the following:

```text
workflow ref = refs/heads/main
candidateSha = exact PR #9 head
windows.status = PASS
windows.signerThumbprint = 40-hex
windows.inputSha256 = 64-hex
windows.signedSha256 = 64-hex
android.status = PASS
android.certificateSha256 = 64-hex
android.inputSha256 = 64-hex
android.signedSha256 = 64-hex
overallStatus = PASS
no private credential fields exist
```

If repository publisher secrets are absent or invalid, keep PR #9 draft and record the exact missing/invalid credential boundary. Do not reinterpret preview artifacts as production publisher proof.

- [ ] **Step 6: Only after a successful exact-head pre-merge proof, proceed with PR #9's existing merge policy**

After #9 is merged, require the trusted `push main` Native Builds to execute the integrated production signing paths successfully before any release is described as publisher-signed.

---

## Plan Self-Review

- Spec coverage: every trust-boundary, build isolation, signer isolation, cleanup, evidence binding, fail-closed behavior, and merge-policy requirement from the design spec maps to a task above.
- Placeholder scan: no TBD/TODO/"similar to" steps remain.
- Interface consistency: the candidate input is consistently `candidate_sha`; build artifact names, per-platform proof artifact names, evidence field names, and exact SHA semantics are consistent across tasks.
- Scope: this plan implements only the trusted pre-merge native publisher proof seam. Branch protection, immutable-release admin configuration, physical Android evidence, TURN provisioning, and foreign-draft ownership remain separate tracked work.