import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  physicalInstructionsForScenario,
  prepareCeremony,
} from '../../scripts/prepare-optical-physical-evidence.mjs';

const SHA = 'a'.repeat(40);
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const WINDOWS_ARCHIVE_SHA = sha(Buffer.from('windows-artifact-archive'));
const ANDROID_ARCHIVE_SHA = sha(Buffer.from('android-artifact-archive'));
const WINDOWS_BYTES = Buffer.from('windows-binary-from-artifact');
const ANDROID_BYTES = Buffer.from('android-binary-from-artifact');

function execGh(endpoint) {
  if (endpoint.endsWith('/artifacts')) {
    return JSON.stringify({ artifacts: [
      { id: 10, name: 'file-qr-windows', digest: `sha256:${WINDOWS_ARCHIVE_SHA}`, expired: false, workflow_run: { id: 123, head_sha: SHA } },
      { id: 11, name: 'file-qr-android', digest: `sha256:${ANDROID_ARCHIVE_SHA}`, expired: false, workflow_run: { id: 123, head_sha: SHA } },
    ] });
  }
  return JSON.stringify({
    id: 123, name: 'Native Builds', event: 'push', head_branch: 'main', head_sha: SHA,
    status: 'completed', conclusion: 'success', repository: { full_name: 'Nolane-x/file-qr' },
  });
}

function tempRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'fileqr-ceremony-'));
}

function artifactFetcher({ platform, destinationDir }) {
  fs.mkdirSync(destinationDir, { recursive: false, mode: 0o700 });
  if (platform === 'windows') {
    const binaryPath = path.join(destinationDir, 'FileQR-Windows-x64-setup.exe');
    fs.writeFileSync(binaryPath, WINDOWS_BYTES, { mode: 0o600 });
    return { binaryPath, archiveSha256: WINDOWS_ARCHIVE_SHA };
  }
  const binaryPath = path.join(destinationDir, 'FileQR-Android-arm64.apk');
  fs.writeFileSync(binaryPath, ANDROID_BYTES, { mode: 0o600 });
  return { binaryPath, archiveSha256: ANDROID_ARCHIVE_SHA };
}

test('authoritative preparation fetches exact run artifacts and hashes only controlled extracted binaries', async () => {
  const dir = tempRoot();
  const workspace = path.join(dir, 'workspace');
  const p = await prepareCeremony({
    scenario: 'fqr2-windows-to-android', runId: 123,
    payloadBytes: 4096, workspace, execGh, controlSha: SHA, artifactFetcher,
    now: () => new Date('2026-09-10T12:00:00.000Z'),
  });

  assert.equal(p.build.artifacts.windows.artifactDigest, `sha256:${WINDOWS_ARCHIVE_SHA}`);
  assert.equal(p.build.artifacts.android.artifactDigest, `sha256:${ANDROID_ARCHIVE_SHA}`);
  assert.equal(p.build.artifacts.windows.binarySha256, sha(WINDOWS_BYTES));
  assert.equal(p.build.artifacts.android.binarySha256, sha(ANDROID_BYTES));
  assert.equal(p.payload.generated, true);
  assert.equal(p.payload.bytes, 4096);
  assert.match(p.ceremonyId, /^[a-f0-9]{24}$/);

  const windowsPath = path.join(workspace, 'artifacts', 'windows', 'FileQR-Windows-x64-setup.exe');
  const androidPath = path.join(workspace, 'artifacts', 'android', 'FileQR-Android-arm64.apk');
  assert.deepEqual(fs.readFileSync(windowsPath), WINDOWS_BYTES);
  assert.deepEqual(fs.readFileSync(androidPath), ANDROID_BYTES);

  const payloadPath = path.join(workspace, 'payload.bin');
  const manifestPath = path.join(workspace, 'preparation.json');
  assert.equal(fs.statSync(payloadPath).size, 4096);
  assert.equal(p.payload.sourceSha256, sha(fs.readFileSync(payloadPath)));
  assert.deepEqual(JSON.parse(fs.readFileSync(manifestPath, 'utf8')), p);
  const json = fs.readFileSync(manifestPath, 'utf8');
  assert.doesNotMatch(json, /FileQR-Windows|FileQR-Android|artifact.*path|payload\.bin/i);
});

test('authoritative preparation rejects legacy operator-supplied binary paths', async () => {
  const dir = tempRoot();
  const windows = path.join(dir, 'stale.exe');
  const android = path.join(dir, 'stale.apk');
  fs.writeFileSync(windows, Buffer.from('arbitrary-old-windows-binary'));
  fs.writeFileSync(android, Buffer.from('arbitrary-old-android-binary'));

  await assert.rejects(() => prepareCeremony({
    scenario: 'fqr2-windows-to-android', runId: 123,
    windowsBinaryPath: windows, androidBinaryPath: android,
    payloadBytes: 1024, workspace: path.join(dir, 'workspace'), execGh, controlSha: SHA,
    now: () => new Date('2026-09-10T12:00:00.000Z'),
  }), /FQR_EVIDENCE_ARTIFACT_FETCH/);
});

test('authoritative preparation rejects downloaded artifact bytes that do not match GitHub artifact digest', async () => {
  const dir = tempRoot();
  const badFetcher = ({ platform, destinationDir }) => {
    const result = artifactFetcher({ platform, destinationDir });
    return { ...result, archiveSha256: sha(Buffer.from(`tampered-${platform}-archive`)) };
  };

  await assert.rejects(() => prepareCeremony({
    scenario: 'fqr2-windows-to-android', runId: 123,
    payloadBytes: 1024, workspace: path.join(dir, 'workspace'), execGh, controlSha: SHA,
    artifactFetcher: badFetcher,
    now: () => new Date('2026-09-10T12:00:00.000Z'),
  }), /FQR_EVIDENCE_ARTIFACT_BYTES/);
  assert.equal(fs.existsSync(path.join(dir, 'workspace')), false);
});

test('preparation rejects wrong control head and invalid payload sizes before publishing a workspace', async () => {
  const dir = tempRoot();
  const base = {
    scenario: 'fqr2-windows-to-android', runId: 123,
    workspace: path.join(dir, 'w'), execGh, artifactFetcher,
    now: () => new Date('2026-09-10T12:00:00.000Z'),
  };
  await assert.rejects(() => prepareCeremony({ ...base, payloadBytes: 1, controlSha: 'b'.repeat(40) }), /FQR_EVIDENCE_BUILD_AUTHORITY/);
  await assert.rejects(() => prepareCeremony({ ...base, payloadBytes: 0, controlSha: SHA }), /FQR_EVIDENCE_PAYLOAD/);
  await assert.rejects(() => prepareCeremony({ ...base, payloadBytes: 64 * 1024 * 1024 + 1, controlSha: SHA }), /FQR_EVIDENCE_PAYLOAD/);
});

test('FQR1 preparation keeps compatibility geometry and evidence budget', async () => {
  const dir = tempRoot();
  const p = await prepareCeremony({
    scenario: 'fqr1-windows-to-android', runId: 123,
    payloadBytes: 1024, workspace: path.join(dir, 'fqr1'), execGh, controlSha: SHA,
    artifactFetcher,
    now: () => new Date('2026-09-10T12:00:00.000Z'),
  });
  assert.deepEqual(p.protocol, { version: 'FQR1', blockBytes: null, symbolBytes: null });
});

test('physical ceremony instructions are scenario-specific and preserve claim boundaries', () => {
  const baseline = physicalInstructionsForScenario('fqr2-windows-to-android').join('\n');
  assert.match(baseline, /Windows display/i);
  assert.match(baseline, /physical Android/i);
  assert.match(baseline, /virtual camera/i);

  assert.match(physicalInstructionsForScenario('fqr2-mid-cycle').join('\n'), /after the broadcast is already in progress/i);
  assert.match(physicalInstructionsForScenario('fqr2-repair-phase').join('\n'), /repair/i);
  assert.match(physicalInstructionsForScenario('fqr2-large-file').join('\n'), /greater than 8 MiB/i);
  assert.match(physicalInstructionsForScenario('fqr2-interruption-resume').join('\n'), /durable progress/i);
  assert.match(physicalInstructionsForScenario('fqr1-android-to-windows').join('\n'), /FQR1/i);
  assert.throws(() => physicalInstructionsForScenario('unknown'), /FQR_EVIDENCE_SCENARIO/);
});