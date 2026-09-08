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

test('publisher proof binds candidates to trusted main and the audited signing-release scope', () => {
  const validate = section('  validate:', '  build_windows:');
  assert.match(validate, /actions\/checkout@v6/);
  assert.match(validate, /github\.sha/);
  assert.match(validate, /fetch-depth:\s*0/);
  assert.match(validate, /git fetch[^\n]*CANDIDATE_SHA/);
  assert.match(validate, /merge-base\s+--is-ancestor[^\n]*TRUSTED_MAIN_SHA[^\n]*CANDIDATE_SHA/);
  assert.match(validate, /git diff\s+--name-only[^\n]*TRUSTED_MAIN_SHA[^\n]*CANDIDATE_SHA/);
  assert.match(validate, /candidate contains changes outside publisher-proof scope/i);

  const allowedPaths = [
    '.github/workflows/native.yml',
    'scripts/classify-release-draft.mjs',
    'scripts/configure-android-signing.mjs',
    'scripts/configure-windows-signing.mjs',
    'tests/structure/native-production-signing.test.mjs',
    'tests/structure/release-draft-ownership.test.mjs',
    'tests/structure/release-provenance.test.mjs',
    'tests/unit/native-signing-helpers.test.mjs',
  ];
  for (const path of allowedPaths) {
    assert.ok(validate.includes(path), `trusted candidate scope must allow ${path}`);
  }
});

test('candidate build jobs are secretless and bind exact checkout SHA', () => {
  const builds = section('  build_windows:', '  sign_windows:') + section('  build_android:', '  sign_android:');
  assert.doesNotMatch(builds, /secrets\./);
  assert.match(builds, /actions\/checkout@v6/);
  assert.match(builds, /inputs\.candidate_sha|needs\.validate\.outputs\.candidate_sha/);
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

test('secret-bearing signer jobs use only GitHub-owned artifact actions', () => {
  const windows = section('  sign_windows:', '  build_android:');
  const android = section('  sign_android:', '  evidence:');
  for (const signer of [windows, android]) {
    const uses = [...signer.matchAll(/uses:\s*([^\n]+)/g)].map((match) => match[1].trim());
    assert.ok(uses.length > 0, 'signer must use artifact transfer actions');
    for (const action of uses) {
      assert.match(
        action,
        /^actions\/(?:download-artifact|upload-artifact)@v\d+(?:\.\d+\.\d+)?$/,
        `secret-bearing signer must not run non-GitHub setup action: ${action}`,
      );
    }
  }
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
