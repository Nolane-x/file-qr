import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const moduleUrl = new URL('../../scripts/physical-evidence-github.mjs', import.meta.url);
const SHA = 'a'.repeat(40);
const archiveSha = createHash('sha256').update('android-archive').digest('hex');
const apkBytes = Buffer.from('trusted-android-apk');
const apkSha = createHash('sha256').update(apkBytes).digest('hex');

function execGh(endpoint) {
  if (endpoint.endsWith('/artifacts')) {
    return JSON.stringify({ artifacts: [
      { id: 10, name: 'file-qr-windows', digest: `sha256:${'1'.repeat(64)}`, expired: false, workflow_run: { id: 123, head_sha: SHA } },
      { id: 11, name: 'file-qr-android', digest: `sha256:${archiveSha}`, expired: false, workflow_run: { id: 123, head_sha: SHA } },
    ] });
  }
  return JSON.stringify({
    id: 123, name: 'Native Builds', event: 'push', head_branch: 'main', head_sha: SHA,
    status: 'completed', conclusion: 'success', repository: { full_name: 'Nolane-x/file-qr' },
  });
}

test('Android physical authority verifies exact main run, artifact identity, archive bytes and APK bytes', async () => {
  const module = await import(moduleUrl);
  assert.equal(typeof module.verifyAndroidPhysicalArtifact, 'function');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fileqr-android-authority-'));
  const apkPath = path.join(root, 'FileQR-Android-arm64.apk');
  fs.writeFileSync(apkPath, apkBytes, { mode: 0o600 });

  const authority = await module.verifyAndroidPhysicalArtifact({
    runId: 123,
    artifactId: 11,
    archiveSha256: archiveSha,
    apkPath,
    controlSha: SHA,
    execGh,
  });

  assert.equal(authority.schemaVersion, 1);
  assert.equal(authority.commitSha, SHA);
  assert.equal(authority.workflowRunId, 123);
  assert.deepEqual(authority.artifact, {
    artifactId: 11,
    name: 'file-qr-android',
    artifactDigest: `sha256:${archiveSha}`,
  });
  assert.deepEqual(authority.apk, {
    name: 'FileQR-Android-arm64.apk',
    bytes: apkBytes.length,
    sha256: apkSha,
  });
  assert.doesNotMatch(JSON.stringify(authority), new RegExp(root.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
});

test('Android physical authority fails closed on wrong control head, artifact id, archive digest and APK layout', async () => {
  const module = await import(moduleUrl);
  assert.equal(typeof module.verifyAndroidPhysicalArtifact, 'function');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fileqr-android-authority-fail-'));
  const apkPath = path.join(root, 'FileQR-Android-arm64.apk');
  fs.writeFileSync(apkPath, apkBytes, { mode: 0o600 });
  const base = { runId: 123, artifactId: 11, archiveSha256: archiveSha, apkPath, controlSha: SHA, execGh };

  await assert.rejects(() => module.verifyAndroidPhysicalArtifact({ ...base, controlSha: 'b'.repeat(40) }), /FQR_EVIDENCE_BUILD_AUTHORITY/);
  await assert.rejects(() => module.verifyAndroidPhysicalArtifact({ ...base, artifactId: 99 }), /FQR_EVIDENCE_ARTIFACT_DRIFT/);
  await assert.rejects(() => module.verifyAndroidPhysicalArtifact({ ...base, archiveSha256: 'f'.repeat(64) }), /FQR_EVIDENCE_ARTIFACT_BYTES/);

  const wrongName = path.join(root, 'other.apk');
  fs.writeFileSync(wrongName, apkBytes, { mode: 0o600 });
  await assert.rejects(() => module.verifyAndroidPhysicalArtifact({ ...base, apkPath: wrongName }), /FQR_EVIDENCE_ARTIFACT_LAYOUT/);
});
