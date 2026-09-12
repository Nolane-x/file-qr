import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const helperUrl = new URL('../../scripts/prepare-android-physical-evidence.mjs', import.meta.url);
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

function artifactFetcher({ destinationDir }) {
  fs.mkdirSync(destinationDir, { recursive: false, mode: 0o700 });
  fs.writeFileSync(path.join(destinationDir, 'FileQR-Android-arm64.apk'), apkBytes, { mode: 0o600 });
  return { archiveSha256: archiveSha };
}

test('Android physical authority materializes only the exact main Native Builds APK and writes sanitized binding', async () => {
  assert.ok(fs.existsSync(helperUrl), 'Android physical authority helper must exist');
  const { prepareAndroidPhysicalAuthority } = await import(helperUrl);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fileqr-android-authority-'));
  const destinationDir = path.join(root, 'trusted-android-artifact');
  const authorityPath = path.join(root, 'android-physical-authority.json');

  const result = await prepareAndroidPhysicalAuthority({
    runId: 123,
    destinationDir,
    authorityPath,
    controlSha: SHA,
    execGh,
    artifactFetcher,
  });

  assert.equal(result.apkPath, path.join(destinationDir, 'FileQR-Android-arm64.apk'));
  assert.equal(result.authority.commitSha, SHA);
  assert.equal(result.authority.workflowRunId, 123);
  assert.deepEqual(result.authority.artifact, {
    artifactId: 11,
    name: 'file-qr-android',
    artifactDigest: `sha256:${archiveSha}`,
  });
  assert.deepEqual(result.authority.apk, {
    name: 'FileQR-Android-arm64.apk',
    bytes: apkBytes.length,
    sha256: apkSha,
  });
  assert.deepEqual(JSON.parse(fs.readFileSync(authorityPath, 'utf8')), result.authority);
  const json = fs.readFileSync(authorityPath, 'utf8');
  assert.doesNotMatch(json, new RegExp(root.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
});

test('Android physical authority fails closed on wrong control head or archive digest and leaves no authority file', async () => {
  assert.ok(fs.existsSync(helperUrl), 'Android physical authority helper must exist');
  const { prepareAndroidPhysicalAuthority } = await import(helperUrl);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fileqr-android-authority-fail-'));

  await assert.rejects(() => prepareAndroidPhysicalAuthority({
    runId: 123,
    destinationDir: path.join(root, 'wrong-head'),
    authorityPath: path.join(root, 'wrong-head.json'),
    controlSha: 'b'.repeat(40),
    execGh,
    artifactFetcher,
  }), /FQR_EVIDENCE_BUILD_AUTHORITY/);

  const badAuthority = path.join(root, 'bad-digest.json');
  const badDestination = path.join(root, 'bad-digest');
  await assert.rejects(() => prepareAndroidPhysicalAuthority({
    runId: 123,
    destinationDir: badDestination,
    authorityPath: badAuthority,
    controlSha: SHA,
    execGh,
    artifactFetcher: ({ destinationDir: dir }) => {
      fs.mkdirSync(dir, { recursive: false, mode: 0o700 });
      fs.writeFileSync(path.join(dir, 'FileQR-Android-arm64.apk'), apkBytes, { mode: 0o600 });
      return { archiveSha256: 'f'.repeat(64) };
    },
  }), /FQR_EVIDENCE_ARTIFACT_BYTES/);
  assert.equal(fs.existsSync(badAuthority), false);
  assert.equal(fs.existsSync(badDestination), false);
});
