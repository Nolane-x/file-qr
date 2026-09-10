# FQR2 Physical Ceremony Kit — Artifact-to-Binary Binding Amendment

Date: 2026-09-11
Status: security amendment to the approved physical-ceremony design
Tracks: #50, PR #52
Supersedes only the operator-supplied-local-binary portions of the 2026-09-10 design; all other trust, schema, privacy, physical-evidence, and promotion boundaries remain unchanged.

## Problem found during adversarial closure audit

The original preparation flow resolved a successful `Native Builds` push on `main`, recorded the Windows and Android GitHub artifact IDs/names/digests, and independently hashed two local binary paths supplied by the operator.

Those were individually valid facts, but the implementation did not machine-prove that the local EXE/APK bytes actually came from the selected GitHub artifacts. An accidentally stale or unrelated local binary could therefore be hashed beside legitimate artifact metadata and admitted into an otherwise authoritative preparation record.

That is too weak for Issue #50's central provenance question: the physical ceremony must exercise the exact binaries produced by one exact integrated Native Builds lineage.

## Amended authoritative preparation contract

Authoritative v1 preparation no longer accepts operator-supplied Windows or Android binary paths.

For each platform, trusted control code must:

1. resolve one successful, completed `Native Builds` workflow run whose repository is exactly `Nolane-x/file-qr`, event is `push`, branch is `main`, and head SHA is valid;
2. require exactly one unexpired `file-qr-windows` and one unexpired `file-qr-android` artifact bound to that same run/head;
3. require the trusted controller commit SHA to equal that admitted Native Builds head SHA;
4. download the selected artifact archive by its exact GitHub artifact ID using authenticated GitHub CLI/API access;
5. SHA-256 hash the downloaded archive bytes and require exact equality with GitHub's recorded `artifactDigest`;
6. extract/download the same unique run artifact into a fresh controller-owned workspace directory, rather than accepting an arbitrary external binary path;
7. require an exact canonical one-file artifact layout:
   - Windows: `FileQR-Windows-x64-setup.exe`
   - Android: `FileQR-Android-arm64.apk`
8. reject missing, empty, extra, nested, symlinked, or wrongly named extracted entries;
9. independently SHA-256 hash only that controlled canonical binary;
10. bind the resulting binary SHA-256 into the immutable preparation manifest together with the existing artifact ID/name/digest and run/head identity.

Any archive digest mismatch, download failure, unexpected layout, or legacy operator-supplied binary path fails closed and removes the incomplete ceremony workspace.

## Why the archive digest and binary hash remain separate

GitHub's artifact digest identifies the downloaded artifact archive. The binary SHA-256 identifies the exact installable extracted from that artifact. They are different byte objects and must remain separate evidence fields.

The amended flow establishes the missing linkage operationally and cryptographically:

`successful main Native Builds run -> exact artifact ID -> downloaded archive bytes -> GitHub artifact digest match -> controlled canonical extracted binary -> independent binary SHA-256`

The evidence schema does not need a new field because it already records the run/head, artifact ID/name/digest, and binary SHA-256. The security defect was how `binarySha256` was sourced, not a missing JSON field.

## Ceremony identifier remains unchanged

`ceremonyId` remains an identifier, not authentication. Its approved deterministic input set is unchanged. This amendment does not silently add artifact IDs/digests to that identifier and does not change the existing fixed vector.

Artifact authority is enforced by preparation validation and the trusted fetch/hash pipeline, not by treating `ceremonyId` as a signature.

## CLI and workspace change

The authoritative preparation CLI now needs only:

- scenario;
- authoritative Native Builds run ID;
- generated payload size;
- a new empty workspace.

It no longer accepts `--windows-binary` or `--android-binary`.

Trusted preparation downloads and materializes the verified installables at:

- `<workspace>/artifacts/windows/FileQR-Windows-x64-setup.exe`
- `<workspace>/artifacts/android/FileQR-Android-arm64.apk`

Those exact files are the only binaries the physical ceremony may install/run for that preparation.

The operator environment must have an authenticated `gh` CLI identity authorized to read the repository's Actions run/artifact metadata and bytes. No production secret is required by the ceremony controller.

## Failure taxonomy

The amended implementation distinguishes:

- `FQR_EVIDENCE_ARTIFACT_FETCH` — artifact retrieval is unavailable, malformed at the command boundary, or a legacy external binary path is supplied;
- `FQR_EVIDENCE_ARTIFACT_BYTES` — downloaded archive SHA-256 does not match GitHub's artifact digest or the fetch result cannot prove that digest;
- `FQR_EVIDENCE_ARTIFACT_LAYOUT` — controlled extraction does not contain exactly the expected canonical non-empty regular binary.

All remain fail-closed.

## TDD evidence

Hosted RED head:
`eb43e9cab98cc076dadde2599b1a5f893f167e7a`

CI `34541282014` reported **174 tests / 169 PASS / exactly 5 FAIL**. The key regression test failed with `Missing expected rejection` when arbitrary legacy Windows/Android binary paths were supplied, directly reproducing the authority defect. The other failures were the new artifact-fetch/digest contract and dependent preparation fixtures. `npm ci` and High audit remained clean.

Production hardening commit:
`34e4ee5ded40f58bf47c8cc591ed65a68cc460e7`

That implementation made all new preparation provenance tests GREEN. Three pre-existing finalizer tests then failed only because their setup fixture still invoked the deliberately removed legacy binary-path API; no finalizer production behavior failed.

Fixture-alignment head:
`99e911491405302d940b19cd61fb01f9e2142c52`

CI `34541495012` is GREEN with **174/174 tests PASS**, 0 vulnerabilities, web/native-UI builds PASS, signaling Wrangler dry-run PASS, and web-deploy dry-run PASS.

## Scope guard

This amendment changes only ceremony evidence authority, tests, and documentation. It does not alter:

- FQR1 or FQR2 frame/protocol/runtime/session behavior;
- signaling or TURN behavior;
- native signing/release logic;
- GitHub workflow triggers or self-hosted runner policy;
- dependency graph or lockfile;
- package version `0.4.0`;
- physical evidence requirements;
- branch protection requirement #15.

Hosted GREEN still does not constitute physical camera evidence. Issue #50 remains open until the required ceremonies are executed against exact protected-main artifacts.