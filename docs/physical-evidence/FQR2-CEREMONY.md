# FQR2 Trusted Physical Ceremony Procedure

This is the operator runbook for collecting Issue #50 physical optical evidence with File QR's trusted physical-evidence kit.

It does **not** turn hosted CI, a pull-request build, an emulator, a synthetic camera source, or copied JSON into physical proof. Authoritative evidence is admitted only when it is bound to one protected-main `Native Builds` push and then completed through a real display-to-camera path.

## Authority prerequisites

Before starting a ceremony:

1. Issue #15 (protected `main`) must be independently satisfied before any ceremony record is used to close #50 or justify production/default claims.
2. Select one successful, completed `Native Builds` workflow run triggered by a `push` to `main`.
3. Work from the exact trusted `main` commit named by that run. The preparation CLI requires its control HEAD to equal the run head SHA.
4. Authenticate GitHub CLI (`gh`) with permission to read this repository's Actions run/artifact metadata and bytes.
5. Start with a new, nonexistent ceremony workspace. Do **not** pre-populate it with local EXE/APK files.
6. Use only the generated non-personal payload created by preparation.
7. Do not capture or retain camera imagery. Do not record raw device serials, raw build fingerprints, camera names, local filesystem paths, network identifiers, or credentials in the evidence set.

Authoritative preparation does **not** accept operator-supplied Windows or Android binary paths. It resolves and fetches both artifacts itself so the tested installables cannot silently be replaced by stale or unrelated local binaries.

## Mandatory scenario matrix

The final matrix requires these eight scenario identifiers:

| Scenario | Required purpose |
| --- | --- |
| `fqr2-windows-to-android` | Baseline FQR2 Windows sender to physical Android receiver |
| `fqr2-android-to-windows` | Baseline FQR2 Android sender to Windows receiver with a real camera |
| `fqr1-windows-to-android` | FQR1 compatibility, Android receiver |
| `fqr1-android-to-windows` | FQR1 compatibility, Windows receiver |
| `fqr2-mid-cycle` | Receiver joins an already-running FQR2 broadcast mid-cycle |
| `fqr2-repair-phase` | Receiver begins in repair phase with intentionally missed frames |
| `fqr2-large-file` | FQR2 payload is strictly greater than 8 MiB |
| `fqr2-interruption-resume` | Transfer is interrupted and receiver resumes from durable state |

All accepted records in one summary must bind the same trusted build lineage and the same Windows/Android artifact identities.

## 1. Prepare one ceremony

Run from the exact trusted `main` checkout:

```bash
node scripts/prepare-optical-physical-evidence.mjs \
  --scenario <scenario> \
  --run-id <native-build-run-id> \
  --payload-bytes <bytes> \
  --workspace <new-nonexistent-workspace-path>
```

Do **not** pass the retired `--windows-binary` or `--android-binary` options. Authoritative preparation rejects legacy operator-supplied binary paths.

The controller performs the following fail-closed chain for each platform:

1. resolves the exact successful/completed `Native Builds` push-main run;
2. requires exactly one unexpired artifact with the expected name;
3. downloads the artifact archive by exact GitHub artifact ID;
4. hashes the downloaded archive and requires exact equality with GitHub's `artifactDigest`;
5. downloads/extracts the same unique run artifact into a controller-owned directory;
6. requires exactly one canonical non-empty regular installable;
7. independently hashes that installable and binds the binary SHA-256 into `preparation.json`.

Canonical controlled binaries are:

```text
<workspace>/artifacts/windows/FileQR-Windows-x64-setup.exe
<workspace>/artifacts/android/FileQR-Android-arm64.apk
```

The workspace also contains:

```text
<workspace>/payload.bin
<workspace>/preparation.json
```

The preparation JSON records no local paths. The temporary downloaded archive used for digest verification is removed after controlled extraction. If fetching, digest verification, layout validation, or preparation fails, the incomplete workspace is removed.

Payload policy is 1..64 MiB for FQR2 and 1..8 MiB for FQR1. For `fqr2-large-file`, choose a value strictly greater than 8 MiB, for example `8388609`.

Do not edit `preparation.json`. If any authority field changes, discard the whole workspace and prepare again.

## 2. Use only the controlled binaries

For the ceremony created above, install/run **only** the binaries materialized inside that workspace. A binary copied from another build, another workspace, a release download, or a local rebuild is not admissible for that preparation.

When Android is involved, use:

```text
<workspace>/artifacts/android/FileQR-Android-arm64.apk
```

When Windows is involved, use:

```text
<workspace>/artifacts/windows/FileQR-Windows-x64-setup.exe
```

The GitHub artifact archive digest and extracted binary SHA-256 are intentionally separate evidence facts; they identify different byte objects.

## 3. Collect sanitized platform facts

### Windows facts

On the physical Windows machine, run:

```powershell
node scripts/collect-windows-physical-evidence.mjs --output windows-device-facts.json
```

The collector asks Windows only for OS version and count of healthy Camera-class devices. It emits sanitized facts such as:

```json
{
  "platform": "windows",
  "osClass": "Windows <version>",
  "architecture": "<arch>",
  "cameraDevicePresent": true,
  "cameraDeviceCount": 1
}
```

A Windows **receiver** must have `cameraDevicePresent: true` and `cameraDeviceCount > 0`. A Windows sender may truthfully report zero cameras.

### Android facts and camera ownership

Use the controlled APK created by preparation and exactly one authorized physical ADB transport:

```bash
FILE_QR_APK=<workspace>/artifacts/android/FileQR-Android-arm64.apk \
FILE_QR_ANDROID_EVIDENCE_PATH=android-device-evidence.json \
node scripts/collect-android-physical-evidence.mjs
```

The collector independently hashes the APK, rejects emulator/virtual-device hardware, verifies CAMERA permission, launches File QR, observes File QR as an active camera client, cancels the scanner, verifies UI recovery, and writes only hashed serial/fingerprint identities.

When Android is receiver, `cameraOwnerObserved` must be true. When Android is only sender, do not invent receiver-camera ownership; the final role facts must reflect what was actually observed.

## 4. Perform the physical optical scenario

Use exactly `<workspace>/payload.bin` and the controlled installables bound by that workspace's `preparation.json`.

The optical path must be a real display observed by a real camera. Virtual camera sources, prerecorded media, synthetic decoders, screenshots, or another File QR build are not admissible substitutes. Do not capture or save camera imagery as evidence.

Perform the selected scenario honestly:

- `fqr2-mid-cycle`: begin receiving only after the broadcast is already in progress.
- `fqr2-repair-phase`: begin in repair phase and intentionally miss frames; use exactly one FQR2 block (`65536` bytes).
- `fqr2-large-file`: use a generated payload greater than 8 MiB.
- `fqr2-interruption-resume`: interrupt only after durable progress exists, reopen/restart as required, and observe real resume before completion.

Save the final received file without modification. The finalizer hashes it independently; operator-supplied expected hashes are not accepted.

## 5. Build `platform-facts.json`

The finalizer accepts only normalized role facts, not arbitrary collector output. Create exactly `sender` and `receiver`.

Example Windows role:

```json
{
  "platform": "windows",
  "osClass": "Windows 10.0.22631.0",
  "deviceClass": "physical-windows",
  "cameraDevicePresent": true,
  "cameraDeviceCount": 1
}
```

Do not copy the collector's `architecture` into the final record; the final schema intentionally does not accept it.

Example Android role:

```json
{
  "platform": "android",
  "osClass": "Android 16",
  "deviceClass": "physical-android",
  "physicalDevice": true,
  "emulatorRejected": true,
  "cameraPermissionGranted": true,
  "cameraOwnerObserved": true
}
```

A complete file has only:

```json
{
  "sender": { "...": "role-specific normalized facts" },
  "receiver": { "...": "role-specific normalized facts" }
}
```

Do not add build SHA, artifact IDs, expected hashes, assertions, result, local paths, or credentials. Authority fields come from immutable preparation or are derived by finalization.

## 6. Write `operator-observations.json`

Use exactly these keys:

```json
{
  "physicalDisplayToCameraPath": true,
  "virtualCameraAbsent": true,
  "joinedMidCycle": false,
  "repairPhaseOnlyStart": false,
  "framesIntentionallyMissed": false,
  "interruptionPerformed": false,
  "resumeObserved": false,
  "observedCycles": null
}
```

Set values from what physically happened. Never set a scenario boolean merely to make validation pass. `observedCycles` may remain `null` when not reliably measured.

## 7. Finalize one evidence record

```bash
node scripts/finalize-optical-physical-evidence.mjs \
  --preparation <workspace>/preparation.json \
  --received <path-to-final-received-file> \
  --platform-facts platform-facts.json \
  --observations operator-observations.json \
  --output evidence-<scenario>.json
```

Finalization revalidates preparation authority, independently hashes/measures received bytes, derives assertions/result, rejects unknown operator keys, and publishes final JSON only after validation. A ceremony that fails its exact scenario contract does not leave a PASS artifact.

Never hand-edit a final evidence record into PASS.

## 8. Repeat and summarize the matrix

Complete all eight scenarios against the same admitted build lineage, then run:

```bash
node scripts/summarize-optical-physical-evidence.mjs \
  evidence-fqr2-windows-to-android.json \
  evidence-fqr2-android-to-windows.json \
  evidence-fqr1-windows-to-android.json \
  evidence-fqr1-android-to-windows.json \
  evidence-fqr2-mid-cycle.json \
  evidence-fqr2-repair-phase.json \
  evidence-fqr2-large-file.json \
  evidence-fqr2-interruption-resume.json \
  --output fqr2-physical-evidence-summary.json
```

A complete matrix returns `matrixComplete: true`. An incomplete but internally valid set writes a truthful summary with explicit `missing` categories and exits non-zero. Malformed or non-authoritative records do not produce a summary artifact.

## Failure meanings added by the artifact-binding hardening

- `FQR_EVIDENCE_ARTIFACT_FETCH`: GitHub artifact retrieval failed/unavailable, or a retired external binary path was supplied.
- `FQR_EVIDENCE_ARTIFACT_BYTES`: downloaded artifact archive bytes do not match GitHub's recorded SHA-256 digest.
- `FQR_EVIDENCE_ARTIFACT_LAYOUT`: controlled extraction is not exactly the expected canonical installable.

These conditions are authority failures, not warnings; start a new ceremony only after the underlying problem is corrected.

## Claim boundary

A green hosted `CI`, `Browser Reliability`, `GitHub Pages Mirror`, or `Native Builds` run proves only that evidence machinery and existing product gates passed for that source revision. It is **not** physical camera evidence.

PR artifacts cannot close #50. Protected-main trust in #15 remains an independent prerequisite. The existing Android self-hosted workflow remains manual-only and trusted-main-only; do not add a PR-triggered physical workflow.

`ceremonyId` remains a deterministic identifier, not an authentication signature. The artifact archive digest and controlled binary hashes provide provenance facts; neither changes the sender-authentication properties of FQR1/FQR2.

Wall-clock duration, observed cycles, display settings, QR preset behavior, or one device pair's result are observations for that ceremony. They are not guaranteed throughput, distance, device compatibility, or universal performance claims. Any production-default or performance claim requires its own evidence boundary.