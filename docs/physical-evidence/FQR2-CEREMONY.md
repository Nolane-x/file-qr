# FQR2 Trusted Physical Ceremony Procedure

This document is the operator runbook for collecting Issue #50 physical optical evidence with the repository's trusted physical-evidence kit.

It does **not** turn hosted CI, a pull-request build, an emulator, a synthetic camera source, or a copied JSON record into physical proof. Authoritative evidence is admitted only when it is bound to one trusted `main` `Native Builds` push and then completed through a real display-to-camera path.

## Authority prerequisites

Before starting a ceremony:

1. Issue #15 (protected `main`) must be independently satisfied before any ceremony record is used to close Issue #50 or justify production-default claims.
2. Select one successful `Native Builds` workflow run triggered by a `push` to `main`.
3. Download **both** `file-qr-windows` and `file-qr-android` artifacts from that exact same workflow run.
4. Work from the exact trusted `main` commit named by that run. Do not use PR artifacts or a local rebuild as substitutes.
5. Use only generated non-personal payloads from the preparation CLI.
6. Do not capture or retain camera imagery. Do not record raw device serials, raw build fingerprints, camera names, local filesystem paths, network identifiers, or credentials in the evidence set.

The preparation resolver fails closed if the run is not the expected repository/workflow/event/branch, if the two artifacts are not present exactly once, or if the run/artifacts are not admissible.

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
| `fqr2-interruption-resume` | Transfer is interrupted and the receiver resumes from durable state |

All accepted records in one summary must bind the same trusted build lineage and the same Windows/Android artifact identities.

## 1. Prepare one ceremony

Run from the exact trusted `main` checkout. Replace values in angle brackets with the selected run and downloaded binary paths.

```bash
node scripts/prepare-optical-physical-evidence.mjs \
  --scenario <scenario> \
  --run-id <native-build-run-id> \
  --windows-binary <path-to-windows-binary> \
  --android-binary <path-to-android-apk> \
  --payload-bytes <bytes> \
  --workspace <new-empty-workspace-path>
```

The command creates only a generated payload and its immutable preparation record inside the new workspace:

- `payload.bin`
- `preparation.json`

The preparation record binds the trusted commit, one `Native Builds` run, both artifact identities, independent hashes of the local downloaded binaries, the generated payload hash/length, scenario/protocol geometry, start timestamp, and deterministic `ceremonyId`.

Payload policy is 1..64 MiB for FQR2 and 1..8 MiB for FQR1. For `fqr2-large-file`, choose a value strictly greater than 8 MiB, for example `8388609`.

Do not edit `preparation.json` after it is generated. If any authority field changes, discard the workspace and prepare again.

## 2. Collect sanitized platform facts

### Windows facts

On the physical Windows machine, run:

```powershell
node scripts/collect-windows-physical-evidence.mjs --output windows-device-facts.json
```

The collector asks Windows only for the OS version and the count of healthy Camera-class devices. It outputs:

```json
{
  "platform": "windows",
  "osClass": "Windows <version>",
  "architecture": "<arch>",
  "cameraDevicePresent": true,
  "cameraDeviceCount": 1
}
```

A Windows **receiver** must have `cameraDevicePresent: true` and `cameraDeviceCount > 0`. A Windows sender may report zero cameras; the count must still be truthful.

### Android facts and camera ownership

Use the repository's existing physical Android collector on the real Android device with exactly one authorized ADB transport:

```bash
FILE_QR_APK=<path-to-android-apk> \
FILE_QR_ANDROID_EVIDENCE_PATH=android-device-evidence.json \
node scripts/collect-android-physical-evidence.mjs
```

That collector independently hashes the APK, rejects emulator/virtual-device hardware, verifies CAMERA permission, launches File QR, observes File QR as an active camera client, cancels the scanner, verifies UI recovery, and writes only hashed serial/fingerprint identities.

When Android is the receiver, `cameraOwnerObserved` must be true. When Android is only the sender, do not invent receiver-camera ownership; the final platform-facts entry must reflect what was actually observed for that role.

## 3. Perform the physical optical scenario

Use the exact prepared `payload.bin` and the binaries bound in `preparation.json`.

The optical path must be a real display observed by a real camera. Virtual camera sources are not admissible. Do not capture or save camera imagery as part of this ceremony.

Perform the behavior required by the selected scenario. In particular:

- `fqr2-mid-cycle`: begin receiving after the broadcast is already in progress.
- `fqr2-repair-phase`: begin in repair-only phase and intentionally miss frames; the prepared payload must be exactly one FQR2 block (65536 bytes).
- `fqr2-large-file`: use a generated payload greater than 8 MiB.
- `fqr2-interruption-resume`: interrupt after durable progress exists, reopen/restart as required, and observe actual resume before completion.

Save the final received file without modifying it. The finalizer hashes this file independently; operator-supplied hashes are not accepted.

## 4. Build `platform-facts.json`

The finalizer accepts only normalized role facts, not arbitrary collector output. Create a small JSON object with exactly `sender` and `receiver`.

For a Windows role, copy the truthful values from `windows-device-facts.json` and add a short non-identifying `deviceClass`. Do **not** copy `architecture` into the final record because the final schema does not accept it.

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

For an Android role, derive only the accepted facts from `android-device-evidence.json`:

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

A complete file therefore has this shape:

```json
{
  "sender": { "...": "role-specific normalized facts" },
  "receiver": { "...": "role-specific normalized facts" }
}
```

Do not add build SHA, artifact IDs, expected hashes, assertions, result, local paths, or credentials here. Those authority fields come from the immutable preparation or are derived by the finalizer.

## 5. Write `operator-observations.json`

This file must contain exactly these keys:

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

Set each value from what actually happened. Scenario-specific booleans must not be set to true merely to make validation pass. `observedCycles` may remain `null` when it was not measured.

## 6. Finalize one evidence record

```bash
node scripts/finalize-optical-physical-evidence.mjs \
  --preparation <workspace>/preparation.json \
  --received <path-to-final-received-file> \
  --platform-facts platform-facts.json \
  --observations operator-observations.json \
  --output evidence-<scenario>.json
```

The finalizer revalidates preparation authority, independently hashes and measures the received file, derives assertions/result, rejects unknown operator keys, and publishes the final JSON only after validation. A ceremony that does not satisfy its exact scenario contract does not leave a PASS artifact.

Never hand-edit a final evidence record into PASS.

## 7. Repeat and summarize the matrix

Prepare and complete all eight required scenarios against the same admitted build lineage. Then run:

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

A complete matrix returns `matrixComplete: true`. An incomplete but internally valid set writes a truthful summary with explicit `missing` categories and then exits non-zero. Malformed or non-authoritative records do not produce a summary artifact.

## Claim boundary

A green hosted `CI`, `Browser Reliability`, `GitHub Pages Mirror`, or `Native Builds` run proves only that the evidence machinery and existing product gates passed for that source revision. It is **not** physical camera evidence.

PR artifacts cannot close Issue #50. Protected-main trust in Issue #15 remains an independent prerequisite. The existing Android self-hosted workflow remains manual-only and trusted-main-only; do not add a PR-triggered physical workflow.

Wall-clock duration, observed cycles, display settings, QR preset behavior, or one device pair's result are empirical observations for that ceremony. They are not guaranteed throughput, distance, device-compatibility, or universal performance claims. Any production-default or performance claim requires its own physical evidence boundary.
