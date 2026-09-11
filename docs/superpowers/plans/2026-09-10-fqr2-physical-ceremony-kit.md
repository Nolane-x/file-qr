# FQR2 Physical Ceremony Kit Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a fail-closed, privacy-preserving physical-evidence kit that binds exact trusted-main Native Builds artifacts, independently hashes transferred payloads, records sanitized physical-platform facts, validates each ceremony deterministically, and proves Issue #50 matrix coverage without changing File QR transfer behavior.

**Architecture:** Keep evidence logic separate from File QR protocol/runtime. A pure `packages/core/physical-evidence.js` owns schemas, canonicalization, ceremony-ID derivation, per-record validation, and matrix validation. Thin Node CLIs handle GitHub read-only provenance resolution, payload preparation, received-file hashing, platform fact collection, and summary generation. Existing Android physical evidence code is refactored only to expose reusable device facts while preserving Issue #17 behavior. No new self-hosted workflow is added.

**Tech Stack:** Node.js ESM, built-in `node:test`, `node:assert/strict`, `node:crypto`, `node:fs`, `node:path`, `node:child_process`; GitHub REST metadata via `gh api` from preparation CLI; ADB for Android collector; PowerShell `Get-PnpDevice -Class Camera` for Windows collector. No new npm dependencies.

**Spec:** `docs/superpowers/specs/2026-09-10-fqr2-physical-ceremony-kit-design.md`

## Global Constraints

- Package version remains exactly `0.4.0`.
- No dependency or package-lock changes.
- No FQR1/FQR2 encoder, decoder, session, signaling, TURN, signing, release, or deployment behavior changes.
- No new self-hosted workflow; existing Android physical workflow stays manual-only, main-only, and checks out `main`.
- Authoritative evidence accepts only one `Native Builds` run from repository `Nolane-x/file-qr`, `head_branch=main`, trusted main integration event, with both Windows and Android artifacts from that same run.
- PR artifacts can be represented only as non-authoritative development evidence and cannot satisfy Issue #50 matrix closure.
- Source and received payload bytes are never embedded in evidence JSON.
- Authoritative payloads are generated privacy-safe bytes only; personal payload evidence fails closed.
- No camera frames, screenshots, screencaps, screen recordings, audio, raw Android serials, raw build fingerprints, PnP instance IDs, camera device names, IP/MAC/SSID/Bluetooth IDs, credentials, environment dumps, or user-home paths are stored in final evidence.
- Android receiver ceremonies require a real physical ADB device, emulator rejection, CAMERA permission, and File QR camera-service ownership.
- Windows receiver ceremonies require a successful PowerShell camera PnP query with at least one camera device; only boolean/count may be retained.
- Exact source/received byte length and SHA-256 equality are mandatory for PASS.
- `wallClockMs` and observed cycles are observations only, never throughput/range claims.
- Matrix completion must cover both FQR2 directions, FQR1 compatibility on both receiver classes, FQR2 mid-cycle join, repair-phase receive, >8 MiB persistent-storage receive, and interruption/resume.
- Implementation and hosted GREEN do not close #50; physical hardware evidence remains required after #15/protected-main integration.

---

## File Structure

- Create `packages/core/physical-evidence.js` — exact schemas, canonicalization, ceremony-ID derivation, per-record validator, matrix validator.
- Create `scripts/physical-evidence-github.mjs` — read-only Native Builds run/artifact resolver; injectable command runner for tests.
- Create `scripts/prepare-optical-physical-evidence.mjs` — preparation CLI and generated-payload workspace creation.
- Create `scripts/finalize-optical-physical-evidence.mjs` — immutable-manifest verification, received-file hashing, final record generation.
- Create `scripts/summarize-optical-physical-evidence.mjs` — deterministic matrix summary CLI.
- Modify `scripts/collect-android-physical-evidence.mjs` — extract reusable `collectAndroidDeviceFacts()` while preserving `collectPhysicalAndroidEvidence()` public behavior.
- Create `scripts/collect-windows-physical-evidence.mjs` — sanitized Windows/PnP collector.
- Create `tests/core/physical-evidence.test.mjs` — pure validator/canonicalization/matrix tests.
- Create `tests/core/physical-evidence-github.test.mjs` — build/artifact resolver tests with injected `gh` responses.
- Create `tests/core/physical-evidence-cli.test.mjs` — prepare/finalize/summary tests using temporary files.
- Modify `tests/core/android-physical-evidence.test.mjs` — reusable Android fact collector tests while retaining current ceremony assertions.
- Create `tests/core/windows-physical-evidence.test.mjs` — PowerShell parsing/fail-closed collector tests.
- Create `tests/structure/physical-evidence-kit.test.mjs` — trust/privacy/scope invariants.
- Create `docs/physical-evidence/FQR2-CEREMONY.md` — operator procedure and claim boundaries.

---

### Task 1: Pure evidence schema, canonicalization, ceremony ID, and per-record validator

**Files:**
- Create: `packages/core/physical-evidence.js`
- Create: `tests/core/physical-evidence.test.mjs`

**Interfaces:**
- Produces: `SCHEMA_VERSION`, `SCENARIOS`, `canonicalizePreparation(input)`, `deriveCeremonyId(preparation)`, `validatePreparation(input, { authoritative })`, `finalizeEvidence(preparation, completion, { authoritative })`, `validateFinalRecord(record, { authoritative })`, `summarizeEvidenceMatrix(records)`.
- All validators return normalized objects on success and throw `Error` with stable `FQR_EVIDENCE_*` code prefixes on failure.

- [ ] **Step 1: Write failing schema and canonicalization tests**

Create tests that import the absent module and exercise an exact valid preparation fixture containing schema version, scenario, control SHA, one main Native Builds run, both artifact records, generated payload hash/size, protocol geometry, and start timestamp. Assert unknown top-level and nested keys throw, invalid SHA/digest strings throw, and canonicalization preserves a fixed key order independent of input property order.

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  canonicalizePreparation,
  deriveCeremonyId,
  validatePreparation,
  finalizeEvidence,
  summarizeEvidenceMatrix,
} from '../../packages/core/physical-evidence.js';

const SHA_A = 'a'.repeat(40);
const H1 = '1'.repeat(64);
const H2 = '2'.repeat(64);
const H3 = '3'.repeat(64);

function validPreparation(overrides = {}) {
  return {
    schemaVersion: 1,
    scenario: 'fqr2-windows-to-android',
    control: { repository: 'Nolane-x/file-qr', commitSha: SHA_A },
    build: {
      repository: 'Nolane-x/file-qr', workflow: 'Native Builds', workflowRunId: 123,
      event: 'push', headBranch: 'main', commitSha: SHA_A,
      artifacts: {
        windows: { artifactId: 10, name: 'file-qr-windows', artifactDigest: `sha256:${H1}`, binarySha256: H2 },
        android: { artifactId: 11, name: 'file-qr-android', artifactDigest: `sha256:${H2}`, binarySha256: H3 },
      },
    },
    payload: { generated: true, generatorVersion: 1, bytes: 65536, sourceSha256: H1 },
    protocol: { version: 'FQR2', blockBytes: 65536, symbolBytes: 768 },
    startedAt: '2026-09-10T12:00:00.000Z',
    ...overrides,
  };
}

test('preparation rejects unknown security-relevant keys', () => {
  assert.throws(() => validatePreparation({ ...validPreparation(), bypass: true }, { authoritative: true }), /FQR_EVIDENCE_UNKNOWN_KEY/);
});
```

- [ ] **Step 2: Add fixed ceremony-ID vector before production implementation**

Use a hand-constructed canonical string in the test and compute the expected SHA-256 once with Node's standard crypto helper inside the test setup only, then hard-code the resulting expected 24-hex identifier in a second assertion before implementing production derivation. The production function must not be used to generate its expected value.

- [ ] **Step 3: Run focused tests and preserve hosted RED**

Run: `node --test tests/core/physical-evidence.test.mjs`

Expected: module import failure because `packages/core/physical-evidence.js` does not exist. Commit the test-only RED before any production evidence-kit module is added.

- [ ] **Step 4: Implement exact schema helpers and canonicalization**

Implement explicit allowed-key sets, strict scalar validation, deep object reconstruction into canonical order, valid scenario enum, 40-lowercase-hex commit SHA, 64-lowercase-hex hashes, `sha256:<64hex>` artifact digests, finite positive integer run/artifact IDs, ISO timestamps, exact repository/workflow names, and FQR1/FQR2 geometry rules.

- [ ] **Step 5: Implement deterministic ceremony ID**

Build a UTF-8 canonical identity string containing `schemaVersion`, control SHA, build SHA, workflow run ID, scenario, Windows binary SHA, Android binary SHA, source payload SHA, and start timestamp separated by `\n`. Return the first 24 lowercase hex characters of SHA-256. Treat it as identifier only.

- [ ] **Step 6: Implement per-record finalization and fail-closed scenario assertions**

`finalizeEvidence()` must reconstruct authority-bearing fields from the validated preparation object, never from completion input. It accepts only sender/receiver sanitized facts, structured operator observations, received size/hash, completion timestamp, and observed cycle count. It derives exact-byte equality, hardware prerequisites, privacy checks, scenario-specific assertions, and `result`.

Required rules include:
- FQR2 Windows->Android: Android receiver + camera ownership + physical path + virtual media absent + exact bytes.
- FQR2 Android->Windows: Windows receiver + camera present + physical webcam/path observation + virtual media absent + exact bytes.
- FQR1 receiver records must match declared receiver platform and its hardware prerequisite.
- mid-cycle requires FQR2 + `joinedMidCycle=true`.
- repair-phase requires FQR2 + payload `<=65536` + `repairPhaseOnlyStart=true`.
- large-file requires FQR2 + payload `>8*1024*1024`.
- resume requires FQR2 + `interruptionPerformed=true` + `resumeObserved=true`.
- all PASS records require privacy booleans false for prohibited data and exact bytes.

- [ ] **Step 7: Test immutable authority and failure boundaries**

Add cases for altered preparation control/build/artifact/payload/scenario/geometry fields, hash/size mismatch, timestamps completed-before-started, Android emulator flag, Android receiver without camera owner, Windows receiver with zero camera devices, personal payload, raw serial/PnP/path leakage, and unsupported throughput/range assertion fields.

- [ ] **Step 8: Run focused GREEN and commit**

Run: `node --test tests/core/physical-evidence.test.mjs`

Expected: all Task 1 tests PASS.

Commit: `feat: add physical evidence validation core`

---

### Task 2: Read-only Native Builds provenance resolver and preparation CLI

**Files:**
- Create: `scripts/physical-evidence-github.mjs`
- Create: `scripts/prepare-optical-physical-evidence.mjs`
- Create: `tests/core/physical-evidence-github.test.mjs`
- Extend: `tests/core/physical-evidence-cli.test.mjs`

**Interfaces:**
- Produces `resolveNativeBuild({ runId, execGh }) -> { repository, workflow, workflowRunId, event, headBranch, commitSha, artifacts }`.
- Produces `prepareCeremony({ scenario, runId, windowsBinaryPath, androidBinaryPath, payloadBytes, workspace, execGh, now }) -> preparation`.

- [ ] **Step 1: Write resolver RED tests with injected GitHub responses**

Mock `execGh(args)` to return JSON for `/repos/Nolane-x/file-qr/actions/runs/<id>` and `/repos/Nolane-x/file-qr/actions/runs/<id>/artifacts`. Test exact acceptance only when workflow name is `Native Builds`, repository matches, `head_branch=main`, event is `push`, and exactly one expected Windows and one expected Android artifact are present with valid IDs/digests.

Reject pull_request runs, non-main branch, wrong workflow/repo, expired/missing artifacts, duplicate expected artifact names, invalid digest, and artifact/run mismatch.

- [ ] **Step 2: Run focused RED**

Run: `node --test tests/core/physical-evidence-github.test.mjs`

Expected: module import failure.

- [ ] **Step 3: Implement resolver as read-only `gh api` adapter**

Default `execGh` uses `spawnSync('gh', ['api', ...args])`; no GitHub write endpoint and no token logging. Parse only required fields and return a normalized object. Export the resolver for pure tests.

- [ ] **Step 4: Write preparation CLI RED tests**

Use temporary binaries with known bytes. Assert preparation independently hashes both binaries, generates a payload exactly requested size, hashes it, sets `generated=true`, writes `preparation.json` and `payload.bin` under a caller-supplied workspace, and never embeds binary/payload bytes in JSON.

Test payload-size policy: FQR2 accepts 1..64 MiB inclusive; FQR1 uses its existing evidence-only compatibility size limit chosen by scenario fixture. Reject personal/custom payload path in authoritative mode.

- [ ] **Step 5: Implement `prepareCeremony()` and CLI argument parsing**

Use `crypto.randomBytes()` streamed/chunked to file for generated payload rather than materializing very large buffers. Independently SHA-256 stream both binaries and payload. Validate the normalized preparation via Task 1 and derive ceremony ID before writing JSON.

CLI required args: `--scenario`, `--run-id`, `--windows-binary`, `--android-binary`, `--payload-bytes`, `--workspace`. Exit non-zero with stable error text on failure.

- [ ] **Step 6: Focused GREEN and commit**

Run: `node --test tests/core/physical-evidence-github.test.mjs tests/core/physical-evidence-cli.test.mjs`

Commit: `feat: bind physical ceremonies to main native builds`

---

### Task 3: Finalization CLI and immutable preparation enforcement

**Files:**
- Create: `scripts/finalize-optical-physical-evidence.mjs`
- Extend: `tests/core/physical-evidence-cli.test.mjs`

**Interfaces:**
- Produces `finalizeCeremony({ preparationPath, receivedPath, platformFactsPath, observationsPath, outputPath, now }) -> finalRecord`.

- [ ] **Step 1: Write failing finalization tests**

Build a temporary valid preparation fixture and received file. Assert exact hash/length yields PASS for the baseline scenario when platform facts/observations satisfy it; one-byte corruption yields non-zero failure and no PASS record; malformed JSON, unknown observation keys, authority-field mutation attempts, and completion timestamp before start all fail closed.

- [ ] **Step 2: Run focused RED**

Run: `node --test tests/core/physical-evidence-cli.test.mjs`

Expected: finalizer import/path failure only for new tests.

- [ ] **Step 3: Implement streaming received-file hashing and normalized completion input**

Read preparation JSON, validate it, hash received file with `createReadStream`, load only sanitized platform fact JSON and operator observation JSON, and pass completion data into `finalizeEvidence()`.

Never copy arbitrary extra keys from platform/observation files. Never include local absolute paths in output.

- [ ] **Step 4: Make output fail-safe**

Write final evidence to a temporary sibling file with mode `0o600`, fsync/close, then rename to requested output only after validation. On validation failure, delete temporary output and ensure no file with `result: PASS` is left behind.

- [ ] **Step 5: Focused GREEN and commit**

Run: `node --test tests/core/physical-evidence-cli.test.mjs`

Commit: `feat: finalize optical physical evidence fail closed`

---

### Task 4: Deterministic Issue #50 matrix summary

**Files:**
- Extend: `packages/core/physical-evidence.js`
- Create: `scripts/summarize-optical-physical-evidence.mjs`
- Extend: `tests/core/physical-evidence.test.mjs`
- Extend: `tests/core/physical-evidence-cli.test.mjs`

**Interfaces:**
- `summarizeEvidenceMatrix(records) -> { schemaVersion: 1, build: {...}, matrixComplete, covered, missing, recordIds }`.

- [ ] **Step 1: Write matrix RED tests**

Construct minimal valid PASS records sharing one run/commit/artifact set. Assert incomplete subsets list deterministic missing categories; a complete set covers FQR2 both directions, FQR1 receive on Android and Windows, mid-cycle, repair-phase, large-file, and resume. Reject FAILED records as coverage, mixed build SHA/run/artifact hashes, duplicate ceremony IDs with conflicting content, and non-authoritative records.

- [ ] **Step 2: Run focused RED**

Run: `node --test tests/core/physical-evidence.test.mjs`

Expected: new matrix assertions fail until implemented.

- [ ] **Step 3: Implement deterministic matrix aggregation**

Sort accepted records by ceremony ID. Bind one exact build lineage and both artifact hashes. Calculate booleans per mandatory category. Return `missing` in fixed enum order. `matrixComplete` is true only when missing is empty and every counted record validates authoritative PASS.

- [ ] **Step 4: Implement summary CLI**

Accept one or more evidence JSON file paths plus `--output`. Load/validate all, call summary, write canonical JSON. Exit non-zero when matrix incomplete; still write a truthful summary with `matrixComplete:false` and explicit missing categories.

- [ ] **Step 5: Focused GREEN and commit**

Run: `node --test tests/core/physical-evidence.test.mjs tests/core/physical-evidence-cli.test.mjs`

Commit: `feat: validate FQR2 physical evidence matrix`

---

### Task 5: Refactor Android collector for reusable physical-device facts without weakening Issue #17

**Files:**
- Modify: `scripts/collect-android-physical-evidence.mjs`
- Modify: `tests/core/android-physical-evidence.test.mjs`
- Verify unchanged: `.github/workflows/android-physical-evidence.yml`
- Verify: `tests/structure/android-physical-evidence.test.mjs`

**Interfaces:**
- Add `collectAndroidDeviceFacts({ apkPath, adbFn }) -> sanitizedFacts`.
- Preserve `collectPhysicalAndroidEvidence({ apkPath, evidencePath, adbFn, sleepFn })` signature and behavior.
- Add a receiver helper only if needed: `observeAndroidCameraOwner({ serial, packageName, adbFn, sleepFn })` returning boolean without imagery.

- [ ] **Step 1: Extend tests before refactor**

Assert `collectAndroidDeviceFacts()` rejects zero/multiple authorized devices and emulator hardware, independently hashes APK, checks package CAMERA permission after install/grant, and returns only sanitized manufacturer/model/Android release/SDK/hardware plus hashed serial/fingerprint. Assert raw serial/fingerprint are absent from returned object.

- [ ] **Step 2: Run RED**

Run: `node --test tests/core/android-physical-evidence.test.mjs tests/structure/android-physical-evidence.test.mjs`

Expected: missing exported helper; all pre-existing tests still pass except new helper contract.

- [ ] **Step 3: Extract helper with no behavior change to #17 collector**

Move discovery/emulator/package/permission logic into reusable helper. `collectPhysicalAndroidEvidence()` calls it, then performs its existing launch/UIAutomator/camera-owner/back/recovery ceremony and writes the same schema fields expected by existing tests/workflow.

- [ ] **Step 4: Prove #17 contract unchanged**

Run both core and structure Android evidence tests. Inspect `.github/workflows/android-physical-evidence.yml` diff and require no change.

- [ ] **Step 5: Commit**

Commit: `refactor: reuse sanitized Android physical device facts`

---

### Task 6: Windows collector, structural trust guards, operator documentation, and final verification

**Files:**
- Create: `scripts/collect-windows-physical-evidence.mjs`
- Create: `tests/core/windows-physical-evidence.test.mjs`
- Create: `tests/structure/physical-evidence-kit.test.mjs`
- Create: `docs/physical-evidence/FQR2-CEREMONY.md`

**Interfaces:**
- `collectWindowsDeviceFacts({ execPowerShell, platform = process.platform, arch = process.arch }) -> { platform:'windows', osClass, architecture, cameraDevicePresent, cameraDeviceCount }`.

- [ ] **Step 1: Write Windows collector RED tests**

Inject PowerShell output as JSON from a command equivalent to:

```powershell
$cams = @(Get-PnpDevice -Class Camera -ErrorAction Stop | Where-Object Status -eq 'OK')
[pscustomobject]@{ osVersion=[Environment]::OSVersion.Version.ToString(); cameraDeviceCount=$cams.Count } | ConvertTo-Json -Compress
```

Assert count >0 yields only sanitized boolean/count/version/arch. Assert command failure, invalid JSON, negative/non-integer count fail closed. No device name or instance ID may appear in returned data.

- [ ] **Step 2: Implement collector and focused GREEN**

Default adapter runs `powershell.exe -NoProfile -NonInteractive -Command <script>` and parses JSON. Reject non-Windows host in default CLI mode. CLI writes mode-`0o600` JSON and never stores raw PowerShell output.

Run: `node --test tests/core/windows-physical-evidence.test.mjs`

- [ ] **Step 3: Write structural trust/privacy RED tests**

Tests must assert:
- `.github/workflows/android-physical-evidence.yml` has `workflow_dispatch`, no `pull_request` or `push`, self-hosted labels, `if github.ref == refs/heads/main`, and checkout `ref: main`.
- no new physical-evidence workflow exists for PR execution.
- new scripts contain no `screencap`, `screenrecord`, screenshot/video/audio capture APIs.
- Windows collector does not persist PnP names/instance IDs.
- preparation/finalization do not reference `secrets.` or production credential names.
- package version remains `0.4.0`; `package-lock.json` is unchanged relative to base scope.
- changed implementation paths exclude optical encoder/decoder/session, signaling, TURN, signing/release workflow logic.

- [ ] **Step 4: Implement operator documentation**

Document exact sequence: obtain same-run main Windows+Android Native Builds artifacts; run prepare CLI; perform one physical scenario; collect receiver platform facts; write a small operator-observations JSON using exact documented keys; finalize against saved received file; repeat matrix; run summary. State explicitly that hosted tests are not physical proof, camera imagery is prohibited, PR artifacts cannot close #50, #15 must be independently closed, and timing observations are not product throughput claims.

- [ ] **Step 5: Run full repository verification**

Run:

```bash
npm test
npm run build:web
npm run build:native-ui
npm run check:signaling
npm run check:web-deploy
```

Expected: zero failures and no behavior/scope regression.

- [ ] **Step 6: Exact-head hosted gates**

Push final branch head and require repository-owned `CI`, `Browser Reliability`, `GitHub Pages Mirror`, and `Native Builds` workflows all SUCCESS on that exact SHA. Physical workflow is not required for code GREEN and must not be triggered from the PR.

- [ ] **Step 7: Final scope audit**

Compare final head to its merge base and confirm changes are limited to the spec/plan plus evidence model/scripts/tests/docs and the minimal Android collector refactor. Confirm package/version/dependency/workflows/protocol/signaling/TURN/signing paths are untouched.

- [ ] **Step 8: Keep implementation PR draft while #15 is open**

Update PR body with exact RED and GREEN SHAs/run IDs, scope, claim boundaries, and #50 relation. Do not merge until protected-main trust is real.

Commit final docs/tests as: `docs: add FQR2 physical ceremony procedure`

---

## Self-Review Checklist

- Spec coverage: Tasks 1-6 cover schema, canonicalization, ceremony ID, immutable preparation, main Native Builds same-run artifact binding, generated payloads, independent receive hashing, Android/Windows hardware prerequisites, per-scenario validation, matrix validation, privacy, fail-closed behavior, existing #17 preservation, operator docs, hosted gates, and #15 integration boundary.
- Placeholder scan: no TODO/TBD/"implement later" instructions are permitted in execution; every production unit has explicit interfaces, test commands, failure expectations, and commit boundary.
- Type consistency: preparation build uses one `artifacts.windows` and one `artifacts.android`; all downstream final/matrix records reuse those immutable fields. `ceremonyId` is derived only from preparation. Operator input never supplies `assertions` or `result`.
- Scope consistency: no new workflow, no dependency change, no package version change, and no transfer-protocol/runtime edits.

## Execution Choice

The user explicitly authorized immediate execution without further approval prompts. Execute this plan inline in the current session using `superpowers:executing-plans`, preserving the required test-only hosted RED before any production evidence-kit module is added.