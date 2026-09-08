import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const workflowUrl = new URL('../../.github/workflows/native.yml', import.meta.url);

test('future native releases require GitHub build attestations with release-only OIDC permissions', () => {
  const workflow = fs.readFileSync(workflowUrl, 'utf8');

  assert.match(workflow, /permissions:\s*\n\s{2}contents:\s*read\s*\n\s*jobs:/);
  assert.match(workflow, /\n\s{2}release:[\s\S]*?\n\s{4}permissions:\s*\n\s{6}contents:\s*write\s*\n\s{6}id-token:\s*write\s*\n\s{6}attestations:\s*write\s*\n\s{6}artifact-metadata:\s*write/);
  assert.match(workflow, /actions\/attest@v4\.2\.2/);
  assert.match(workflow, /subject-path:\s*\|[\s\S]*FileQR-Windows-x64-setup\.exe/);
  assert.match(workflow, /subject-path:\s*\|[\s\S]*FileQR-Android-arm64\.apk/);
  assert.match(workflow, /subject-path:\s*\|[\s\S]*SHA256SUMS\.txt/);
});

test('release publication includes a deterministic SHA-256 manifest and verifies draft bytes before publish', () => {
  const workflow = fs.readFileSync(workflowUrl, 'utf8');

  assert.match(workflow, /Check whether package-version release already exists/);
  assert.match(workflow, /id:\s*release_state/);
  assert.match(workflow, /sha256sum[\s\S]*FileQR-Windows-x64-setup\.exe/);
  assert.match(workflow, /sha256sum[\s\S]*FileQR-Android-arm64\.apk/);
  assert.match(workflow, /SHA256SUMS\.txt/);
  assert.match(workflow, /gh release create[\s\S]*SHA256SUMS\.txt[\s\S]*--draft/);
  assert.match(workflow, /Verify draft release bytes and attestations/);
  assert.match(workflow, /gh release download/);
  assert.match(workflow, /sha256sum -c SHA256SUMS\.txt/);
  assert.match(workflow, /gh attestation verify FileQR-Windows-x64-setup\.exe[\s\S]*--repo "\$GITHUB_REPOSITORY"/);
  assert.match(workflow, /gh attestation verify FileQR-Android-arm64\.apk[\s\S]*--repo "\$GITHUB_REPOSITORY"/);
  assert.match(workflow, /gh attestation verify SHA256SUMS\.txt[\s\S]*--repo "\$GITHUB_REPOSITORY"/);
  assert.match(workflow, /gh release edit "\$TAG" --draft=false/);
  assert.match(workflow, /steps\.release_state\.outputs\.exists\s*!=\s*'true'/);
});

test('published releases are skipped, owned stale drafts recover, and foreign drafts fail closed', () => {
  const workflow = fs.readFileSync(workflowUrl, 'utf8');

  assert.match(workflow, /gh release view/);
  assert.match(workflow, /--json author,body,isDraft,tagName,targetCommitish/);
  assert.match(workflow, /classify-release-draft\.mjs/);
  assert.match(workflow, /recoverable-owned-draft/);
  assert.match(workflow, /Removing owned stale draft release \$TAG before rebuilding it\./);
  assert.match(workflow, /gh release delete "\$TAG"[\s\S]*--cleanup-tag[\s\S]*--yes/);
  assert.match(workflow, /published-existing-release/);
  assert.match(workflow, /exists=true/);
  assert.match(workflow, /Release .* already exists; leaving it unchanged\./);
  assert.match(workflow, /foreign-or-ambiguous-draft/);
  assert.match(workflow, /Refusing to delete foreign or ambiguous draft release \$TAG\./);
});