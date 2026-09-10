import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { prepareCeremony } from '../../scripts/prepare-optical-physical-evidence.mjs';
import { finalizeCeremony } from '../../scripts/finalize-optical-physical-evidence.mjs';

const SHA = 'a'.repeat(40);
const H1 = '1'.repeat(64);
const H2 = '2'.repeat(64);

function execGh(endpoint) {
  if (endpoint.endsWith('/artifacts')) return JSON.stringify({ artifacts: [
    { id: 10, name: 'file-qr-windows', digest: `sha256:${H1}`, expired: false, workflow_run: { id: 123, head_sha: SHA } },
    { id: 11, name: 'file-qr-android', digest: `sha256:${H2}`, expired: false, workflow_run: { id: 123, head_sha: SHA } },
  ] });
  return JSON.stringify({ id: 123, name: 'Native Builds', event: 'push', head_branch: 'main', head_sha: SHA, repository: { full_name: 'Nolane-x/file-qr' } });
}

async function workspace() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fileqr-finalize-'));
  const windows = path.join(root, 'win.bin');
  const android = path.join(root, 'android.bin');
  fs.writeFileSync(windows, 'win');
  fs.writeFileSync(android, 'android');
  const dir = path.join(root, 'ceremony');
  await prepareCeremony({
    scenario: 'fqr2-windows-to-android', runId: 123, windowsBinaryPath: windows,
    androidBinaryPath: android, payloadBytes: 4096, workspace: dir, execGh, controlSha: SHA,
    now: () => new Date('2026-09-10T12:00:00.000Z'),
  });
  const received = path.join(root, 'received.bin');
  fs.copyFileSync(path.join(dir, 'payload.bin'), received);
  const facts = path.join(root, 'facts.json');
  fs.writeFileSync(facts, JSON.stringify({
    sender: { platform: 'windows', osClass: 'Windows 11', deviceClass: 'desktop', cameraDevicePresent: false, cameraDeviceCount: 0 },
    receiver: { platform: 'android', osClass: 'Android 16', deviceClass: 'phone-rear-camera', physicalDevice: true, emulatorRejected: true, cameraPermissionGranted: true, cameraOwnerObserved: true },
  }));
  const observations = path.join(root, 'observations.json');
  fs.writeFileSync(observations, JSON.stringify({
    physicalDisplayToCameraPath: true, virtualCameraAbsent: true, joinedMidCycle: false,
    repairPhaseOnlyStart: false, framesIntentionallyMissed: false,
    interruptionPerformed: false, resumeObserved: false, observedCycles: null,
  }));
  return { root, dir, received, facts, observations, output: path.join(root, 'evidence.json') };
}

test('finalizer independently hashes received bytes and publishes normalized PASS atomically', async () => {
  const x = await workspace();
  const record = await finalizeCeremony({
    preparationPath: path.join(x.dir, 'preparation.json'), receivedPath: x.received,
    platformFactsPath: x.facts, observationsPath: x.observations, outputPath: x.output,
    now: () => new Date('2026-09-10T12:01:00.000Z'),
  });
  assert.equal(record.result, 'PASS');
  assert.deepEqual(JSON.parse(fs.readFileSync(x.output, 'utf8')), record);
  assert.equal(record.payload.receivedBytes, 4096);
  assert.equal(record.payload.receivedSha256, record.payload.sourceSha256);
  assert.doesNotMatch(fs.readFileSync(x.output, 'utf8'), new RegExp(x.root.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
});

test('finalizer refuses corrupt received bytes and leaves no PASS artifact', async () => {
  const x = await workspace();
  fs.appendFileSync(x.received, 'x');
  await assert.rejects(() => finalizeCeremony({
    preparationPath: path.join(x.dir, 'preparation.json'), receivedPath: x.received,
    platformFactsPath: x.facts, observationsPath: x.observations, outputPath: x.output,
    now: () => new Date('2026-09-10T12:01:00.000Z'),
  }), /FQR_EVIDENCE_FINAL_FAIL/);
  assert.equal(fs.existsSync(x.output), false);
  assert.equal(fs.existsSync(`${x.output}.tmp`), false);
});

test('finalizer rejects tampered preparation and unknown operator keys', async () => {
  const x = await workspace();
  const manifestPath = path.join(x.dir, 'preparation.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  manifest.build.workflowRunId = 999;
  fs.writeFileSync(manifestPath, JSON.stringify(manifest));
  await assert.rejects(() => finalizeCeremony({
    preparationPath: manifestPath, receivedPath: x.received, platformFactsPath: x.facts,
    observationsPath: x.observations, outputPath: x.output,
    now: () => new Date('2026-09-10T12:01:00.000Z'),
  }), /FQR_EVIDENCE_CEREMONY_ID/);

  const y = await workspace();
  const obs = JSON.parse(fs.readFileSync(y.observations, 'utf8'));
  obs.operatorPass = true;
  fs.writeFileSync(y.observations, JSON.stringify(obs));
  await assert.rejects(() => finalizeCeremony({
    preparationPath: path.join(y.dir, 'preparation.json'), receivedPath: y.received,
    platformFactsPath: y.facts, observationsPath: y.observations, outputPath: y.output,
    now: () => new Date('2026-09-10T12:01:00.000Z'),
  }), /FQR_EVIDENCE_FINAL_INPUT/);
});
