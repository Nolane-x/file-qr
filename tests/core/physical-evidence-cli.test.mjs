import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { prepareCeremony } from '../../scripts/prepare-optical-physical-evidence.mjs';

const SHA = 'a'.repeat(40);
const H1 = '1'.repeat(64);
const H2 = '2'.repeat(64);
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');

function execGh(endpoint) {
  if (endpoint.endsWith('/artifacts')) {
    return JSON.stringify({ artifacts: [
      { id: 10, name: 'file-qr-windows', digest: `sha256:${H1}`, expired: false, workflow_run: { id: 123, head_sha: SHA } },
      { id: 11, name: 'file-qr-android', digest: `sha256:${H2}`, expired: false, workflow_run: { id: 123, head_sha: SHA } },
    ] });
  }
  return JSON.stringify({
    id: 123, name: 'Native Builds', event: 'push', head_branch: 'main', head_sha: SHA,
    repository: { full_name: 'Nolane-x/file-qr' },
  });
}

function tempInputs() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fileqr-ceremony-'));
  const windows = path.join(dir, 'FileQR.exe');
  const android = path.join(dir, 'FileQR.apk');
  fs.writeFileSync(windows, Buffer.from('windows-binary'));
  fs.writeFileSync(android, Buffer.from('android-binary'));
  return { dir, windows, android };
}

test('preparation binds both local binaries and generated payload without embedding bytes', async () => {
  const { dir, windows, android } = tempInputs();
  const workspace = path.join(dir, 'workspace');
  const p = await prepareCeremony({
    scenario: 'fqr2-windows-to-android', runId: 123,
    windowsBinaryPath: windows, androidBinaryPath: android,
    payloadBytes: 4096, workspace, execGh, controlSha: SHA,
    now: () => new Date('2026-09-10T12:00:00.000Z'),
  });

  assert.equal(p.build.artifacts.windows.binarySha256, sha(Buffer.from('windows-binary')));
  assert.equal(p.build.artifacts.android.binarySha256, sha(Buffer.from('android-binary')));
  assert.equal(p.payload.generated, true);
  assert.equal(p.payload.bytes, 4096);
  assert.match(p.ceremonyId, /^[a-f0-9]{24}$/);
  const payloadPath = path.join(workspace, 'payload.bin');
  const manifestPath = path.join(workspace, 'preparation.json');
  assert.equal(fs.statSync(payloadPath).size, 4096);
  assert.equal(p.payload.sourceSha256, sha(fs.readFileSync(payloadPath)));
  assert.deepEqual(JSON.parse(fs.readFileSync(manifestPath, 'utf8')), p);
  const json = fs.readFileSync(manifestPath, 'utf8');
  assert.doesNotMatch(json, /windows-binary|android-binary|payload\.bin|FileQR\.exe|FileQR\.apk/);
});

test('preparation rejects wrong control head, absent binaries and invalid payload sizes', async () => {
  const { dir, windows, android } = tempInputs();
  const base = {
    scenario: 'fqr2-windows-to-android', runId: 123,
    windowsBinaryPath: windows, androidBinaryPath: android,
    workspace: path.join(dir, 'w'), execGh,
    now: () => new Date('2026-09-10T12:00:00.000Z'),
  };
  await assert.rejects(() => prepareCeremony({ ...base, payloadBytes: 1, controlSha: 'b'.repeat(40) }), /FQR_EVIDENCE_BUILD_AUTHORITY/);
  await assert.rejects(() => prepareCeremony({ ...base, payloadBytes: 1, controlSha: SHA, windowsBinaryPath: path.join(dir, 'missing.exe') }), /FQR_EVIDENCE_FILE/);
  await assert.rejects(() => prepareCeremony({ ...base, payloadBytes: 0, controlSha: SHA }), /FQR_EVIDENCE_PAYLOAD/);
  await assert.rejects(() => prepareCeremony({ ...base, payloadBytes: 64 * 1024 * 1024 + 1, controlSha: SHA }), /FQR_EVIDENCE_PAYLOAD/);
});

test('FQR1 preparation keeps compatibility geometry and evidence budget', async () => {
  const { dir, windows, android } = tempInputs();
  const p = await prepareCeremony({
    scenario: 'fqr1-windows-to-android', runId: 123,
    windowsBinaryPath: windows, androidBinaryPath: android,
    payloadBytes: 1024, workspace: path.join(dir, 'fqr1'), execGh, controlSha: SHA,
    now: () => new Date('2026-09-10T12:00:00.000Z'),
  });
  assert.deepEqual(p.protocol, { version: 'FQR1', blockBytes: null, symbolBytes: null });
});
