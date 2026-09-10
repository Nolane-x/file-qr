import test from 'node:test';
import assert from 'node:assert/strict';
import {
  SCHEMA_VERSION, SCENARIOS, canonicalizePreparation, deriveCeremonyId,
  validatePreparation, finalizeEvidence, validateFinalRecord, summarizeEvidenceMatrix,
} from '../../packages/core/physical-evidence.js';

const SHA = 'a'.repeat(40);
const H1 = '1'.repeat(64);
const H2 = '2'.repeat(64);
const H3 = '3'.repeat(64);

function prep({ scenario = 'fqr2-windows-to-android', bytes = 65536, protocol = 'FQR2', runId = 123 } = {}) {
  return {
    schemaVersion: 1,
    scenario,
    control: { repository: 'Nolane-x/file-qr', commitSha: SHA },
    build: {
      repository: 'Nolane-x/file-qr', workflow: 'Native Builds', workflowRunId: runId,
      event: 'push', headBranch: 'main', commitSha: SHA,
      artifacts: {
        windows: { artifactId: 10, name: 'file-qr-windows', artifactDigest: `sha256:${H1}`, binarySha256: H2 },
        android: { artifactId: 11, name: 'file-qr-android', artifactDigest: `sha256:${H2}`, binarySha256: H3 },
      },
    },
    payload: { generated: true, generatorVersion: 1, bytes, sourceSha256: H1 },
    protocol: protocol === 'FQR2'
      ? { version: 'FQR2', blockBytes: 65536, symbolBytes: 768 }
      : { version: 'FQR1', blockBytes: null, symbolBytes: null },
    startedAt: '2026-09-10T12:00:00.000Z',
  };
}

function completion({ sender = 'windows', receiver = 'android', receivedBytes = 65536, receivedSha256 = H1,
  joinedMidCycle = false, repairPhaseOnlyStart = false, framesIntentionallyMissed = false,
  interruptionPerformed = false, resumeObserved = false } = {}) {
  return {
    sender: {
      platform: sender, osClass: sender === 'windows' ? 'Windows 11' : 'Android 16',
      deviceClass: sender === 'windows' ? 'desktop' : 'phone',
      ...(sender === 'windows'
        ? { cameraDevicePresent: false, cameraDeviceCount: 0 }
        : { physicalDevice: true, emulatorRejected: true, cameraPermissionGranted: true, cameraOwnerObserved: false }),
    },
    receiver: {
      platform: receiver, osClass: receiver === 'windows' ? 'Windows 11' : 'Android 16',
      deviceClass: receiver === 'windows' ? 'desktop-webcam' : 'phone-rear-camera',
      ...(receiver === 'windows'
        ? { cameraDevicePresent: true, cameraDeviceCount: 1 }
        : { physicalDevice: true, emulatorRejected: true, cameraPermissionGranted: true, cameraOwnerObserved: true }),
    },
    operatorObservations: {
      physicalDisplayToCameraPath: true, virtualCameraAbsent: true, joinedMidCycle,
      repairPhaseOnlyStart, framesIntentionallyMissed, interruptionPerformed, resumeObserved,
    },
    received: { bytes: receivedBytes, sha256: receivedSha256 },
    completedAt: '2026-09-10T12:01:00.000Z',
    measurements: { wallClockMs: 60000, observedCycles: null },
    privacy: {
      cameraImageryCaptured: false, personalPayloadUsed: false, rawDeviceSerialStored: false,
      rawBuildFingerprintStored: false, rawPnpIdentifierStored: false, rawCameraDeviceNameStored: false,
      localPathStored: false, networkIdentifierStored: false, credentialStored: false,
    },
  };
}

function finalFor(scenario, opts = {}) {
  return finalizeEvidence(prep({
    scenario, bytes: opts.bytes ?? 65536,
    protocol: scenario.startsWith('fqr1-') ? 'FQR1' : 'FQR2', runId: opts.runId ?? 123,
  }), completion(opts), { authoritative: true });
}

test('exports exact schema version and required scenario set', () => {
  assert.equal(SCHEMA_VERSION, 1);
  assert.deepEqual([...SCENARIOS], [
    'fqr2-windows-to-android', 'fqr2-android-to-windows',
    'fqr1-windows-to-android', 'fqr1-android-to-windows',
    'fqr2-mid-cycle', 'fqr2-repair-phase', 'fqr2-large-file', 'fqr2-interruption-resume',
  ]);
});

test('preparation canonicalization is strict and stable', () => {
  const p = prep();
  assert.deepEqual(canonicalizePreparation({ ...p }), validatePreparation(p, { authoritative: true }));
  assert.throws(() => validatePreparation({ ...p, bypass: true }, { authoritative: true }), /FQR_EVIDENCE_UNKNOWN_KEY/);
  assert.throws(() => validatePreparation({ ...p, control: { ...p.control, commitSha: 'ABC' } }, { authoritative: true }), /FQR_EVIDENCE_SHA/);
});

test('authoritative preparation rejects non-main, PR, wrong workflow and missing platform artifact', () => {
  const p = prep();
  assert.throws(() => validatePreparation({ ...p, build: { ...p.build, headBranch: 'feature' } }, { authoritative: true }), /FQR_EVIDENCE_BUILD_AUTHORITY/);
  assert.throws(() => validatePreparation({ ...p, build: { ...p.build, event: 'pull_request' } }, { authoritative: true }), /FQR_EVIDENCE_BUILD_AUTHORITY/);
  assert.throws(() => validatePreparation({ ...p, build: { ...p.build, workflow: 'CI' } }, { authoritative: true }), /FQR_EVIDENCE_BUILD_AUTHORITY/);
  assert.throws(() => validatePreparation({ ...p, build: { ...p.build, artifacts: { windows: p.build.artifacts.windows } } }, { authoritative: true }), /FQR_EVIDENCE_SCHEMA/);
});

test('ceremony id is a fixed independent vector', () => {
  assert.equal(deriveCeremonyId(prep()), '1b713e828cb5e75b9cfe0c7c');
});

test('baseline Windows to Android needs exact bytes and Android camera ownership', () => {
  const record = finalFor('fqr2-windows-to-android');
  assert.equal(record.result, 'PASS');
  assert.equal(validateFinalRecord(record, { authoritative: true }).result, 'PASS');
  assert.equal(finalizeEvidence(prep(), completion({ receivedSha256: H2 }), { authoritative: true }).result, 'FAIL');
  const missingOwner = completion();
  missingOwner.receiver.cameraOwnerObserved = false;
  assert.equal(finalizeEvidence(prep(), missingOwner, { authoritative: true }).result, 'FAIL');
});

test('Android to Windows needs Windows camera presence', () => {
  const p = prep({ scenario: 'fqr2-android-to-windows' });
  assert.equal(finalizeEvidence(p, completion({ sender: 'android', receiver: 'windows' }), { authoritative: true }).result, 'PASS');
  const noCamera = completion({ sender: 'android', receiver: 'windows' });
  noCamera.receiver.cameraDevicePresent = false;
  noCamera.receiver.cameraDeviceCount = 0;
  assert.equal(finalizeEvidence(p, noCamera, { authoritative: true }).result, 'FAIL');
});

test('special FQR2 scenario boundaries are exact', () => {
  assert.equal(finalFor('fqr2-mid-cycle', { joinedMidCycle: true }).result, 'PASS');
  assert.equal(finalFor('fqr2-mid-cycle').result, 'FAIL');
  assert.equal(finalFor('fqr2-repair-phase', { repairPhaseOnlyStart: true, framesIntentionallyMissed: true }).result, 'PASS');
  assert.equal(finalFor('fqr2-repair-phase', { repairPhaseOnlyStart: true, bytes: 65537 }).result, 'FAIL');
  assert.equal(finalFor('fqr2-large-file', { bytes: 8 * 1024 * 1024 + 1, receivedBytes: 8 * 1024 * 1024 + 1 }).result, 'PASS');
  assert.equal(finalFor('fqr2-large-file', { bytes: 8 * 1024 * 1024, receivedBytes: 8 * 1024 * 1024 }).result, 'FAIL');
  assert.equal(finalFor('fqr2-interruption-resume', { interruptionPerformed: true, resumeObserved: true }).result, 'PASS');
  assert.equal(finalFor('fqr2-interruption-resume', { interruptionPerformed: true }).result, 'FAIL');
});

test('FQR1 compatibility stays separate', () => {
  assert.equal(finalFor('fqr1-windows-to-android').result, 'PASS');
  assert.equal(finalFor('fqr1-android-to-windows', { sender: 'android', receiver: 'windows' }).result, 'PASS');
  assert.throws(() => validatePreparation(prep({ scenario: 'fqr1-windows-to-android', protocol: 'FQR2' }), { authoritative: true }), /FQR_EVIDENCE_PROTOCOL/);
});

test('privacy and unknown completion fields fail closed', () => {
  const leaked = completion();
  leaked.privacy.rawDeviceSerialStored = true;
  assert.equal(finalizeEvidence(prep(), leaked, { authoritative: true }).result, 'FAIL');
  const injected = completion();
  injected.guaranteedThroughputMbps = 500;
  assert.throws(() => finalizeEvidence(prep(), injected, { authoritative: true }), /FQR_EVIDENCE_UNKNOWN_KEY/);
});

test('timestamp ordering and final-record authority are validated', () => {
  const c = completion();
  c.completedAt = '2026-09-10T11:59:59.000Z';
  assert.throws(() => finalizeEvidence(prep(), c, { authoritative: true }), /FQR_EVIDENCE_TIME/);
  const mutated = structuredClone(finalFor('fqr2-windows-to-android'));
  mutated.build.commitSha = 'b'.repeat(40);
  assert.throws(() => validateFinalRecord(mutated, { authoritative: true }), /FQR_EVIDENCE_/);
});

test('matrix requires one internally valid exact build lineage and every Issue #50 category', () => {
  const records = [
    finalFor('fqr2-windows-to-android'),
    finalFor('fqr2-android-to-windows', { sender: 'android', receiver: 'windows' }),
    finalFor('fqr1-windows-to-android'),
    finalFor('fqr1-android-to-windows', { sender: 'android', receiver: 'windows' }),
    finalFor('fqr2-mid-cycle', { joinedMidCycle: true }),
    finalFor('fqr2-repair-phase', { repairPhaseOnlyStart: true, framesIntentionallyMissed: true }),
    finalFor('fqr2-large-file', { bytes: 8 * 1024 * 1024 + 1, receivedBytes: 8 * 1024 * 1024 + 1 }),
    finalFor('fqr2-interruption-resume', { interruptionPerformed: true, resumeObserved: true }),
  ];
  assert.equal(summarizeEvidenceMatrix(records).matrixComplete, true);
  assert.deepEqual(summarizeEvidenceMatrix(records.slice(0, -1)).missing, ['fqr2-interruption-resume']);
  const mixed = [...records];
  mixed[1] = finalFor('fqr2-android-to-windows', { sender: 'android', receiver: 'windows', runId: 124 });
  assert.throws(() => summarizeEvidenceMatrix(mixed), /FQR_EVIDENCE_MATRIX_BUILD/);
});
