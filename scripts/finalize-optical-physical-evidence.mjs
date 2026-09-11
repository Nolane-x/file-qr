import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { finalizeEvidence, validatePreparation } from '../packages/core/physical-evidence.js';

function fail(code, message) {
  const error = new Error(`${code}: ${message}`);
  error.code = code;
  throw error;
}

function readJson(filePath, label) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    fail('FQR_EVIDENCE_FINAL_INPUT', `${label} is missing or invalid JSON`);
  }
}

function exactKeys(value, keys, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('FQR_EVIDENCE_FINAL_INPUT', `${label} must be an object`);
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) fail('FQR_EVIDENCE_FINAL_INPUT', `${label} keys are invalid`);
}

async function hashFile(filePath) {
  let stat;
  try {
    stat = fs.statSync(filePath);
  } catch {
    fail('FQR_EVIDENCE_FILE', 'received file not found');
  }
  if (!stat.isFile() || stat.size < 1) fail('FQR_EVIDENCE_FILE', 'received path must be a non-empty file');
  const hash = createHash('sha256');
  await new Promise((resolve, reject) => {
    const stream = fs.createReadStream(filePath);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('error', reject);
    stream.on('end', resolve);
  });
  return { bytes: stat.size, sha256: hash.digest('hex') };
}

function atomicWriteJson(outputPath, value) {
  const tmp = `${outputPath}.tmp`;
  fs.mkdirSync(path.dirname(outputPath), { recursive: true, mode: 0o700 });
  let fd;
  try {
    fd = fs.openSync(tmp, 'wx', 0o600);
    fs.writeFileSync(fd, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    fs.renameSync(tmp, outputPath);
  } catch (error) {
    if (fd !== undefined) {
      try { fs.closeSync(fd); } catch {}
    }
    try { fs.rmSync(tmp, { force: true }); } catch {}
    fail('FQR_EVIDENCE_FINAL_WRITE', error?.message || 'could not publish evidence');
  }
}

export async function finalizeCeremony({
  preparationPath,
  receivedPath,
  platformFactsPath,
  observationsPath,
  outputPath,
  now = () => new Date(),
} = {}) {
  const rawPreparation = readJson(preparationPath, 'preparation');
  const preparation = validatePreparation(rawPreparation, { authoritative: true });
  if (!preparation.ceremonyId) fail('FQR_EVIDENCE_CEREMONY_ID', 'preparation must contain ceremonyId');

  const facts = readJson(platformFactsPath, 'platform facts');
  exactKeys(facts, ['sender', 'receiver'], 'platform facts');
  const observations = readJson(observationsPath, 'operator observations');
  exactKeys(observations, [
    'physicalDisplayToCameraPath', 'virtualCameraAbsent', 'joinedMidCycle',
    'repairPhaseOnlyStart', 'framesIntentionallyMissed', 'interruptionPerformed',
    'resumeObserved', 'observedCycles',
  ], 'operator observations');

  const received = await hashFile(receivedPath);
  const completeValue = now();
  const completedAt = (completeValue instanceof Date ? completeValue : new Date(completeValue)).toISOString();
  const wallClockMs = Date.parse(completedAt) - Date.parse(preparation.startedAt);
  if (!Number.isSafeInteger(wallClockMs) || wallClockMs < 0) fail('FQR_EVIDENCE_TIME', 'completion precedes preparation');

  const completion = {
    sender: facts.sender,
    receiver: facts.receiver,
    operatorObservations: {
      physicalDisplayToCameraPath: observations.physicalDisplayToCameraPath,
      virtualCameraAbsent: observations.virtualCameraAbsent,
      joinedMidCycle: observations.joinedMidCycle,
      repairPhaseOnlyStart: observations.repairPhaseOnlyStart,
      framesIntentionallyMissed: observations.framesIntentionallyMissed,
      interruptionPerformed: observations.interruptionPerformed,
      resumeObserved: observations.resumeObserved,
    },
    received,
    completedAt,
    measurements: { wallClockMs, observedCycles: observations.observedCycles },
    privacy: {
      cameraImageryCaptured: false,
      personalPayloadUsed: false,
      rawDeviceSerialStored: false,
      rawBuildFingerprintStored: false,
      rawPnpIdentifierStored: false,
      rawCameraDeviceNameStored: false,
      localPathStored: false,
      networkIdentifierStored: false,
      credentialStored: false,
    },
  };

  const record = finalizeEvidence(preparation, completion, { authoritative: true });
  if (record.result !== 'PASS') {
    try { fs.rmSync(`${outputPath}.tmp`, { force: true }); } catch {}
    try { fs.rmSync(outputPath, { force: true }); } catch {}
    fail('FQR_EVIDENCE_FINAL_FAIL', 'physical ceremony evidence did not satisfy PASS requirements');
  }
  atomicWriteJson(outputPath, record);
  return record;
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 2) {
    if (!argv[i]?.startsWith('--') || argv[i + 1] === undefined) fail('FQR_EVIDENCE_CLI', 'arguments must be --key value pairs');
    out[argv[i].slice(2)] = argv[i + 1];
  }
  return out;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const a = parseArgs(process.argv.slice(2));
    const record = await finalizeCeremony({
      preparationPath: a.preparation,
      receivedPath: a.received,
      platformFactsPath: a['platform-facts'],
      observationsPath: a.observations,
      outputPath: a.output,
    });
    console.log(`Physical ceremony ${record.ceremonyId}: PASS`);
  } catch (error) {
    console.error(error?.message || String(error));
    process.exitCode = 1;
  }
}
