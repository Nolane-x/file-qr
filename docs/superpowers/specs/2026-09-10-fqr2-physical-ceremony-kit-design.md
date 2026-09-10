# FQR2 Physical Ceremony Kit — Design Specification

Date: 2026-09-10
Status: design for review
Tracks: #50
Related: #15, #17, #48, #49

## 1. Purpose

This specification defines a trusted, privacy-preserving physical evidence kit for QR Stream v0.2 / FQR2.

The kit exists to answer a narrow question that hosted tests cannot answer:

> Did one exact integrated File QR build transfer exact file bytes through a real display-to-camera path on physical Windows/Android hardware under a recorded ceremony, and did the received bytes equal the source bytes?

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

## 3. Selected architecture

The selected design is a **Trusted Physical Ceremony Kit**, not an automated pre-merge hardware runner.

Version 1 uses trusted-main control code, exact artifact and payload hashing, small platform collectors, explicit human physical observations, a fail-closed pure validator, and a deterministic matrix-summary validator.

The physical ceremony itself is local/manual. Hosted CI validates the evidence machinery but never pretends to be a physical optical test.

## 4. Goals

Version 1 must:

1. bind every authoritative ceremony to exact trusted control code and one exact integrated `Native Builds` run on `main`;
2. bind both Windows and Android artifacts from that same run and commit;
3. independently hash the actual Windows and Android binaries used by the operator;
4. generate only privacy-safe test payloads and record source SHA-256 before transfer;
5. record physical transfer direction and sanitized platform/device class without camera imagery or raw device identifiers;
6. distinguish machine-verifiable evidence from human physical observations;
7. require independently computed received-file SHA-256 equality before a transfer can pass;
8. cover the Issue #50 matrix: Windows -> Android, Android -> Windows, FQR1 compatibility, FQR2 mid-cycle join, repair-phase receive, >8 MiB persistent-storage receive, and interruption/resume;
9. fail closed on malformed, incomplete, contradictory, stale, or wrong-build evidence;
10. produce deterministic sanitized JSON suitable for issue attachment or archival;
11. validate the complete set of ceremony records so #50 closure is not a manual “looks complete” judgment;
12. reuse the existing Android physical-device collector where useful;
13. keep FQR1/FQR2 application behavior unchanged.

## 5. Non-goals

Version 1 does not:

- make FQR2 the default sender mode;
- raise the 64 MiB FQR2 admission cap;
- change the QR/FEC schedule;
- add test-only telemetry to the transfer protocol;
- claim universal camera compatibility, distance, or throughput;
- sign binaries or replace PR #9 publisher proof;
- configure branch protection or rulesets;
- capture screenshots, camera frames, screen recordings, audio, serial numbers, Wi-Fi identifiers, or personal files;
- run pull-request code on repository self-hosted physical runners;
- treat synthetic QR decoding, a virtual camera, emulator, prerecorded video, or screenshots as physical evidence;
- infer a physical fact that the tooling cannot machine-prove;
- make release assets an authoritative #50 source in v1;
- prove GitHub branch protection from inside an offline JSON validator.

## 6. Trust model

### 6.1 Trusted control code

The ceremony controller, validator, schema, and helper scripts become authoritative only after they exist on trusted `main` after Issue #15 is closed.

Evidence produced by control scripts from an unmerged PR checkout is useful for development only and cannot close #50.

### 6.2 Tested build is a subject, not an authority

The File QR applications under test never declare their own authoritative PASS.

The controller independently hashes the binaries before installation/execution. Final received bytes are independently hashed by the finalizer.

### 6.3 Authoritative build source

For v1, an authoritative #50 ceremony accepts only a GitHub Actions **Native Builds** run satisfying all of:

- repository is exactly `Nolane-x/file-qr`;
- workflow is the repository's trusted Native Builds workflow;
- run head branch is `main`;
- run event is a trusted main integration event, not `pull_request`;
- run head SHA is recorded as the ceremony build commit;
- the Windows and Android artifacts both belong to that same run;
- their GitHub artifact IDs/names/digests are recorded;
- local extracted binaries are independently SHA-256 hashed before use.

PR artifacts may be used for informal debugging on operator-controlled hardware, but the validator marks that evidence non-authoritative and it cannot satisfy #50 closure.

### 6.4 Repository governance is an external prerequisite

The kit does **not** claim it can cryptographically prove branch protection from an offline evidence file.

Issue #15 remains a separate repository-administration prerequisite. The intended closure ordering is:

1. protect `main` and close #15;
2. integrate the generic ceremony kit through protected main;
3. integrate FQR2 as experimental through protected main after its hosted gates remain green;
4. obtain the exact integrated Native Builds run;
5. run physical ceremonies against its exact artifacts;
6. validate and record the #50 evidence set;
7. only then consider a separately designed default/promotion decision.

The pure validator proves record consistency and main-build provenance. Repository governance evidence proves whether that main boundary was protected. Neither substitutes for the other.

### 6.5 No self-hosted PR execution shortcut

The repository's existing Android physical workflow is deliberately manual-only, main-only, self-hosted, and checks out trusted main.

The FQR2 ceremony kit must not add a workflow that checks out PR #49 or executes arbitrary PR code on that existing self-hosted runner merely to obtain pre-merge evidence.

A future disposable, secretless, dedicated hardware lab is a separate architecture problem.

## 7. Evidence strength model

Every recorded fact belongs to one of three classes.

### 7.1 Machine-verified facts

Examples:

- trusted control commit SHA;
- Native Builds run ID, head branch, event, and head SHA resolved from GitHub metadata;
- Windows/Android artifact IDs, names, and GitHub digests;
- independently computed local binary SHA-256 values;
- source payload size and SHA-256;
- received payload size and SHA-256;
- exact source/received equality;
- Android emulator rejection and sanitized physical-device facts;
- scenario/schema consistency;
- timestamps and deterministic ceremony identifier;
- whether payload size is above the FQR2 8 MiB fallback threshold.

### 7.2 Human-observed physical facts

Facts that cannot be safely machine-proved without intrusive capture or protocol instrumentation remain explicit operator observations:

- sender display was physically visible to receiver camera;
- no virtual camera or prerecorded media was used;
- receiver scanning began after broadcast had already started;
- sender UI had advanced to a later cycle before a repair-phase receive began;
- frames were intentionally obscured or missed;
- a physical interruption/restart was performed;
- resumed progress was observed;
- Windows receiver used the intended physical webcam.

These fields live only under `operatorObservations` and are never relabeled as machine proof.

### 7.3 Derived validator assertions

The validator derives claims such as:

- `buildBindingComplete`;
- `exactBytesMatch`;
- `privacyContractComplete`;
- `midCycleJoinClaimComplete`;
- `repairPhaseClaimComplete`;
- `largeFileClaimComplete`;
- `resumeClaimComplete`;
- per-record `result: PASS | FAIL`;
- evidence-set `matrixComplete`.

The operator cannot directly set derived PASS assertions.

## 8. Component architecture

Version 1 has five small components.

### 8.1 Pure evidence model and validator

A pure Node module owns:

- exact schemas and allowed keys;
- canonical normalization;
- SHA/digest/identifier validation;
- scenario-specific requirements;
- cross-field consistency;
- privacy rules;
- PASS/FAIL derivation;
- evidence-set matrix validation.

It performs no camera access, UI automation, network mutation, or GitHub write.

### 8.2 Build-binding resolver

Preparation resolves the exact Native Builds run and artifact metadata through read-only GitHub metadata.

For authoritative mode it refuses:

- PR-only runs;
- non-main head branches;
- wrong repository/workflow;
- missing Windows or Android artifact;
- artifact metadata that cannot be bound to the chosen run.

If required GitHub metadata cannot be resolved, authoritative preparation fails. There is no operator checkbox that bypasses build provenance.

### 8.3 Preparation CLI

A trusted-main CLI creates one ceremony workspace and immutable preparation manifest.

Inputs include:

- scenario;
- Native Builds run ID;
- local Windows artifact/binary path;
- local Android artifact/binary path;
- requested payload size.

The preparation CLI:

1. resolves the main-run metadata;
2. verifies both artifact identities belong to the run;
3. independently hashes both local tested binaries;
4. creates a privacy-safe generated payload;
5. records source SHA-256 and byte length;
6. derives a deterministic ceremony ID;
7. writes an immutable preparation manifest without a PASS result;
8. prints scenario-specific physical instructions.

### 8.4 Platform collectors

Android v1 reuses/refactors the current collector primitives for:

- exactly one authorized ADB device;
- emulator rejection;
- package identity/version;
- CAMERA permission;
- sanitized device class;
- optional camera-service ownership check where the scenario uses Android as receiver;
- explicit `cameraImageryCaptured: false`.

Windows v1 records only non-sensitive platform facts and, where stable APIs permit, physical camera-device presence. It does not capture camera frames. The stronger claim that the actual transfer used a physical webcam remains an operator observation plus exact output equality.

### 8.5 Finalization and matrix-summary CLI

Per ceremony, finalization:

1. loads the immutable preparation manifest;
2. independently hashes the received file;
3. imports sanitized collector facts;
4. records structured operator observations;
5. invokes the pure validator;
6. writes final evidence JSON only from normalized data;
7. exits non-zero on FAIL.

A separate summary mode consumes multiple accepted evidence records and computes whether the mandatory #50 matrix is complete for one integrated build lineage.

The summary cannot convert a failed record into PASS and cannot combine incompatible build SHAs into one silent success.

## 9. Repository layout

Exact filenames may be refined by the implementation plan, but intended boundaries are:

- `packages/core/physical-evidence.js` — pure schema/normalization/per-record + matrix validation;
- `scripts/prepare-optical-physical-evidence.mjs` — run/artifact binding + payload preparation;
- `scripts/finalize-optical-physical-evidence.mjs` — received-file hashing + final validation;
- `scripts/summarize-optical-physical-evidence.mjs` — #50 matrix aggregation;
- `scripts/collect-android-physical-evidence.mjs` — reuse/refactor only where necessary;
- optional `scripts/collect-windows-physical-evidence.mjs` — sanitized Windows facts only;
- `tests/core/physical-evidence.test.mjs`;
- `tests/structure/physical-evidence-kit.test.mjs`;
- `docs/physical-evidence/FQR2-CEREMONY.md` — operator instructions added with implementation.

Version 1 does not require a new self-hosted workflow.

## 10. Evidence schema v1

A final record conceptually has this shape:

```json
{
  "schemaVersion": 1,
  "ceremonyId": "<deterministic-id>",
  "scenario": "fqr2-windows-to-android",
  "control": {
    "repository": "Nolane-x/file-qr",
    "commitSha": "<40-hex>"
  },
  "build": {
    "repository": "Nolane-x/file-qr",
    "workflow": "Native Builds",
    "workflowRunId": 123456,
    "event": "push",
    "headBranch": "main",
    "commitSha": "<40-hex>",
    "artifacts": {
      "windows": {
        "artifactId": 1,
        "name": "file-qr-windows",
        "artifactDigest": "sha256:<64-hex>",
        "binarySha256": "<64-hex>"
      },
      "android": {
        "artifactId": 2,
        "name": "file-qr-android",
        "artifactDigest": "sha256:<64-hex>",
        "binarySha256": "<64-hex>"
      }
    }
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
    "platform": "windows",
    "osClass": "...",
    "deviceClass": "..."
  },
  "receiver": {
    "platform": "android",
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
    "startedAt": "2026-09-10T00:00:00.000Z",
    "completedAt": "2026-09-10T00:01:00.000Z",
    "wallClockMs": 60000,
    "observedCycles": null
  },
  "privacy": {
    "cameraImageryCaptured": false,
    "personalPayloadUsed": false,
    "rawDeviceSerialStored": false
  },
  "assertions": {
    "buildBindingComplete": true,
    "exactBytesMatch": true,
    "privacyContractComplete": true
  },
  "result": "PASS"
}
```

This is conceptual. Implementation defines an exact allowed-key schema and rejects unknown security-relevant fields instead of ignoring them.

## 11. Immutable preparation manifest

Preparation writes the authority-bearing immutable subset before any physical transfer:

- schema version;
- scenario;
- control repository/SHA;
- build run metadata;
- both artifact identities/digests/binary hashes;
- source payload size/hash;
- protocol geometry;
- ceremony ID;
- start timestamp.

Finalization may add only:

- receiver/sender sanitized platform observations;
- operator observations;
- received-file size/hash;
- completion timestamp/measurements;
- derived assertions/result.

Finalization must reject attempts to alter authority-bearing preparation fields.

## 12. Ceremony identifier

`ceremonyId` is an identifier, not authentication.

Its derivation is deterministic from canonical non-secret preparation inputs, including:

- schema version;
- control commit SHA;
- build commit SHA;
- Native Builds run ID;
- scenario;
- Windows binary SHA-256;
- Android binary SHA-256;
- source payload SHA-256;
- preparation start timestamp.

Implementation tests must lock a known vector so host endianness or field-order changes cannot silently change identifiers.

## 13. Build and artifact binding

An authoritative record cannot pass unless:

- run metadata resolves to `Nolane-x/file-qr`;
- workflow identity is Native Builds;
- `headBranch === "main"`;
- event is the allowed trusted-main integration event;
- `build.commitSha` exactly equals run head SHA;
- Windows and Android artifact IDs both belong to that run;
- expected artifact names match;
- artifact digests are valid and match resolved metadata;
- local tested binaries exist and are independently hashed;
- both binaries are bound into the immutable preparation manifest.

The GitHub artifact digest and the extracted binary SHA-256 are distinct facts and must not be conflated.

Branch-protection state is not encoded as a fake assertion here; #15 must be independently closed before these records are accepted as repository-authoritative closure evidence.

## 14. Payload rules

### 14.1 Generated payloads only

Authoritative v1 ceremonies generate privacy-safe payloads. Arbitrary personal files are not accepted for closure evidence.

The generator records exact byte size, source SHA-256, and generator/schema version.

Payload bytes need not be reproducible from public metadata and no predictable PRNG is required.

### 14.2 Received bytes

The File QR UI “complete” state is insufficient.

Finalization independently computes:

- received byte length;
- received SHA-256.

Exact length and SHA-256 equality are mandatory for PASS.

No source/received file bytes are stored in evidence JSON.

## 15. Required scenario matrix

Each scenario creates an independent final record. Matrix completion is computed over records, not typed manually.

### 15.1 FQR2 Windows sender -> Android camera receiver

Requires:

- FQR2;
- Windows sender and Android receiver direction;
- Android physical-device collector success;
- physical display-to-camera operator observation;
- no virtual camera/prerecorded-media observation;
- exact received-byte equality.

### 15.2 FQR2 Android sender -> Windows webcam receiver

Requires:

- FQR2;
- Android sender and Windows receiver direction;
- physical webcam operator observation;
- no virtual camera/prerecorded-media observation;
- exact received-byte equality.

### 15.3 FQR1 compatibility

At least one physical receive ceremony for each receiver platform class must retain FQR1 evidence.

FQR1 evidence is never used to infer FQR2 behavior.

### 15.4 FQR2 mid-cycle join

Requires an explicit operator observation that receiver scanning began after broadcast was already active and not at initial frame zero, plus exact-byte completion.

If exact cycle number was not reliably observed, the record must not invent one.

### 15.5 FQR2 repair-phase receive

The v1 ceremony uses a single-block payload (`<= 65536` bytes) so the block identity stays fixed while the sender advances beyond the initial systematic cycle.

The operator begins receiver scanning only after the sender UI visibly reports a later cycle. Successful exact-byte completion then records a physical receive during repair-phase broadcast rather than relying only on the initial systematic cycle.

This is explicitly **not** cryptographic proof of which individual fountain equation solved the block. The evidence language must remain at the level actually observed.

### 15.6 FQR2 >8 MiB persistent-storage receive

Requires:

- FQR2;
- payload strictly greater than 8 MiB;
- receiver platform capable of the implementation's persistent random-access storage path;
- exact-byte completion.

Because the integrated FQR2 implementation refuses >8 MiB whole-file memory fallback, successful exact-byte completion is evidence consistent with the persistent path. The ceremony must not claim direct OPFS internals unless future instrumentation proves them.

### 15.7 FQR2 interruption/resume

Requires:

- intentional interruption after at least one durable block is visible to the operator;
- same source payload after restart;
- explicit interruption and resumed-progress observations;
- exact received SHA-256 after completion.

The record does not claim internal sidecar write ordering from observation alone; that ordering remains covered by code tests.

## 16. Matrix-summary rules

The summary validator consumes final PASS records and verifies:

- all mandatory scenario categories are represented;
- records use the same build commit and Native Builds run unless an explicitly documented compatible integrated-head transition is supplied and separately approved;
- Windows/Android artifact hashes are consistent across records using the same run;
- no required record is informational/non-authoritative;
- no failed record is counted toward coverage;
- FQR1 compatibility exists for both receiver platform classes;
- FQR2 directionality exists both ways;
- mid-cycle, repair-phase, >8 MiB, and interruption/resume evidence are each present;
- privacy requirements pass for every included record.

The output is a deterministic summary with `matrixComplete: true | false` and explicit missing categories.

## 17. Timing and performance boundary

`wallClockMs` and observed cycle counts are observations only.

The schema contains no field for “guaranteed throughput”, “maximum range”, or “universal compatibility”. The validator rejects evidence metadata that tries to encode such unsupported product claims as ceremony assertions.

## 18. Privacy requirements

Every authoritative record must satisfy:

- `cameraImageryCaptured === false`;
- `personalPayloadUsed === false`;
- no raw Android serial;
- no raw Android build fingerprint where hashed representation is sufficient;
- no MAC, IP, SSID, Bluetooth ID, account token, or credential;
- no user-home path in archived JSON;
- no environment-variable dump;
- no source/received payload bytes;
- no screenshot/video/audio evidence requirement.

Local paths may be used transiently by CLI execution but are omitted or basename-normalized in final evidence.

## 19. Failure policy

The kit fails closed on:

- unknown schema version or scenario;
- unknown security-relevant keys;
- missing required fields;
- invalid SHA/digest syntax;
- wrong repository/workflow/run source;
- PR-only/non-main build used in authoritative mode;
- missing or inconsistent Windows/Android artifact bindings;
- immutable preparation-field mutation;
- source/received size mismatch;
- source/received SHA mismatch;
- contradictory sender/receiver direction;
- Android emulator/virtual-device evidence;
- missing required operator observation for a scenario;
- privacy contract violation;
- impossible timestamp ordering;
- incompatible records in one matrix summary.

A failed finalization exits non-zero and must not write a record whose `result` is PASS.

## 20. Canonicalization and evidence mutation

Canonical JSON uses stable field ordering and normalized scalar formats so evidence diffs are reviewable.

Preparation manifests are immutable except for designated finalization fields. The finalizer must never silently replace:

- control SHA;
- build run ID/SHA;
- artifact IDs/digests/binary hashes;
- source payload hash/size;
- scenario;
- protocol version/geometry;
- ceremony ID.

The JSON itself is not a digital signature. Cryptographic evidence signing, if desired later, requires separate design.

## 21. Existing Android collector integration

The current Android collector already provides useful trusted primitives:

- authorized-device enumeration;
- emulator rejection through Android properties;
- installed package checks;
- CAMERA permission check;
- camera service ownership observation;
- sanitized device serial/build fingerprint hashes;
- explicit no-camera-imagery evidence.

The implementation should reuse/refactor these primitives or normalized output rather than duplicate them.

It must not regress Issue #17 behavior or weaken the current main-only Android physical workflow.

## 22. Windows evidence boundary

Windows v1 intentionally avoids covert camera capture.

A collector may record non-sensitive OS/runtime/device-class facts and physical camera-device presence where stable system APIs permit. It may not capture frames.

The statement that the File QR receive path used a physical webcam is based on the human physical ceremony plus exact output equality, not hidden surveillance.

## 23. Hosted test strategy

Hosted CI proves the kit, not physical optics.

Required pure/unit tests include:

- exact schema acceptance;
- unknown-key rejection;
- invalid SHA/digest rejection;
- deterministic ceremony-ID vector;
- run/build/artifact consistency;
- non-main or PR-only build rejection in authoritative mode;
- two-artifact same-run binding;
- immutable preparation mutation rejection;
- source/received size mismatch;
- source/received SHA mismatch;
- impossible timestamp ordering;
- each scenario's required observation matrix;
- strict `> 8 MiB` threshold boundary;
- FQR1/FQR2 scenario separation;
- privacy violation rejection;
- raw serial/path leakage rejection;
- canonical normalization stability;
- matrix-complete success;
- matrix missing-category failure;
- matrix mixed-build failure.

Required structural tests include:

- no physical self-hosted workflow gains `pull_request` or `push` trigger;
- existing Android physical workflow remains main-only and checks out main;
- no screenshots/screencap/screenrecord/video capture introduced;
- no production secrets required by validator/preparation/finalization;
- no FQR1/FQR2 encoder/decoder/session behavior changed;
- no signaling/TURN/release/signing code changed;
- package version unchanged;
- no dependency graph change unless architecture is reopened and approved.

## 24. TDD lineage requirement

After this written spec is approved:

1. write the implementation plan;
2. create an isolated implementation branch;
3. add pure validator and structural tests before production kit implementation;
4. preserve a hosted RED commit whose failures correspond only to absent/new evidence-kit contracts;
5. implement schema/validator/build-binding in minimal GREEN slices;
6. add preparation/finalization/matrix-summary CLI slices separately;
7. integrate Android collector behavior without weakening #17;
8. add Windows sanitized collector only if it can remain stable and non-invasive;
9. run all normal repository hosted gates on the exact final head;
10. audit changed-file scope;
11. keep the PR unmerged while #15 remains open.

Physical hardware is not required to make evidence-kit code tests GREEN. It is required to close #50.

## 25. Physical ceremony execution after integration

After #15 closes and both the kit and FQR2 are integrated through protected main:

1. select one exact trusted-main Native Builds run;
2. obtain both exact Windows and Android artifacts from that run;
3. run preparation using their artifact metadata and local binaries;
4. install/open those exact binaries on physical devices;
5. perform one scenario's physical instructions;
6. save the received file;
7. run finalization against that file;
8. repeat for the remaining scenario matrix;
9. run matrix-summary over all accepted records;
10. attach sanitized records + matrix summary to #50.

No step requires camera imagery.

## 26. Issue #50 closure rule

Issue #50 may close only when:

- #15 is independently closed with real repository protection evidence;
- mandatory physical records validate PASS;
- the matrix summary reports complete;
- evidence is bound to exact integrated main build artifacts;
- source/received hashes match in every transfer record;
- all evidence preserves the privacy contract.

None of the following can substitute:

- hosted unit tests;
- synthetic QR strings;
- emulator/virtual camera;
- screenshots of QR codes;
- File QR UI “complete” without independent received hash;
- PR artifact evidence presented as authoritative closure;
- a human checklist without required machine hashes.

## 27. Promotion boundary

Closing #50 proves only the recorded physical matrix.

It does not automatically authorize:

- defaulting sender mode to FQR2;
- raising FQR2 size limits;
- claiming universal throughput/range/camera compatibility;
- describing SHA-256 as sender authentication;
- bypassing publisher signing/release gates.

Promotion is a separate evidence/design decision.

## 28. Scope guard

The future evidence-kit implementation PR should touch only evidence model/scripts/tests/docs and the smallest justified reuse/refactor of the existing Android evidence collector.

It must not touch:

- `packages/core/optical.js`;
- FQR2 encoder/decoder/session behavior;
- signaling services;
- TURN bootstrap/evidence machinery;
- native production signing/release workflow logic;
- package version;
- repository branch/ruleset settings.

If implementation requires any of those, stop and reopen architecture review instead of expanding scope silently.

## 29. Final design decision

The Trusted Physical Ceremony Kit is deliberately less automated than a full hardware lab because the current repository trust model matters more than convenience.

Its core guarantees are:

- control code comes from trusted protected main;
- one authoritative Native Builds run binds both platform artifacts;
- actual local binaries and transferred payloads are independently hashed;
- machine evidence is never confused with operator observation;
- PASS is derived by separate fail-closed validation;
- a matrix validator proves scenario coverage;
- no camera imagery is captured;
- PR code is not executed on repository self-hosted physical runners;
- transfer protocol behavior remains untouched;
- governance (#15), physical evidence (#50), and publisher proof (#9) remain separate authorities.

This yields evidence materially stronger than a checklist without weakening the trust boundaries File QR has already established.
