# FQR2 Physical Ceremony Kit — Design Specification

Date: 2026-09-10
Status: design for review
Tracks: #50
Related: #15, #17, #48, #49

## 1. Purpose

This specification defines a trusted, privacy-preserving physical evidence kit for QR Stream v0.2 / FQR2.

The kit exists to answer a narrow question that hosted tests cannot answer:

> Did an exact File QR build transfer exact file bytes through a real display-to-camera path on physical Windows/Android hardware under a recorded ceremony, and did the received bytes equal the source bytes?

The kit is evidence machinery. It is not a new transfer protocol, not a benchmark framework, not a release signer, and not a substitute for repository governance.

## 2. Current authority boundary

At design time:

- trusted `main` is `0e08ee50385c40e1ad9db5d446136e0f25d11ac1`;
- `main` is not protected and required-status enforcement is off;
- FQR2 implementation is isolated in draft PR #49 at candidate `7c65e3403a9300d664c787b802b8b3e573cabaf5`;
- hosted FQR2 code gates are green on that candidate, but no physical FQR2 optical transfer evidence exists;
- Issue #50 is the physical FQR2 evidence gate;
- the repository already contains Android-only physical-camera evidence machinery for Issue #17.

The kit must not weaken these boundaries merely to obtain faster evidence.

## 3. Goals

The first version must:

1. bind each ceremony to exact trusted control code and exact tested application binaries;
2. generate or admit only privacy-safe test payloads and record their SHA-256 before transfer;
3. record physical transfer direction and platform/device class without storing serial numbers or camera imagery;
4. distinguish machine-verifiable evidence from human physical observations;
5. require received-file SHA-256 equality before a transfer can pass;
6. support the Issue #50 matrix: Windows -> Android, Android -> Windows, FQR1 compatibility, FQR2 mid-cycle join, FQR2 repair-phase receive, >8 MiB persistent-storage receive, and interruption/resume;
7. fail closed on malformed, incomplete, contradictory, stale, or wrong-build evidence;
8. produce deterministic sanitized JSON suitable for attachment to an issue or long-term archival;
9. reuse the existing Android physical-device collector where it provides real value rather than duplicating emulator rejection and device sanitization;
10. keep FQR1/FQR2 application behavior unchanged.

## 4. Non-goals

Version 1 does not:

- make FQR2 the default sender mode;
- raise the 64 MiB FQR2 admission cap;
- add a new QR/FEC schedule;
- add transfer telemetry to the production protocol;
- claim universal camera compatibility, range, or throughput;
- sign binaries or replace PR #9 publisher proof;
- configure branch protection or repository rulesets;
- capture screenshots, camera frames, screen recordings, audio, serial numbers, Wi-Fi identifiers, or personal files;
- run pull-request code on self-hosted physical runners;
- treat synthetic QR decoding, a virtual camera, emulator, or prerecorded video as physical evidence;
- silently infer a human physical observation that the tooling cannot machine-prove.

## 5. Trust model

### 5.1 Trusted control code

The ceremony controller, validator, schema, and helper scripts must come from trusted `main` after repository trust Issue #15 is closed.

Physical evidence is not authoritative when the control scripts themselves come from an unmerged PR checkout.

### 5.2 Tested application build

The tested File QR binary is a subject of the ceremony, not an authority for declaring its own PASS.

The controller records and independently hashes the binary before installation/execution.

For v1 authoritative closure, tested binaries must be traceable to an exact protected-main commit or an exact release produced from protected main. A PR artifact may be used for informal debugging outside the authoritative ceremony, but it cannot close Issue #50.

This avoids executing untrusted pull-request code on repository self-hosted infrastructure merely to obtain pre-merge evidence.

### 5.3 Repository governance ordering

The intended ordering is:

1. close #15 and enforce protected `main`;
2. integrate the generic ceremony kit through protected main;
3. integrate FQR2 as experimental through protected main after its hosted gates remain green;
4. obtain exact integrated native artifacts;
5. run physical ceremonies against those exact artifacts;
6. validate and record evidence for #50;
7. only then consider any separately designed default/promotion decision.

The kit may be implemented and hosted-tested in a PR before #15 closes, but it must not be represented as trusted physical evidence until integrated through the protected boundary.

### 5.4 No self-attestation

The File QR application under test may expose normal UI state such as cycle/block progress, but no application-produced `PASS` field is trusted.

PASS is computed by a separate validator from recorded evidence and independently hashed files/artifacts.

## 6. Evidence strength model

Every evidence field is classified as one of:

### 6.1 Machine-verified

Examples:

- control-code commit SHA;
- tested binary SHA-256;
- source payload SHA-256 and byte length;
- received payload SHA-256 and byte length;
- exact hash equality;
- Android emulator rejection and sanitized physical-device properties;
- artifact/run/release identity when resolved from GitHub metadata;
- required schema fields and cross-field consistency;
- whether file size exceeds the 8 MiB FQR2 memory-fallback threshold;
- timestamps and deterministic ceremony identifiers.

### 6.2 Human-observed physical facts

Some physical facts cannot be safely machine-proved without adding intrusive video capture or production instrumentation. They are recorded explicitly as operator observations, never silently promoted to machine proof.

Examples:

- the sender display was physically visible to the receiver camera;
- no virtual camera or prerecorded video was used;
- the receiver scan was started after the sender UI had advanced to the requested cycle;
- frames were intentionally obscured/missed during a repair ceremony;
- a physical interruption was performed at the requested checkpoint;
- Windows receiver used the intended physical webcam.

Each such fact is stored under `operatorObservations`, not under machine assertions.

### 6.3 Derived validator assertions

The validator derives claims such as:

- `exactBytesMatch`;
- `largeFilePersistentPathRequired`;
- `midCycleJoinClaimComplete`;
- `repairPhaseClaimComplete`;
- `resumeClaimComplete`;
- `artifactBindingComplete`;
- `privacyContractComplete`;
- final `result: PASS | FAIL`.

The operator does not directly edit derived assertions.

## 7. Ceremony architecture

Version 1 uses four small components.

### 7.1 Pure evidence model/validator

A pure Node module owns:

- schema constants;
- canonical field validation;
- SHA/identifier format validation;
- matrix-specific requirements;
- cross-field consistency rules;
- PASS/FAIL derivation;
- privacy checks;
- deterministic normalization for stored JSON.

It performs no camera access and no UI automation.

### 7.2 Preparation CLI

A trusted-main CLI creates a ceremony workspace and manifest.

Inputs include:

- ceremony scenario;
- tested build identity;
- tested binary path(s);
- optional GitHub run/release metadata;
- requested payload size.

The CLI:

1. hashes tested binaries;
2. creates a privacy-safe deterministic-or-random test payload according to scenario;
3. records source SHA-256 and size;
4. writes a ceremony manifest with no PASS result;
5. prints human instructions specific to the scenario.

The payload must contain no personal/user data. Default payloads are generated bytes with a small non-sensitive header identifying only the ceremony schema/version.

### 7.3 Platform collectors

Platform collectors record facts that can be independently obtained from the host/device.

Android v1 reuses/refactors the existing `collect-android-physical-evidence.mjs` capabilities for:

- exactly one authorized physical ADB device;
- emulator rejection;
- package identity/version;
- CAMERA permission;
- sanitized device class;
- no camera imagery capture.

The FQR2 ceremony does not require the Android collector to capture frames.

Windows v1 records only non-sensitive platform/build facts needed by the ceremony. It must not attempt hidden webcam image capture. Where a physical-webcam fact cannot be established machine-only without invasive instrumentation, it remains an operator observation.

### 7.4 Finalization CLI

After the physical transfer, the operator supplies the received file path and records the required physical observations.

The finalizer:

1. hashes the received file independently;
2. records byte length;
3. imports sanitized platform collector facts;
4. records structured operator observations;
5. invokes the pure validator;
6. writes final sanitized evidence JSON;
7. exits non-zero on FAIL;
8. never deletes the source or received file unless the operator explicitly requests cleanup after evidence is written.

## 8. Repository layout

The implementation plan may adjust exact names, but the intended boundaries are:

- `packages/core/physical-evidence.js` — pure schema/normalization/validation logic;
- `scripts/prepare-optical-physical-evidence.mjs` — preparation CLI;
- `scripts/finalize-optical-physical-evidence.mjs` — finalization CLI;
- `scripts/collect-android-physical-evidence.mjs` — reuse/refactor only where necessary;
- optional `scripts/collect-windows-physical-evidence.mjs` — sanitized Windows host facts only;
- `tests/core/physical-evidence.test.mjs` — validator behavior;
- `tests/structure/physical-evidence-kit.test.mjs` — trust/privacy/scope guards;
- `docs/physical-evidence/FQR2-CEREMONY.md` — operator ceremony instructions added only with implementation.

The design does not require a new self-hosted workflow in v1.

## 9. Why v1 is local/manual instead of a new physical GitHub workflow

The repository's existing Android physical workflow is deliberately manual-only, main-only, and self-hosted. Its structural tests explicitly reject pull-request and push triggers and require checkout of trusted main.

A new workflow that checks out PR #49 or executes arbitrary PR artifacts on the same physical runner would weaken that trust model.

Therefore v1 keeps physical execution local/manual and keeps the control scripts from trusted main. GitHub-hosted CI verifies the evidence machinery itself; it does not pretend to be a physical ceremony.

A future dedicated, disposable, secretless hardware lab may automate more steps under a separately reviewed threat model. That is outside this spec.

## 10. Evidence schema v1

The final evidence object has this conceptual shape:

```json
{
  "schemaVersion": 1,
  "ceremonyId": "...",
  "scenario": "fqr2-windows-to-android",
  "control": {
    "repository": "Nolane-x/file-qr",
    "trustedMainSha": "<40-hex>"
  },
  "build": {
    "commitSha": "<40-hex>",
    "source": "actions-main | release-main",
    "workflowRunId": null,
    "releaseTag": null,
    "artifactName": "...",
    "artifactDigest": "sha256:<64-hex>",
    "binarySha256": "<64-hex>"
  },
  "payload": {
    "generated": true,
    "bytes": 9437184,
    "sourceSha256": "<64-hex>",
    "receivedBytes": 9437184,
    "receivedSha256": "<64-hex>"
  },
  "protocol": {
    "version": "FQR2",
    "blockBytes": 65536,
    "symbolBytes": 768
  },
  "sender": {
    "platform": "windows | android",
    "osClass": "...",
    "deviceClass": "..."
  },
  "receiver": {
    "platform": "windows | android",
    "osClass": "...",
    "deviceClass": "..."
  },
  "operatorObservations": {
    "physicalDisplayToCameraPath": true,
    "virtualCameraAbsent": true,
    "joinedMidCycle": false,
    "repairPhaseOnlyStart": false,
    "framesIntentionallyMissed": false,
    "interruptionPerformed": false,
    "resumeObserved": false
  },
  "measurements": {
    "startedAt": "...",
    "completedAt": "...",
    "wallClockMs": 0,
    "observedCycles": null
  },
  "privacy": {
    "cameraImageryCaptured": false,
    "personalPayloadUsed": false,
    "rawDeviceSerialStored": false
  },
  "assertions": {
    "artifactBindingComplete": true,
    "exactBytesMatch": true,
    "privacyContractComplete": true
  },
  "result": "PASS"
}
```

This is conceptual, not permission to accept arbitrary additional fields. The implementation validator defines an exact allowed-key schema and rejects unknown security-relevant fields rather than ignoring them.

## 11. Ceremony identifier

`ceremonyId` is an identifier, not a secret or authentication token.

It is derived from stable non-secret inputs sufficient to avoid accidental evidence mixups, for example a truncated SHA-256 over:

- schema version;
- trusted control SHA;
- tested build SHA;
- scenario;
- source payload SHA;
- ceremony start timestamp.

The full derivation must be deterministic and specified in implementation tests.

## 12. Build/artifact binding

A ceremony cannot pass unless:

- `build.commitSha` is valid 40-hex;
- the tested binary exists and has an independently computed SHA-256;
- any supplied GitHub artifact digest is syntactically valid;
- run/release metadata and source type are internally consistent;
- the control SHA and build SHA are recorded separately;
- an authoritative ceremony uses a protected-main build lineage, not a PR-only build lineage.

If the binary came from a GitHub Actions artifact ZIP, the archive/artifact digest and the extracted binary SHA-256 are both useful and must not be conflated.

## 13. Payload rules

### 13.1 Generated payloads

Default ceremonies generate a privacy-safe payload.

The generator records:

- exact byte size;
- source SHA-256;
- generator/schema version.

Payload bytes need not be reproducible from public metadata. There is no requirement to use a predictable PRNG.

### 13.2 Personal files

Authoritative v1 evidence refuses a manifest marked as using personal payload data.

This keeps evidence archives safe and makes deletion/retention simpler.

### 13.3 Received bytes

The received file is never trusted merely because the File QR UI says complete.

The finalizer independently computes:

- byte length;
- SHA-256.

Exact length and SHA-256 equality are mandatory for PASS.

## 14. Required scenario matrix

Each scenario is an independent ceremony record. One giant JSON file does not collapse unrelated tests into an ambiguous PASS.

### 14.1 FQR2 Windows sender -> Android camera receiver

Requires:

- FQR2;
- Windows sender;
- physical Android receiver;
- Android physical-device collector success;
- physical display-to-camera observation;
- exact received-byte equality.

### 14.2 FQR2 Android sender -> Windows webcam receiver

Requires:

- FQR2;
- Android sender;
- Windows receiver;
- physical webcam observation;
- exact received-byte equality.

### 14.3 FQR1 compatibility

At least one physical receive ceremony per receiver platform class must retain FQR1 compatibility evidence.

FQR1 evidence is not used to infer FQR2 behavior.

### 14.4 FQR2 mid-cycle join

Requires an operator-recorded observation that the receiver began scanning only after broadcast was already active and not at initial frame zero, plus exact-byte completion.

If cycle position cannot be observed reliably, the record cannot assert a stronger cycle number than was actually observed.

### 14.5 FQR2 repair-phase ceremony

The simplest v1 ceremony uses a single-block payload small enough to keep the sender's block identity stable while waiting for the first systematic cycle to finish.

The operator begins receiver scanning only after the sender UI reports a later cycle. The record stores that as an operator observation.

A successful exact-byte transfer then demonstrates physical decode during repair-phase broadcast rather than relying solely on the initial systematic cycle.

This is still a physical/operator observation, not cryptographic proof of which individual fountain equation solved the block. The evidence language must remain that precise.

### 14.6 FQR2 >8 MiB persistent-storage ceremony

Requires:

- FQR2;
- payload strictly greater than 8 MiB;
- exact-byte completion;
- a receiver environment where FQR2 persistent random-access storage is available.

Because the implementation refuses >8 MiB memory fallback, successful exact-byte completion is consistent with the persistent-storage path. The evidence must not claim direct internal OPFS tracing unless separately instrumented.

### 14.7 FQR2 interruption/resume ceremony

Requires:

- an intentional interruption after at least one durable block is visible to the operator;
- restart/resume without replacing the source payload;
- completion with exact received SHA-256;
- explicit operator observation of interruption and resumed progress.

The ceremony must not claim which internal sidecar writes occurred unless machine instrumentation proves it.

## 15. Timing and performance evidence

`wallClockMs` and observed cycle counts are observations only.

The validator must reject or ignore derived throughput claims such as “MB/s guaranteed”, “works at N meters”, or “universal camera support”.

A small physical sample cannot establish those claims.

## 16. Privacy requirements

Authoritative evidence must satisfy all of the following:

- `cameraImageryCaptured === false`;
- `personalPayloadUsed === false`;
- no raw Android serial number;
- no raw build fingerprint when an existing hashed representation is sufficient;
- no MAC address, IP address, SSID, Bluetooth identifier, or account token;
- no filesystem path containing a user home name in archived evidence;
- no environment-variable dump;
- no GitHub token or release credential;
- no source or received payload bytes in evidence JSON.

Local file paths may be used transiently by the CLI but are omitted or basename-normalized in final evidence.

## 17. Failure policy

The kit fails closed on:

- unknown schema version;
- unknown scenario;
- missing required keys;
- invalid SHA/digest syntax;
- source/received size mismatch;
- source/received SHA mismatch;
- missing tested binary;
- artifact/binary identity inconsistency;
- contradictory platform direction;
- emulator/virtual-device Android evidence;
- a required operator observation being false or absent for its scenario;
- privacy contract violation;
- timestamps with impossible ordering;
- unknown security-relevant fields;
- attempt to mark an unprotected/PR-only build lineage as authoritative physical closure.

A failure writes diagnostic output but does not emit a final `result: PASS` record.

## 18. Evidence mutation and canonicalization

Preparation manifests are immutable inputs to finalization except for explicitly designated observation/result sections.

The finalizer must not silently replace:

- control SHA;
- build SHA;
- binary hash;
- source payload hash;
- scenario;
- protocol version.

Canonical output uses stable field ordering and normalized scalar formats so that evidence diffs are reviewable.

The JSON itself is not a digital signature. If future provenance requires cryptographic attestation, that is a separate design.

## 19. Existing Android collector integration

The current Android collector already provides useful machinery:

- authorized-device enumeration;
- emulator rejection using Android properties;
- installed package checks;
- CAMERA permission check;
- camera service ownership observation for the scanner path;
- sanitized hashes for device serial/build fingerprint;
- explicit `cameraImageryCaptured: false`.

The ceremony kit should reuse these primitives or normalized output where practical.

It must not regress Issue #17 behavior or weaken the existing main-only physical workflow.

## 20. Windows evidence boundary

Windows v1 deliberately avoids covert or invasive camera capture.

The collector may record non-sensitive OS/runtime/device-class information and presence of an available camera device where this can be done with stable system APIs. It must not capture frames.

The stronger statement “File QR received this transfer through this physical webcam” comes from the physical ceremony plus exact output equality and operator observation, not from hidden camera surveillance.

## 21. Hosted test strategy

Hosted CI proves evidence machinery, not physical optics.

Required pure/unit cases include:

- exact schema acceptance;
- unknown-key rejection where security-relevant;
- invalid SHA/digest rejection;
- source/received length mismatch;
- source/received SHA mismatch;
- invalid timestamps;
- inconsistent build source metadata;
- PR-only build rejected for authoritative closure;
- each scenario's required observation matrix;
- >8 MiB threshold boundary;
- FQR1/FQR2 scenario separation;
- canonical normalization stability;
- ceremony-id deterministic vector;
- privacy violation rejection;
- raw serial/path leakage rejection.

Required structural cases include:

- no workflow triggered by pull request is added for physical self-hosted evidence;
- existing Android physical workflow remains main-only;
- no screenshots/screencap/screenrecord/video capture are introduced;
- no GitHub secrets are required by pure validation scripts;
- production FQR1/FQR2 encoder/decoder behavior is not modified by the evidence-kit PR;
- package version is unchanged;
- no signaling/TURN/release/signing code is changed.

## 22. TDD lineage requirement

After this written spec is approved:

1. write the implementation plan;
2. create an isolated implementation branch;
3. add validator/structure tests first with no production evidence-kit implementation;
4. preserve a hosted RED commit whose failures correspond only to the absent/new evidence contracts;
5. add the minimum pure validator/CLI implementation to reach GREEN;
6. add platform collector integration in separate RED -> GREEN slices;
7. run full repository CI/build gates on the exact final head;
8. audit changed-file scope;
9. keep the PR unmerged while #15 remains open.

Physical hardware is not required to make the evidence-kit code tests GREEN. It is required to close #50.

## 23. Physical ceremony execution after integration

Once protected-main integration exists, the human operator performs each required ceremony using trusted-main kit code and exact integrated native artifacts.

A typical flow is:

1. obtain the exact trusted build;
2. run preparation CLI;
3. install/open the exact binary on sender/receiver devices;
4. perform the scenario-specific physical steps;
5. save the received file;
6. run finalization CLI against that file;
7. inspect `result` and diagnostics;
8. attach sanitized evidence JSON to #50;
9. retain native artifact/run IDs and hashes in the issue record.

No step requires uploading camera imagery.

## 24. Issue #50 closure rule

Issue #50 may close only when all mandatory physical scenarios have accepted evidence bound to the same integrated FQR2 lineage or to explicitly documented compatible integrated heads.

A scenario cannot be substituted by:

- hosted unit tests;
- browser automation with synthetic QR strings;
- an emulator;
- a screenshot of a QR code;
- a File QR UI “complete” message without received-file hash equality;
- an operator statement without the machine-verifiable hashes required by that scenario.

## 25. Promotion boundary

Closing #50 only proves the recorded physical matrix.

It does not automatically authorize:

- defaulting sender mode to FQR2;
- raising file-size limits;
- publishing universal throughput/range claims;
- calling SHA-256 sender authentication;
- bypassing signing/release or branch-protection gates.

Any such promotion is a separate decision with its own evidence and design requirements.

## 26. Scope guard

The evidence-kit implementation PR is expected to touch only evidence model/scripts/tests/docs and the smallest required refactor of the existing Android evidence collector.

It must not touch:

- `packages/core/optical.js`;
- FQR2 encoder/decoder/session behavior;
- signaling service code;
- TURN bootstrap/evidence code;
- native production signing/release workflow logic;
- dependency graph unless an independently justified need appears;
- package version;
- repository branch/ruleset configuration.

If implementation requires any of those, stop and re-open architecture review rather than expanding scope silently.

## 27. Design decision summary

The selected architecture is a **Trusted Physical Ceremony Kit**, not an automated pre-merge hardware runner.

Its central properties are:

- trusted-main control code;
- exact independent binary and payload hashing;
- machine evidence separated from human physical observations;
- deterministic fail-closed validation;
- no camera imagery capture;
- no PR code execution on self-hosted physical infrastructure;
- no transfer-protocol changes;
- physical evidence obtained only after protected-main integration;
- explicit distinction between recorded physical observations and stronger claims the data cannot support.

This provides substantially stronger evidence than a checklist while preserving the repository's existing trust boundaries.
