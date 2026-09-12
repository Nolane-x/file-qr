import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { prepareAndroidPhysicalEvidence } from '../../scripts/prepare-android-physical-evidence.mjs';

const SHA = 'a'.repeat(40);
const ARCHIVE_SHA = createHash('sha256').update('android-archive').digest('hex');

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

function listing(androidId = 11) {
  return {
    artifacts: [
      { id: 10, name: 'file-qr-windows', digest: `sha256:${'1'.repeat(64)}`, expired: false, workflow_run: { id: 123, head_sha: SHA } },
      { id: androidId, name: 'file-qr-android', digest: `sha256:${ARCHIVE_SHA}`, expired: false, workflow_run: { id: 123, head_sha: SHA } },
    ],
  };
}

function outputPaths(prefix) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  return {
    outputDir: path.join(root, 'physical-input'),
    authorityPath: path.join(root, 'authority.json'),
  };
}

test('Android physical preparation rejects a Native Builds run that is not the checked-out trusted main', async () => {
  const { outputDir, authorityPath } = outputPaths('fileqr-android-head-');
  const execGh = (endpoint) => JSON.stringify(endpoint.endsWith('/artifacts') ? listing() : run());
  let fetched = false;

  await assert.rejects(() => prepareAndroidPhysicalEvidence({
    runId: 123,
    outputDir,
    authorityPath,
    execGh,
    controlSha: 'b'.repeat(40),
    artifactFetcher: async () => { fetched = true; },
  }), /FQR_ANDROID_PHYSICAL_AUTHORITY/);

  assert.equal(fetched, false);
});

test('Android physical preparation rejects artifact identity drift after materialization', async () => {
  const { outputDir, authorityPath } = outputPaths('fileqr-android-drift-');
  let artifactQueries = 0;
  const execGh = (endpoint) => {
    if (!endpoint.endsWith('/artifacts')) return JSON.stringify(run());
    artifactQueries += 1;
    return JSON.stringify(listing(artifactQueries === 1 ? 11 : 99));
  };
  const artifactFetcher = async ({ outputDir: destination }) => {
    fs.mkdirSync(destination, { recursive: false, mode: 0o700 });
    fs.writeFileSync(path.join(destination, 'FileQR-Android-arm64.apk'), 'apk');
    return { archiveSha256: ARCHIVE_SHA };
  };

  await assert.rejects(() => prepareAndroidPhysicalEvidence({
    runId: 123,
    outputDir,
    authorityPath,
    execGh,
    controlSha: SHA,
    artifactFetcher,
  }), /FQR_ANDROID_PHYSICAL_DRIFT/);

  assert.equal(artifactQueries, 2);
});
