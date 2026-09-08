# Pre-merge Native Publisher Proof Design

## Goal

Break the native-signing trust deadlock without exposing publisher secrets to pull-request code.

PR #9 correctly keeps real publisher credentials out of pull-request jobs and executes production signing only on trusted `push main`. That means PR preview GREEN alone can never prove the real publisher identities before merge. The repository needs a trusted pre-merge proof path whose secret-bearing jobs execute only workflow code already present on `main`.

## Trust boundary

The proof workflow is manual and main-only. Its workflow definition must already exist on `main` before it can handle publisher credentials.

Candidate source is untrusted input even when it belongs to the same repository branch. Candidate build jobs therefore receive no publisher secrets. Secret-bearing signer jobs must not checkout candidate source, run candidate scripts, install candidate dependencies, or execute candidate binaries.

The only data crossing from candidate-build jobs into signer jobs is opaque build output plus non-secret metadata such as candidate SHA and expected artifact names.

## Flow

1. An operator dispatches the trusted workflow from `main` with an exact candidate SHA.
2. Secretless build jobs validate that the SHA belongs to `Nolane-x/file-qr`, checkout that exact SHA, build native candidate artifacts, normalize names, and upload them as Actions artifacts. These jobs have no publisher secrets.
3. Windows signer job downloads only the Windows artifact. It loads `WINDOWS_CERTIFICATE` / `WINDOWS_CERTIFICATE_PASSWORD`, validates private-key presence, expiry and Code Signing EKU, signs the opaque installer, then requires Authenticode `Valid` and signer thumbprint equality. It never executes the candidate installer.
4. Android signer job downloads only an unsigned/re-signable Android artifact. It loads `ANDROID_KEY_BASE64` / `ANDROID_KEY_PASSWORD` / `ANDROID_KEY_ALIAS`, validates the alias and release certificate, signs with Android build-tools, then requires `apksigner verify --print-certs` signer SHA-256 equality. It never executes candidate code.
5. Both signer jobs always remove imported certificates, temporary PFX/JKS files and any generated signing files.
6. A final evidence job publishes a sanitized JSON artifact containing candidate SHA, platform PASS/FAIL state, Windows signer thumbprint, Android certificate SHA-256, workflow run ID and observation time. No private key, password, base64 keystore, TURN secret, device identifier or certificate private material is serialized.

## Security constraints

- `workflow_dispatch` only; no `pull_request`, `pull_request_target`, `push` or `workflow_run` trigger for the proof workflow.
- Ref guard requires `refs/heads/main`.
- Workflow-level permissions remain read-only except the minimum Actions artifact/evidence permissions required by GitHub-hosted actions.
- Candidate SHA is data, never a workflow/script source for a secret-bearing job.
- No secret-bearing job uses `actions/checkout` on the candidate or runs `npm install`, `node`, Tauri, Gradle, PowerShell scripts from the candidate tree, or the produced application binary.
- Exact candidate SHA and artifact digests must be included in evidence so proof cannot be silently reused for a different head.
- Failure on either platform is fail-closed; no production-signing claim is allowed from preview CI alone.

## Merge policy integration

PR #9 remains draft until:

1. its exact final head passes normal CI/Browser/Pages/Native preview gates;
2. the trusted pre-merge publisher-proof workflow from `main` records PASS for that exact head using real publisher credentials;
3. after #9 is merged, trusted `main` Native Builds must still execute the integrated production signing paths successfully before any release is described as publisher-signed.

The pre-merge proof demonstrates that the configured publisher credentials can sign and verify the exact candidate artifacts without giving those credentials to PR code. The post-merge main run remains the authoritative proof that the integrated production workflow itself works.

## Release immutability

The pre-merge proof does not publish a GitHub Release. PR #9's release job independently uses draft-first publication, verifies SHA-256 and GitHub attestations while the release remains mutable, and publishes only after those checks pass. Repository-level immutable releases remain an administrator setting tracked separately.
