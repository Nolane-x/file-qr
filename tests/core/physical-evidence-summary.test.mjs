import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { finalizeEvidence } from '../../packages/core/physical-evidence.js';
import { writeEvidenceSummary } from '../../scripts/summarize-optical-physical-evidence.mjs';

const SHA = 'a'.repeat(40);
const H1 = '1'.repeat(64);
const H2 = '2'.repeat(64);
const H3 = '3'.repeat(64);

function prep(scenario, bytes = 65536) {
  return {
    schemaVersion: 1,
    scenario,
    control: { repository: 'Nolane-x/file-qr', commitSha: SHA },
    build: {
      repository: 'Nolane-x/file-qr', workflow: 'Native Builds', workflowRunId: 123,
      event: 'push', headBranch: 'main', commitSha: SHA,
      artifacts: {
        windows: { artifactId: 10, name: 'file-qr-windows', artifactDigest: `sha256:${H1}`, binarySha256: H2 },
        android: { artifactId: 11, name: 'file-qr-android', artifactDigest: `sha256:${H2}`, binarySha256: H3 },
      },
    },
    payload: { generated: true, generatorVersion: 1, bytes, sourceSha256: H1 },
    protocol: scenario.startsWith('fqr1-')
      ? { version: 'FQR1', blockBytes: null, symbolBytes: null }
      : { version: 'FQR2', blockBytes: 65536, symbolBytes: 768 },
    startedAt: '2026-09-10T12:00:00.000Z',
  };
}

function completion({ sender = 'windows', receiver = 'android', bytes = 65536,
  joinedMidCycle = false, repairPhaseOnlyStart = false, framesIntentionallyMissed = false,
  interruptionPerformed = false, resumeObserved = false } = {}) {
  return {
    sender: {
      platform: sender, osClass: sender === 'windows' ? 'Windows 11' : 'Android 16', deviceClass: 'sender',
      ...(sender === 'windows'
        ? { cameraDevicePresent: false, cameraDeviceCount: 0 }
        : { physicalDevice: true, emulatorRejected: true, cameraPermissionGranted: true, cameraOwnerObserved: false }),
    },
    receiver: {
      platform: receiver, osClass: receiver === 'windows' ? 'Windows 11' : 'Android 16', deviceClass: 'receiver',
      ...(receiver === 'windows'
        ? { cameraDevicePresent: true, cameraDeviceCount: 1 }
        : { physicalDevice: true, emulatorRejected: true, cameraPermissionGranted: true, cameraOwnerObserved: true }),
    },
    operatorObservations: {
      physicalDisplayToCameraPath: true, virtualCameraAbsent: true, joinedMidCycle,
      repairPhaseOnlyStart, framesIntentionallyMissed, interruptionPerformed, resumeObserved,
    },
    received: { bytes, sha256: H1 },
    completedAt: '2026-09-10T12:01:00.000Z',
    measurements: { wallClockMs: 60000, observedCycles: null },
    privacy: {
      cameraImageryCaptured: false, personalPayloadUsed: false, rawDeviceSerialStored: false,
      rawBuildFingerprintStored: false, rawPnpIdentifierStored: false, rawCameraDeviceNameStored: false,
      localPathStored: false, networkIdentifierStored: false, credentialStored: false,
    },
  };
}

function record(scenario, opts = {}) {
  const bytes = opts.bytes ?? 65536;
  return finalizeEvidence(prep(scenario, bytes), completion({ ...opts, bytes }), { authoritative: true });
}

function allRecords() {
  return [
    record('fqr2-windows-to-android'),
    record('fqr2-android-to-windows', { sender: 'android', receiver: 'windows' }),
    record('fqr1-windows-to-android'),
    record('fqr1-android-to-windows', { sender: 'android', receiver: 'windows' }),
    record('fqr2-mid-cycle', { joinedMidCycle: true }),
    record('fqr2-repair-phase', { repairPhaseOnlyStart: true, framesIntentionallyMissed: true }),
    record('fqr2-large-file', { bytes: 8 * 1024 * 1024 + 1 }),
    record('fqr2-interruption-resume', { interruptionPerformed: true, resumeObserved: true }),
  ];
}

function writeRecords(root, records) {
  return records.map((value, index) => {
    const file = path.join(root, `evidence-${index}.json`);
    fs.writeFileSync(file, JSON.stringify(value));
    return file;
  });
}

test('summary writer publishes a deterministic complete matrix without input paths', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fileqr-summary-'));
  const inputs = writeRecords(root, allRecords());
  const output = path.join(root, 'summary.json');
  const summary = writeEvidenceSummary({ evidencePaths: inputs, outputPath: output });
  assert.equal(summary.matrixComplete, true);
  assert.deepEqual(summary.missing, []);
  assert.deepEqual(JSON.parse(fs.readFileSync(output, 'utf8')), summary);
  const json = fs.readFileSync(output, 'utf8');
  assert.doesNotMatch(json, /evidence-\d+\.json|fileqr-summary-/);
});

test('incomplete matrix is written truthfully and then fails closed', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fileqr-summary-'));
  const inputs = writeRecords(root, allRecords().slice(0, -1));
  const output = path.join(root, 'summary.json');
  assert.throws(
    () => writeEvidenceSummary({ evidencePaths: inputs, outputPath: output }),
    /FQR_EVIDENCE_MATRIX_INCOMPLETE/,
  );
  const summary = JSON.parse(fs.readFileSync(output, 'utf8'));
  assert.equal(summary.matrixComplete, false);
  assert.deepEqual(summary.missing, ['fqr2-interruption-resume']);
});

test('malformed evidence never produces a summary artifact', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fileqr-summary-'));
  const bad = path.join(root, 'bad.json');
  const output = path.join(root, 'summary.json');
  fs.writeFileSync(bad, '{bad');
  assert.throws(() => writeEvidenceSummary({ evidencePaths: [bad], outputPath: output }), /FQR_EVIDENCE_MATRIX_INPUT/);
  assert.equal(fs.existsSync(output), false);
  assert.equal(fs.existsSync(`${output}.tmp`), false);
});
