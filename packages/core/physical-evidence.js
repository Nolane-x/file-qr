import { createHash } from 'node:crypto';

export const SCHEMA_VERSION = 1;
export const SCENARIOS = Object.freeze([
  'fqr2-windows-to-android',
  'fqr2-android-to-windows',
  'fqr1-windows-to-android',
  'fqr1-android-to-windows',
  'fqr2-mid-cycle',
  'fqr2-repair-phase',
  'fqr2-large-file',
  'fqr2-interruption-resume',
]);

const REPOSITORY = 'Nolane-x/file-qr';
const WORKFLOW = 'Native Builds';
const FQR2_MAX_BYTES = 64 * 1024 * 1024;
const FQR1_MAX_BYTES = 8 * 1024 * 1024;
const FQR2_BLOCK_BYTES = 65536;
const SHA40 = /^[a-f0-9]{40}$/;
const SHA64 = /^[a-f0-9]{64}$/;
const DIGEST = /^sha256:[a-f0-9]{64}$/;
const ID24 = /^[a-f0-9]{24}$/;

function fail(code, message) {
  const error = new Error(`${code}: ${message}`);
  error.code = code;
  throw error;
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function object(value, code, label) {
  if (!isObject(value)) fail(code, `${label} must be an object`);
  return value;
}

function exactKeys(value, allowed, label) {
  object(value, 'FQR_EVIDENCE_SCHEMA', label);
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) fail('FQR_EVIDENCE_UNKNOWN_KEY', `${label}.${key}`);
  }
  for (const key of allowed) {
    if (!(key in value)) fail('FQR_EVIDENCE_SCHEMA', `${label}.${key} is required`);
  }
}

function exactKeysOptional(value, required, optional, label) {
  object(value, 'FQR_EVIDENCE_SCHEMA', label);
  const allowed = [...required, ...optional];
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) fail('FQR_EVIDENCE_UNKNOWN_KEY', `${label}.${key}`);
  }
  for (const key of required) {
    if (!(key in value)) fail('FQR_EVIDENCE_SCHEMA', `${label}.${key} is required`);
  }
}

function str(value, label) {
  if (typeof value !== 'string' || value.length === 0) fail('FQR_EVIDENCE_SCHEMA', `${label} must be a non-empty string`);
  return value;
}

function bool(value, label) {
  if (typeof value !== 'boolean') fail('FQR_EVIDENCE_SCHEMA', `${label} must be boolean`);
  return value;
}

function posInt(value, label, { allowZero = false } = {}) {
  if (!Number.isSafeInteger(value) || value < (allowZero ? 0 : 1)) {
    fail('FQR_EVIDENCE_SCHEMA', `${label} must be ${allowZero ? 'a non-negative' : 'a positive'} integer`);
  }
  return value;
}

function sha40(value, label) {
  if (typeof value !== 'string' || !SHA40.test(value)) fail('FQR_EVIDENCE_SHA', `${label} must be lowercase 40-hex`);
  return value;
}

function sha64(value, label) {
  if (typeof value !== 'string' || !SHA64.test(value)) fail('FQR_EVIDENCE_SHA', `${label} must be lowercase 64-hex`);
  return value;
}

function digest(value, label) {
  if (typeof value !== 'string' || !DIGEST.test(value)) fail('FQR_EVIDENCE_ARTIFACT', `${label} must be sha256:<64-hex>`);
  return value;
}

function iso(value, label) {
  if (typeof value !== 'string' || Number.isNaN(Date.parse(value)) || new Date(value).toISOString() !== value) {
    fail('FQR_EVIDENCE_TIME', `${label} must be canonical ISO-8601 UTC`);
  }
  return value;
}

function normalizeArtifact(input, platform) {
  exactKeys(input, ['artifactId', 'name', 'artifactDigest', 'binarySha256'], `build.artifacts.${platform}`);
  const expectedName = platform === 'windows' ? 'file-qr-windows' : 'file-qr-android';
  if (input.name !== expectedName) fail('FQR_EVIDENCE_ARTIFACT', `${platform} artifact name must be ${expectedName}`);
  return {
    artifactId: posInt(input.artifactId, `build.artifacts.${platform}.artifactId`),
    name: expectedName,
    artifactDigest: digest(input.artifactDigest, `build.artifacts.${platform}.artifactDigest`),
    binarySha256: sha64(input.binarySha256, `build.artifacts.${platform}.binarySha256`),
  };
}

function normalizePreparation(input, { authoritative = true, verifyCeremonyId = true } = {}) {
  exactKeysOptional(
    input,
    ['schemaVersion', 'scenario', 'control', 'build', 'payload', 'protocol', 'startedAt'],
    ['ceremonyId'],
    'preparation',
  );
  if (input.schemaVersion !== SCHEMA_VERSION) fail('FQR_EVIDENCE_SCHEMA', 'unsupported schemaVersion');
  if (!SCENARIOS.includes(input.scenario)) fail('FQR_EVIDENCE_SCENARIO', 'unsupported scenario');

  exactKeys(input.control, ['repository', 'commitSha'], 'control');
  const control = {
    repository: str(input.control.repository, 'control.repository'),
    commitSha: sha40(input.control.commitSha, 'control.commitSha'),
  };

  exactKeys(input.build, ['repository', 'workflow', 'workflowRunId', 'event', 'headBranch', 'commitSha', 'artifacts'], 'build');
  exactKeys(input.build.artifacts, ['windows', 'android'], 'build.artifacts');
  const build = {
    repository: str(input.build.repository, 'build.repository'),
    workflow: str(input.build.workflow, 'build.workflow'),
    workflowRunId: posInt(input.build.workflowRunId, 'build.workflowRunId'),
    event: str(input.build.event, 'build.event'),
    headBranch: str(input.build.headBranch, 'build.headBranch'),
    commitSha: sha40(input.build.commitSha, 'build.commitSha'),
    artifacts: {
      windows: normalizeArtifact(input.build.artifacts.windows, 'windows'),
      android: normalizeArtifact(input.build.artifacts.android, 'android'),
    },
  };

  exactKeys(input.payload, ['generated', 'generatorVersion', 'bytes', 'sourceSha256'], 'payload');
  const payload = {
    generated: bool(input.payload.generated, 'payload.generated'),
    generatorVersion: posInt(input.payload.generatorVersion, 'payload.generatorVersion'),
    bytes: posInt(input.payload.bytes, 'payload.bytes'),
    sourceSha256: sha64(input.payload.sourceSha256, 'payload.sourceSha256'),
  };

  exactKeys(input.protocol, ['version', 'blockBytes', 'symbolBytes'], 'protocol');
  const version = str(input.protocol.version, 'protocol.version');
  const expectedVersion = input.scenario.startsWith('fqr1-') ? 'FQR1' : 'FQR2';
  if (version !== expectedVersion) fail('FQR_EVIDENCE_PROTOCOL', `${input.scenario} requires ${expectedVersion}`);
  let protocol;
  if (version === 'FQR2') {
    if (input.protocol.blockBytes !== FQR2_BLOCK_BYTES) fail('FQR_EVIDENCE_PROTOCOL', 'FQR2 blockBytes must be 65536');
    const symbolBytes = posInt(input.protocol.symbolBytes, 'protocol.symbolBytes');
    if (symbolBytes < 256 || symbolBytes > 900) fail('FQR_EVIDENCE_PROTOCOL', 'FQR2 symbolBytes must be 256..900');
    if (payload.bytes > FQR2_MAX_BYTES) fail('FQR_EVIDENCE_PROTOCOL', 'FQR2 payload exceeds 64 MiB evidence cap');
    protocol = { version, blockBytes: FQR2_BLOCK_BYTES, symbolBytes };
  } else if (version === 'FQR1') {
    if (input.protocol.blockBytes !== null || input.protocol.symbolBytes !== null) {
      fail('FQR_EVIDENCE_PROTOCOL', 'FQR1 evidence geometry fields must be null');
    }
    if (payload.bytes > FQR1_MAX_BYTES) fail('FQR_EVIDENCE_PROTOCOL', 'FQR1 payload exceeds 8 MiB compatibility cap');
    protocol = { version, blockBytes: null, symbolBytes: null };
  } else {
    fail('FQR_EVIDENCE_PROTOCOL', 'unsupported protocol version');
  }

  const startedAt = iso(input.startedAt, 'startedAt');

  if (authoritative) {
    if (
      control.repository !== REPOSITORY ||
      build.repository !== REPOSITORY ||
      build.workflow !== WORKFLOW ||
      build.headBranch !== 'main' ||
      build.event !== 'push' ||
      build.commitSha !== control.commitSha ||
      payload.generated !== true
    ) {
      fail('FQR_EVIDENCE_BUILD_AUTHORITY', 'authoritative preparation must bind generated payload to one trusted-main Native Builds push');
    }
  }

  const normalized = {
    schemaVersion: SCHEMA_VERSION,
    scenario: input.scenario,
    control,
    build,
    payload,
    protocol,
    startedAt,
  };

  if ('ceremonyId' in input) {
    if (typeof input.ceremonyId !== 'string' || !ID24.test(input.ceremonyId)) {
      fail('FQR_EVIDENCE_SCHEMA', 'ceremonyId must be lowercase 24-hex');
    }
    normalized.ceremonyId = input.ceremonyId;
    if (verifyCeremonyId && deriveCeremonyId(normalized) !== input.ceremonyId) {
      fail('FQR_EVIDENCE_CEREMONY_ID', 'ceremonyId does not match preparation authority fields');
    }
  }
  return normalized;
}

export function canonicalizePreparation(input) {
  return normalizePreparation(input, { authoritative: false });
}

export function validatePreparation(input, { authoritative = true } = {}) {
  return normalizePreparation(input, { authoritative });
}

export function deriveCeremonyId(input) {
  const p = normalizePreparation(input, { authoritative: false, verifyCeremonyId: false });
  const identity = [
    p.schemaVersion,
    p.control.commitSha,
    p.build.commitSha,
    p.build.workflowRunId,
    p.scenario,
    p.build.artifacts.windows.binarySha256,
    p.build.artifacts.android.binarySha256,
    p.payload.sourceSha256,
    p.startedAt,
  ].join('\n');
  return createHash('sha256').update(identity, 'utf8').digest('hex').slice(0, 24);
}

function normalizePlatform(input, label) {
  exactKeysOptional(
    input,
    ['platform', 'osClass', 'deviceClass'],
    ['cameraDevicePresent', 'cameraDeviceCount', 'physicalDevice', 'emulatorRejected', 'cameraPermissionGranted', 'cameraOwnerObserved'],
    label,
  );
  const platform = str(input.platform, `${label}.platform`);
  if (platform !== 'windows' && platform !== 'android') fail('FQR_EVIDENCE_SCENARIO', `${label}.platform must be windows or android`);
  const out = {
    platform,
    osClass: str(input.osClass, `${label}.osClass`),
    deviceClass: str(input.deviceClass, `${label}.deviceClass`),
  };
  if (platform === 'windows') {
    if ('physicalDevice' in input || 'emulatorRejected' in input || 'cameraPermissionGranted' in input || 'cameraOwnerObserved' in input) {
      fail('FQR_EVIDENCE_UNKNOWN_KEY', `${label} has Android-only fields`);
    }
    out.cameraDevicePresent = bool(input.cameraDevicePresent, `${label}.cameraDevicePresent`);
    out.cameraDeviceCount = posInt(input.cameraDeviceCount, `${label}.cameraDeviceCount`, { allowZero: true });
    if (out.cameraDevicePresent !== (out.cameraDeviceCount > 0)) {
      fail('FQR_EVIDENCE_HARDWARE', `${label} camera presence/count conflict`);
    }
  } else {
    if ('cameraDevicePresent' in input || 'cameraDeviceCount' in input) {
      fail('FQR_EVIDENCE_UNKNOWN_KEY', `${label} has Windows-only fields`);
    }
    out.physicalDevice = bool(input.physicalDevice, `${label}.physicalDevice`);
    out.emulatorRejected = bool(input.emulatorRejected, `${label}.emulatorRejected`);
    out.cameraPermissionGranted = bool(input.cameraPermissionGranted, `${label}.cameraPermissionGranted`);
    out.cameraOwnerObserved = bool(input.cameraOwnerObserved, `${label}.cameraOwnerObserved`);
  }
  return out;
}

function normalizeCompletion(input) {
  exactKeys(input, ['sender', 'receiver', 'operatorObservations', 'received', 'completedAt', 'measurements', 'privacy'], 'completion');
  const sender = normalizePlatform(input.sender, 'sender');
  const receiver = normalizePlatform(input.receiver, 'receiver');
  if (sender.platform === receiver.platform) fail('FQR_EVIDENCE_SCENARIO', 'sender and receiver must be different platform classes');

  exactKeys(input.operatorObservations, [
    'physicalDisplayToCameraPath',
    'virtualCameraAbsent',
    'joinedMidCycle',
    'repairPhaseOnlyStart',
    'framesIntentionallyMissed',
    'interruptionPerformed',
    'resumeObserved',
  ], 'operatorObservations');
  const operatorObservations = {};
  for (const key of Object.keys(input.operatorObservations)) {
    operatorObservations[key] = bool(input.operatorObservations[key], `operatorObservations.${key}`);
  }

  exactKeys(input.received, ['bytes', 'sha256'], 'received');
  const received = {
    bytes: posInt(input.received.bytes, 'received.bytes'),
    sha256: sha64(input.received.sha256, 'received.sha256'),
  };

  exactKeys(input.measurements, ['wallClockMs', 'observedCycles'], 'measurements');
  const wallClockMs = posInt(input.measurements.wallClockMs, 'measurements.wallClockMs', { allowZero: true });
  const observedCycles = input.measurements.observedCycles === null
    ? null
    : posInt(input.measurements.observedCycles, 'measurements.observedCycles', { allowZero: true });

  exactKeys(input.privacy, [
    'cameraImageryCaptured',
    'personalPayloadUsed',
    'rawDeviceSerialStored',
    'rawBuildFingerprintStored',
    'rawPnpIdentifierStored',
    'rawCameraDeviceNameStored',
    'localPathStored',
    'networkIdentifierStored',
    'credentialStored',
  ], 'privacy');
  const privacy = {};
  for (const key of Object.keys(input.privacy)) privacy[key] = bool(input.privacy[key], `privacy.${key}`);

  return {
    sender,
    receiver,
    operatorObservations,
    received,
    completedAt: iso(input.completedAt, 'completedAt'),
    measurements: { wallClockMs, observedCycles },
    privacy,
  };
}

function receiverHardwareOk(receiver) {
  if (receiver.platform === 'android') {
    return receiver.physicalDevice === true &&
      receiver.emulatorRejected === true &&
      receiver.cameraPermissionGranted === true &&
      receiver.cameraOwnerObserved === true;
  }
  return receiver.cameraDevicePresent === true && receiver.cameraDeviceCount > 0;
}

function directionOk(scenario, sender, receiver) {
  if (scenario === 'fqr2-windows-to-android' || scenario === 'fqr1-windows-to-android') {
    return sender.platform === 'windows' && receiver.platform === 'android';
  }
  if (scenario === 'fqr2-android-to-windows' || scenario === 'fqr1-android-to-windows') {
    return sender.platform === 'android' && receiver.platform === 'windows';
  }
  return sender.platform !== receiver.platform && new Set([sender.platform, receiver.platform]).size === 2;
}

function scenarioClaim(scenario, p, c) {
  if (!directionOk(scenario, c.sender, c.receiver)) return false;
  switch (scenario) {
    case 'fqr2-mid-cycle':
      return c.operatorObservations.joinedMidCycle === true;
    case 'fqr2-repair-phase':
      return p.payload.bytes <= FQR2_BLOCK_BYTES &&
        c.operatorObservations.repairPhaseOnlyStart === true &&
        c.operatorObservations.framesIntentionallyMissed === true;
    case 'fqr2-large-file':
      return p.payload.bytes > FQR1_MAX_BYTES;
    case 'fqr2-interruption-resume':
      return c.operatorObservations.interruptionPerformed === true && c.operatorObservations.resumeObserved === true;
    default:
      return true;
  }
}

export function finalizeEvidence(preparation, completion, { authoritative = true } = {}) {
  const p = normalizePreparation(preparation, { authoritative });
  const c = normalizeCompletion(completion);
  const startedMs = Date.parse(p.startedAt);
  const completedMs = Date.parse(c.completedAt);
  if (completedMs < startedMs || c.measurements.wallClockMs !== completedMs - startedMs) {
    fail('FQR_EVIDENCE_TIME', 'completion timestamp/wallClockMs contradict preparation start');
  }

  const ceremonyId = p.ceremonyId ?? deriveCeremonyId(p);
  const exactBytesMatch = p.payload.bytes === c.received.bytes && p.payload.sourceSha256 === c.received.sha256;
  const privacyContractComplete = Object.values(c.privacy).every((value) => value === false);
  const receiverHardwarePrerequisitesComplete = receiverHardwareOk(c.receiver);
  const physicalPathComplete = c.operatorObservations.physicalDisplayToCameraPath === true && c.operatorObservations.virtualCameraAbsent === true;
  const scenarioClaimComplete = scenarioClaim(p.scenario, p, c);
  const buildBindingComplete = !authoritative || (
    p.control.repository === REPOSITORY &&
    p.build.repository === REPOSITORY &&
    p.build.workflow === WORKFLOW &&
    p.build.headBranch === 'main' &&
    p.build.event === 'push' &&
    p.build.commitSha === p.control.commitSha
  );

  const assertions = {
    buildBindingComplete,
    exactBytesMatch,
    privacyContractComplete,
    receiverHardwarePrerequisitesComplete,
    physicalPathComplete,
    scenarioClaimComplete,
    midCycleJoinClaimComplete: p.scenario !== 'fqr2-mid-cycle' || c.operatorObservations.joinedMidCycle === true,
    repairPhaseClaimComplete: p.scenario !== 'fqr2-repair-phase' || (
      p.payload.bytes <= FQR2_BLOCK_BYTES &&
      c.operatorObservations.repairPhaseOnlyStart === true &&
      c.operatorObservations.framesIntentionallyMissed === true
    ),
    largeFileClaimComplete: p.scenario !== 'fqr2-large-file' || p.payload.bytes > FQR1_MAX_BYTES,
    resumeClaimComplete: p.scenario !== 'fqr2-interruption-resume' || (
      c.operatorObservations.interruptionPerformed === true && c.operatorObservations.resumeObserved === true
    ),
  };
  const result = Object.values(assertions).every(Boolean) ? 'PASS' : 'FAIL';

  return {
    schemaVersion: SCHEMA_VERSION,
    ceremonyId,
    scenario: p.scenario,
    authoritative: Boolean(authoritative),
    control: p.control,
    build: p.build,
    payload: {
      ...p.payload,
      receivedBytes: c.received.bytes,
      receivedSha256: c.received.sha256,
    },
    protocol: p.protocol,
    sender: c.sender,
    receiver: c.receiver,
    operatorObservations: c.operatorObservations,
    measurements: {
      startedAt: p.startedAt,
      completedAt: c.completedAt,
      wallClockMs: c.measurements.wallClockMs,
      observedCycles: c.measurements.observedCycles,
    },
    privacy: c.privacy,
    assertions,
    result,
  };
}

export function validateFinalRecord(record, { authoritative = true } = {}) {
  exactKeys(record, [
    'schemaVersion', 'ceremonyId', 'scenario', 'authoritative', 'control', 'build', 'payload', 'protocol',
    'sender', 'receiver', 'operatorObservations', 'measurements', 'privacy', 'assertions', 'result',
  ], 'record');
  if (typeof record.authoritative !== 'boolean') fail('FQR_EVIDENCE_SCHEMA', 'record.authoritative must be boolean');
  if (authoritative && record.authoritative !== true) fail('FQR_EVIDENCE_BUILD_AUTHORITY', 'non-authoritative record cannot satisfy authoritative validation');

  exactKeys(record.payload, ['generated', 'generatorVersion', 'bytes', 'sourceSha256', 'receivedBytes', 'receivedSha256'], 'record.payload');
  exactKeys(record.measurements, ['startedAt', 'completedAt', 'wallClockMs', 'observedCycles'], 'record.measurements');
  const preparation = {
    schemaVersion: record.schemaVersion,
    ceremonyId: record.ceremonyId,
    scenario: record.scenario,
    control: record.control,
    build: record.build,
    payload: {
      generated: record.payload.generated,
      generatorVersion: record.payload.generatorVersion,
      bytes: record.payload.bytes,
      sourceSha256: record.payload.sourceSha256,
    },
    protocol: record.protocol,
    startedAt: record.measurements.startedAt,
  };
  const completion = {
    sender: record.sender,
    receiver: record.receiver,
    operatorObservations: record.operatorObservations,
    received: { bytes: record.payload.receivedBytes, sha256: record.payload.receivedSha256 },
    completedAt: record.measurements.completedAt,
    measurements: { wallClockMs: record.measurements.wallClockMs, observedCycles: record.measurements.observedCycles },
    privacy: record.privacy,
  };
  const expected = finalizeEvidence(preparation, completion, { authoritative: record.authoritative });
  if (JSON.stringify(expected.assertions) !== JSON.stringify(record.assertions) || expected.result !== record.result) {
    fail('FQR_EVIDENCE_FINAL_TAMPER', 'assertions/result do not match derived evidence');
  }
  if (authoritative && expected.result !== record.result) fail('FQR_EVIDENCE_FINAL_TAMPER', 'record result mismatch');
  return expected;
}

export function summarizeEvidenceMatrix(records) {
  if (!Array.isArray(records) || records.length === 0) fail('FQR_EVIDENCE_MATRIX', 'records must be a non-empty array');
  const validated = records.map((record) => validateFinalRecord(record, { authoritative: true }));
  const first = validated[0].build;
  const lineage = JSON.stringify({
    workflowRunId: first.workflowRunId,
    commitSha: first.commitSha,
    windows: first.artifacts.windows,
    android: first.artifacts.android,
  });
  for (const record of validated.slice(1)) {
    const current = JSON.stringify({
      workflowRunId: record.build.workflowRunId,
      commitSha: record.build.commitSha,
      windows: record.build.artifacts.windows,
      android: record.build.artifacts.android,
    });
    if (current !== lineage) fail('FQR_EVIDENCE_MATRIX_BUILD', 'matrix records do not share one exact build/artifact lineage');
  }

  const seen = new Map();
  for (const record of validated) {
    const serialized = JSON.stringify(record);
    if (seen.has(record.ceremonyId) && seen.get(record.ceremonyId) !== serialized) {
      fail('FQR_EVIDENCE_MATRIX', 'conflicting duplicate ceremonyId');
    }
    seen.set(record.ceremonyId, serialized);
  }

  const passing = validated.filter((record) => record.result === 'PASS');
  const covered = SCENARIOS.filter((scenario) => passing.some((record) => record.scenario === scenario));
  const missing = SCENARIOS.filter((scenario) => !covered.includes(scenario));
  return {
    schemaVersion: SCHEMA_VERSION,
    build: {
      workflowRunId: first.workflowRunId,
      commitSha: first.commitSha,
      artifacts: {
        windows: first.artifacts.windows,
        android: first.artifacts.android,
      },
    },
    matrixComplete: missing.length === 0,
    covered,
    missing,
    recordIds: [...new Set(passing.map((record) => record.ceremonyId))].sort(),
  };
}
