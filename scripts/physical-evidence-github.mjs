import { spawnSync } from 'node:child_process';

const REPOSITORY = 'Nolane-x/file-qr';
const WORKFLOW = 'Native Builds';
const DIGEST = /^sha256:[a-f0-9]{64}$/;
const SHA40 = /^[a-f0-9]{40}$/;

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
    !SHA40.test(run?.head_sha || '')
  ) {
    fail('FQR_EVIDENCE_GITHUB_AUTHORITY', 'run is not an authoritative main Native Builds push');
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
