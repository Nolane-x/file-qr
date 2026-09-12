import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const REPOSITORY = 'Nolane-x/file-qr';
const WORKFLOW = 'Native Builds';
const WEB_DEPLOY_WORKFLOW = 'Deploy Web';
const PRODUCTION_ORIGIN = 'https://fileqr.nolane-file.workers.dev';
const ANDROID_APK_NAME = 'FileQR-Android-arm64.apk';
const DIGEST = /^sha256:[a-f0-9]{64}$/;
const SHA40 = /^[a-f0-9]{40}$/;
const SHA64 = /^[a-f0-9]{64}$/;
const AUTHORIZED_WEB_DEPLOYMENTS = new WeakSet();
const RELAY_SEQUENCE = Object.freeze([
  ['direct-started', 'webrtc-direct'],
  ['direct-exhausted', 'webrtc-direct'],
  ['relay-connected', 'worker-relay'],
  ['transfer-complete', 'worker-relay'],
]);

function fail(code, message) {
  const error = new Error(`${code}: ${message}`);
  error.code = code;
  throw error;
}

function defaultExecGh(endpoint) {
  const result = spawnSync('gh', ['api', endpoint], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (result.error) fail('FQR_EVIDENCE_GITHUB', result.error.message);
  if (result.status !== 0) fail('FQR_EVIDENCE_GITHUB', 'GitHub metadata query failed');
  return result.stdout;
}

function parse(value, label) {
  try {
    return typeof value === 'string' ? JSON.parse(value) : value;
  } catch {
    fail('FQR_EVIDENCE_GITHUB', `${label} returned invalid JSON`);
  }
}

function exactKeys(value, keys, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    fail('FQR_EVIDENCE_SCHEMA', `${label} must be an object`);
  }
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    fail('FQR_EVIDENCE_UNKNOWN_KEY', `${label} contains unknown or missing fields`);
  }
}

function normalizeArtifact(artifact, expectedName, runId, headSha) {
  if (!artifact || artifact.name !== expectedName || artifact.expired !== false) {
    fail('FQR_EVIDENCE_GITHUB_ARTIFACT', `${expectedName} is missing, expired, or malformed`);
  }
  if (!Number.isSafeInteger(artifact.id) || artifact.id < 1 || !DIGEST.test(artifact.digest || '')) {
    fail('FQR_EVIDENCE_GITHUB_ARTIFACT', `${expectedName} identity/digest is invalid`);
  }
  if (!artifact.workflow_run || artifact.workflow_run.id !== runId || artifact.workflow_run.head_sha !== headSha) {
    fail('FQR_EVIDENCE_GITHUB_ARTIFACT', `${expectedName} is not bound to the requested run/head`);
  }
  return {
    artifactId: artifact.id,
    name: expectedName,
    artifactDigest: artifact.digest,
  };
}

async function hashFile(filePath) {
  const hash = createHash('sha256');
  await new Promise((resolve, reject) => {
    const stream = fs.createReadStream(filePath);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('error', reject);
    stream.on('end', resolve);
  });
  return hash.digest('hex');
}

export function resolveNativeBuild({ runId, execGh = defaultExecGh } = {}) {
  if (!Number.isSafeInteger(runId) || runId < 1) fail('FQR_EVIDENCE_GITHUB', 'runId must be a positive integer');

  let run;
  let listing;
  try {
    run = parse(execGh(`/repos/${REPOSITORY}/actions/runs/${runId}`), 'run metadata');
    listing = parse(execGh(`/repos/${REPOSITORY}/actions/runs/${runId}/artifacts`), 'artifact metadata');
  } catch (error) {
    if (error?.code?.startsWith('FQR_EVIDENCE_')) throw error;
    fail('FQR_EVIDENCE_GITHUB', 'GitHub metadata query failed');
  }

  if (
    run?.id !== runId ||
    run?.repository?.full_name !== REPOSITORY ||
    run?.name !== WORKFLOW ||
    run?.event !== 'push' ||
    run?.head_branch !== 'main' ||
    run?.status !== 'completed' ||
    run?.conclusion !== 'success' ||
    !SHA40.test(run?.head_sha || '')
  ) {
    fail('FQR_EVIDENCE_GITHUB_AUTHORITY', 'run is not a successful completed authoritative main Native Builds push');
  }

  if (!Array.isArray(listing?.artifacts)) fail('FQR_EVIDENCE_GITHUB_ARTIFACT', 'artifact listing is malformed');
  const windowsMatches = listing.artifacts.filter((x) => x?.name === 'file-qr-windows');
  const androidMatches = listing.artifacts.filter((x) => x?.name === 'file-qr-android');
  if (windowsMatches.length !== 1 || androidMatches.length !== 1) {
    fail('FQR_EVIDENCE_GITHUB_ARTIFACT', 'exactly one Windows and one Android artifact are required');
  }

  return {
    repository: REPOSITORY,
    workflow: WORKFLOW,
    workflowRunId: runId,
    event: 'push',
    headBranch: 'main',
    commitSha: run.head_sha,
    artifacts: {
      windows: normalizeArtifact(windowsMatches[0], 'file-qr-windows', runId, run.head_sha),
      android: normalizeArtifact(androidMatches[0], 'file-qr-android', runId, run.head_sha),
    },
  };
}

export function resolveWebDeploy({ runId, execGh = defaultExecGh } = {}) {
  if (!Number.isSafeInteger(runId) || runId < 1) fail('FQR_EVIDENCE_GITHUB', 'runId must be a positive integer');

  let run;
  let main;
  try {
    run = parse(execGh(`/repos/${REPOSITORY}/actions/runs/${runId}`), 'web deploy run metadata');
    main = parse(execGh(`/repos/${REPOSITORY}/branches/main`), 'main branch metadata');
  } catch (error) {
    if (error?.code?.startsWith('FQR_EVIDENCE_')) throw error;
    fail('FQR_EVIDENCE_GITHUB', 'GitHub metadata query failed');
  }

  if (
    run?.id !== runId ||
    run?.repository?.full_name !== REPOSITORY ||
    run?.name !== WEB_DEPLOY_WORKFLOW ||
    run?.event !== 'push' ||
    run?.head_branch !== 'main' ||
    run?.status !== 'completed' ||
    run?.conclusion !== 'success' ||
    !SHA40.test(run?.head_sha || '') ||
    main?.name !== 'main' ||
    main?.commit?.sha !== run.head_sha
  ) {
    fail('FQR_EVIDENCE_GITHUB_AUTHORITY', 'web deployment is not a successful current-main Deploy Web push');
  }

  const deployment = Object.freeze({
    repository: REPOSITORY,
    workflow: WEB_DEPLOY_WORKFLOW,
    workflowRunId: runId,
    event: 'push',
    headBranch: 'main',
    commitSha: run.head_sha,
  });
  AUTHORIZED_WEB_DEPLOYMENTS.add(deployment);
  return deployment;
}

function validateDeployRecord(deployment) {
  if (!deployment || typeof deployment !== 'object' || !AUTHORIZED_WEB_DEPLOYMENTS.has(deployment)) {
    fail('FQR_EVIDENCE_GITHUB_AUTHORITY', 'deployment record must come from the live current-main resolver');
  }
  exactKeys(deployment, ['repository', 'workflow', 'workflowRunId', 'event', 'headBranch', 'commitSha'], 'deployment');
  if (
    deployment.repository !== REPOSITORY ||
    deployment.workflow !== WEB_DEPLOY_WORKFLOW ||
    !Number.isSafeInteger(deployment.workflowRunId) || deployment.workflowRunId < 1 ||
    deployment.event !== 'push' ||
    deployment.headBranch !== 'main' ||
    !SHA40.test(deployment.commitSha || '')
  ) {
    fail('FQR_EVIDENCE_GITHUB_AUTHORITY', 'deployment record is not an authoritative main Deploy Web push');
  }
  return deployment;
}

function validateRelayJournal(journal, role, productionOrigin) {
  exactKeys(journal, ['schemaVersion', 'enabled', 'forcedRelay', 'origin', 'role', 'invalid', 'events'], `${role} journal`);
  if (journal.schemaVersion !== 1 || journal.enabled !== true || journal.invalid !== false) {
    fail('FQR_EVIDENCE_SCHEMA', `${role} journal is not a valid enabled evidence record`);
  }
  if (journal.forcedRelay !== false) {
    fail('FQR_EVIDENCE_TOPOLOGY', `${role} journal used forced relay and cannot prove natural fallback`);
  }
  if (journal.origin !== productionOrigin || journal.role !== role) {
    fail('FQR_EVIDENCE_TOPOLOGY', `${role} journal origin or role does not match the ceremony`);
  }
  if (!Array.isArray(journal.events) || journal.events.length !== RELAY_SEQUENCE.length) {
    fail('FQR_EVIDENCE_TOPOLOGY', `${role} journal must include direct-exhausted before relay completion`);
  }

  let attemptId = null;
  let previousTime = -1;
  const normalizedEvents = journal.events.map((event, index) => {
    exactKeys(event, ['sequence', 'type', 'attemptId', 'transport', 'observedAtMs'], `${role} journal event ${index + 1}`);
    const [expectedType, expectedTransport] = RELAY_SEQUENCE[index];
    if (
      event.sequence !== index + 1 ||
      event.type !== expectedType ||
      event.transport !== expectedTransport ||
      !Number.isSafeInteger(event.attemptId) || event.attemptId < 1 ||
      !Number.isSafeInteger(event.observedAtMs) || event.observedAtMs < 0 ||
      event.observedAtMs < previousTime
    ) {
      fail('FQR_EVIDENCE_TOPOLOGY', `${role} journal sequence does not prove direct-exhausted before Worker relay`);
    }
    if (attemptId === null) attemptId = event.attemptId;
    if (event.attemptId !== attemptId) fail('FQR_EVIDENCE_TOPOLOGY', `${role} journal attempt changed during the transfer`);
    previousTime = event.observedAtMs;
    return { ...event };
  });

  return { attemptId, events: normalizedEvents };
}

export function validateRestrictiveRelayEvidence(input) {
  exactKeys(input, ['deployment', 'productionOrigin', 'sourceSha256', 'receivedSha256', 'sender', 'receiver'], 'restrictive relay evidence');
  const deployment = validateDeployRecord(input.deployment);
  if (input.productionOrigin !== PRODUCTION_ORIGIN) {
    fail('FQR_EVIDENCE_GITHUB_AUTHORITY', 'restrictive relay evidence must use the canonical production origin');
  }
  if (!SHA64.test(input.sourceSha256 || '') || !SHA64.test(input.receivedSha256 || '')) {
    fail('FQR_EVIDENCE_SHA', 'source and received SHA-256 values must be lowercase 64-hex');
  }
  if (input.sourceSha256 !== input.receivedSha256) {
    fail('FQR_EVIDENCE_SHA', 'received SHA-256 does not match source SHA-256');
  }

  const sender = validateRelayJournal(input.sender, 'sender', input.productionOrigin);
  const receiver = validateRelayJournal(input.receiver, 'receiver', input.productionOrigin);
  if (sender.attemptId !== receiver.attemptId) {
    fail('FQR_EVIDENCE_TOPOLOGY', 'sender and receiver attempt identifiers do not match');
  }

  return {
    schemaVersion: 1,
    result: 'PASS',
    productionOrigin: input.productionOrigin,
    sourceCommit: deployment.commitSha,
    deployRunId: deployment.workflowRunId,
    attemptId: sender.attemptId,
    forcedRelay: false,
    sequence: RELAY_SEQUENCE.map(([type]) => type),
    sourceSha256: input.sourceSha256,
    receivedSha256: input.receivedSha256,
    sender: { role: 'sender', events: sender.events },
    receiver: { role: 'receiver', events: receiver.events },
  };
}

export function finalizeRestrictiveRelayEvidence({ deployRunId, productionOrigin, sourceSha256, receivedSha256, sender, receiver, execGh = defaultExecGh } = {}) {
  const deployment = resolveWebDeploy({ runId: deployRunId, execGh });
  return validateRestrictiveRelayEvidence({ deployment, productionOrigin, sourceSha256, receivedSha256, sender, receiver });
}

export async function verifyAndroidPhysicalArtifact({
  runId,
  artifactId,
  archiveSha256,
  apkPath,
  controlSha,
  execGh = defaultExecGh,
} = {}) {
  const normalizedControlSha = typeof controlSha === 'string' ? controlSha.toLowerCase() : '';
  if (!SHA40.test(normalizedControlSha)) {
    fail('FQR_EVIDENCE_BUILD_AUTHORITY', 'controlSha must be lowercase 40-hex');
  }
  if (!Number.isSafeInteger(artifactId) || artifactId < 1) {
    fail('FQR_EVIDENCE_ARTIFACT_DRIFT', 'Android artifact id is invalid');
  }
  if (!SHA64.test(archiveSha256 || '')) {
    fail('FQR_EVIDENCE_ARTIFACT_BYTES', 'Android archive SHA-256 is invalid');
  }
  if (typeof apkPath !== 'string' || path.basename(apkPath) !== ANDROID_APK_NAME) {
    fail('FQR_EVIDENCE_ARTIFACT_LAYOUT', `Android artifact must contain ${ANDROID_APK_NAME}`);
  }

  const build = resolveNativeBuild({ runId, execGh });
  if (build.commitSha !== normalizedControlSha) {
    fail('FQR_EVIDENCE_BUILD_AUTHORITY', 'trusted control HEAD must equal the admitted Native Builds commit');
  }

  const artifact = build.artifacts.android;
  if (artifact.artifactId !== artifactId) {
    fail('FQR_EVIDENCE_ARTIFACT_DRIFT', 'Android artifact id changed after admission');
  }
  if (artifact.artifactDigest !== `sha256:${archiveSha256}`) {
    fail('FQR_EVIDENCE_ARTIFACT_BYTES', 'downloaded Android archive does not match GitHub artifact digest');
  }

  const artifactDir = path.dirname(apkPath);
  let entries;
  let stat;
  try {
    entries = fs.readdirSync(artifactDir, { withFileTypes: true });
    stat = fs.lstatSync(apkPath);
  } catch {
    fail('FQR_EVIDENCE_ARTIFACT_LAYOUT', 'canonical Android APK is missing');
  }
  if (
    entries.length !== 1 ||
    entries[0].name !== ANDROID_APK_NAME ||
    !entries[0].isFile() ||
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    stat.size < 1
  ) {
    fail('FQR_EVIDENCE_ARTIFACT_LAYOUT', `Android artifact must contain exactly one non-empty ${ANDROID_APK_NAME}`);
  }

  const apkSha256 = await hashFile(apkPath);
  return {
    schemaVersion: 1,
    repository: build.repository,
    workflow: build.workflow,
    workflowRunId: build.workflowRunId,
    event: build.event,
    headBranch: build.headBranch,
    commitSha: build.commitSha,
    artifact: {
      artifactId: artifact.artifactId,
      name: artifact.name,
      artifactDigest: artifact.artifactDigest,
    },
    apk: {
      name: ANDROID_APK_NAME,
      bytes: stat.size,
      sha256: apkSha256,
    },
  };
}
