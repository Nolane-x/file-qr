import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { prepareAndroidPhysicalEvidence } from '../../scripts/prepare-android-physical-evidence.mjs';

const SHA = 'a'.repeat(40);
const APK_BYTES = Buffer.from('authoritative-android-apk');
const ARCHIVE_SHA = createHash('sha256').update('authoritative-android-archive').digest('hex');
const apkSha = createHash('sha256').update(APK_BYTES).digest('hex');

function run() {
  return {
    id: 123,
    name: 'Native Builds',
    event: 'push',
    head_branch: 'main',
    head_sha: SHA,
    status: 'completed',
    conclusion: 'success',
    repository: { full_name: 'Nolane-x/file-qr' },
  };
}

function artifacts() {
  return {
    artifacts: [
      {
        id: 10,
        name: 'file-qr-windows',
        digest: `sha256:${'1'.repeat(64)}`,
        expired: false,
        workflow_run: { id: 123, head_sha: SHA },
      },
      {
        id: 11,
        name: 'file-qr-android',
        digest: `sha256:${ARCHIVE_SHA}`,
        expired: false,
        workflow_run: { id: 123, head_sha: SHA },
      },
    ],
  };
}

function execGh(endpoint) {
  return JSON.stringify(endpoint.endsWith('/artifacts') ? artifacts() : run());
}

function tempRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'fileqr-android-authority-'));
}

function writeArtifact(destination) {
  fs.mkdirSync(destination, { recursive: false, mode: 0o700 });
  fs.writeFileSync(path.join(destination, 'FileQR-Android-arm64.apk'), APK_BYTES, { mode: 0o600 });
}

test('Android physical preparation materializes the exact Native Builds APK and writes sanitized authority', async () => {
  const root = tempRoot();
  const outputDir = path.join(root, 'physical-input');
  const authorityPath = path.join(root, 'android-build-authority.json');

  const artifactFetcher = ({ outputDir: destination }) => {
    writeArtifact(destination);
    return { archiveSha256: ARCHIVE_SHA };
  };

  const authority = await prepareAndroidPhysicalEvidence({
    runId: 123,
    outputDir,
    authorityPath,
    execGh,
    controlSha: SHA,
    artifactFetcher,
    now: () => new Date('2026-09-12T06:00:00.000Z'),
  });

  assert.equal(authority.schemaVersion, 1);
  assert.equal(authority.repository, 'Nolane-x/file-qr');
  assert.equal(authority.workflow, 'Native Builds');
  assert.equal(authority.workflowRunId, 123);
  assert.equal(authority.commitSha, SHA);
  assert.equal(authority.artifactId, 11);
  assert.equal(authority.artifactName, 'file-qr-android');
  assert.equal(authority.artifactDigest, `sha256:${ARCHIVE_SHA}`);
  assert.equal(authority.archiveSha256, ARCHIVE_SHA);
  assert.equal(authority.apkSha256, apkSha);
  assert.equal(authority.apkBytes, APK_BYTES.length);
  assert.equal(authority.observedAt, '2026-09-12T06:00:00.000Z');
  assert.deepEqual(fs.readFileSync(path.join(outputDir, 'FileQR-Android-arm64.apk')), APK_BYTES);
  assert.deepEqual(JSON.parse(fs.readFileSync(authorityPath, 'utf8')), authority);
  assert.doesNotMatch(fs.readFileSync(authorityPath, 'utf8'), /physical-input|\.apk\"\s*:/i);
});

test('Android physical preparation removes partial materialization when archive digest does not match', async () => {
  const root = tempRoot();
  const outputDir = path.join(root, 'physical-input');
  const authorityPath = path.join(root, 'android-build-authority.json');
  const otherArchiveSha = createHash('sha256').update('other-archive').digest('hex');

  const artifactFetcher = ({ outputDir: destination }) => {
    writeArtifact(destination);
    return { archiveSha256: otherArchiveSha };
  };

  await assert.rejects(() => prepareAndroidPhysicalEvidence({
    runId: 123,
    outputDir,
    authorityPath,
    execGh,
    controlSha: SHA,
    artifactFetcher,
  }), /FQR_ANDROID_PHYSICAL_BYTES/);

  assert.equal(fs.existsSync(outputDir), false);
  assert.equal(fs.existsSync(authorityPath), false);
});
