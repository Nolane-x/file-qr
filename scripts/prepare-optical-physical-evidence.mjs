import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolveNativeBuild } from './physical-evidence-github.mjs';
import { deriveCeremonyId, validatePreparation } from '../packages/core/physical-evidence.js';

const REPOSITORY = 'Nolane-x/file-qr';
const FQR1_MAX = 8 * 1024 * 1024;
const FQR2_MAX = 64 * 1024 * 1024;
const SHA40 = /^[a-f0-9]{40}$/;
const SHA64 = /^[a-f0-9]{64}$/;
const BINARY_NAMES = Object.freeze({
  windows: 'FileQR-Windows-x64-setup.exe',
  android: 'FileQR-Android-arm64.apk',
});

function fail(code, message) {
  const error = new Error(`${code}: ${message}`);
  error.code = code;
  throw error;
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

export function currentHeadSha() {
  const result = spawnSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  const sha = String(result.stdout || '').trim();
  if (result.error || result.status !== 0 || !SHA40.test(sha)) fail('FQR_EVIDENCE_BUILD_AUTHORITY', 'cannot resolve trusted control HEAD');
  return sha;
}

function runGh(args, { stdout = 'pipe' } = {}) {
  const result = spawnSync('gh', args, {
    encoding: stdout === 'pipe' ? 'utf8' : undefined,
    stdio: ['ignore', stdout, 'pipe'],
  });
  if (result.error) fail('FQR_EVIDENCE_ARTIFACT_FETCH', result.error.message);
  if (result.status !== 0) fail('FQR_EVIDENCE_ARTIFACT_FETCH', 'GitHub artifact download failed');
  return result;
}

export async function defaultArtifactFetcher({ platform, artifact, runId, destinationDir }) {
  const archivePath = `${destinationDir}.artifact.zip`;
  fs.mkdirSync(destinationDir, { recursive: false, mode: 0o700 });

  let archiveFd;
  try {
    archiveFd = fs.openSync(archivePath, 'wx', 0o600);
    runGh(['api', `/repos/${REPOSITORY}/actions/artifacts/${artifact.artifactId}/zip`], { stdout: archiveFd });
  } finally {
    if (archiveFd !== undefined) fs.closeSync(archiveFd);
  }

  try {
    const archiveSha256 = await hashFile(archivePath);
    if (`sha256:${archiveSha256}` !== artifact.artifactDigest) {
      fail('FQR_EVIDENCE_ARTIFACT_BYTES', `${platform} downloaded archive does not match GitHub artifact digest`);
    }

    runGh([
      'run', 'download', String(runId),
      '--repo', REPOSITORY,
      '--name', artifact.name,
      '--dir', destinationDir,
    ]);
    return { archiveSha256 };
  } finally {
    fs.rmSync(archivePath, { force: true });
  }
}

function validateFetchedArtifact({ platform, artifact, destinationDir, fetched }) {
  const expectedArchiveSha = artifact.artifactDigest.slice('sha256:'.length);
  if (!fetched || typeof fetched !== 'object' || !SHA64.test(fetched.archiveSha256 || '')) {
    fail('FQR_EVIDENCE_ARTIFACT_BYTES', `${platform} artifact fetch did not report a valid archive SHA-256`);
  }
  if (fetched.archiveSha256 !== expectedArchiveSha) {
    fail('FQR_EVIDENCE_ARTIFACT_BYTES', `${platform} artifact archive does not match GitHub artifact digest`);
  }

  let entries;
  try {
    entries = fs.readdirSync(destinationDir, { withFileTypes: true });
  } catch {
    fail('FQR_EVIDENCE_ARTIFACT_FETCH', `${platform} artifact extraction directory is missing`);
  }
  const expectedName = BINARY_NAMES[platform];
  if (entries.length !== 1 || entries[0].name !== expectedName || !entries[0].isFile()) {
    fail('FQR_EVIDENCE_ARTIFACT_LAYOUT', `${platform} artifact must contain exactly ${expectedName}`);
  }
  const binaryPath = path.join(destinationDir, expectedName);
  let stat;
  try {
    stat = fs.lstatSync(binaryPath);
  } catch {
    fail('FQR_EVIDENCE_ARTIFACT_LAYOUT', `${platform} canonical binary is missing`);
  }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size < 1) {
    fail('FQR_EVIDENCE_ARTIFACT_LAYOUT', `${platform} canonical binary must be a non-empty regular file`);
  }
  return binaryPath;
}

function sameArtifact(left, right) {
  return left?.artifactId === right?.artifactId &&
    left?.name === right?.name &&
    left?.artifactDigest === right?.artifactDigest;
}

function assertBuildIdentityStable(admitted, observed) {
  if (
    admitted?.repository !== observed?.repository ||
    admitted?.workflow !== observed?.workflow ||
    admitted?.workflowRunId !== observed?.workflowRunId ||
    admitted?.event !== observed?.event ||
    admitted?.headBranch !== observed?.headBranch ||
    admitted?.commitSha !== observed?.commitSha ||
    !sameArtifact(admitted?.artifacts?.windows, observed?.artifacts?.windows) ||
    !sameArtifact(admitted?.artifacts?.android, observed?.artifacts?.android)
  ) {
    fail('FQR_EVIDENCE_ARTIFACT_DRIFT', 'Native Builds artifact identity changed during materialization');
  }
}

function generatePayload(filePath, bytes) {
  const fd = fs.openSync(filePath, 'wx', 0o600);
  const hash = createHash('sha256');
  try {
    let remaining = bytes;
    while (remaining > 0) {
      const chunk = randomBytes(Math.min(64 * 1024, remaining));
      fs.writeSync(fd, chunk);
      hash.update(chunk);
      remaining -= chunk.length;
    }
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  return hash.digest('hex');
}

function protocolForScenario(scenario) {
  if (scenario.startsWith('fqr1-')) return { version: 'FQR1', blockBytes: null, symbolBytes: null };
  if (scenario.startsWith('fqr2-')) return { version: 'FQR2', blockBytes: 65536, symbolBytes: 768 };
  fail('FQR_EVIDENCE_SCENARIO', 'unsupported ceremony scenario');
}

const COMMON_PHYSICAL_INSTRUCTIONS = Object.freeze([
  'Use a real display-to-camera optical path; do not use a virtual camera, prerecorded media, or a synthetic decode path.',
  'Use only the generated payload.bin and preserve the final received bytes unchanged for independent hashing.',
  'Do not capture or retain camera imagery as ceremony evidence.',
]);

export function physicalInstructionsForScenario(scenario) {
  let specific;
  switch (scenario) {
    case 'fqr2-windows-to-android':
      specific = 'Show the FQR2 stream on the Windows display and receive it with a physical Android camera.';
      break;
    case 'fqr2-android-to-windows':
      specific = 'Show the FQR2 stream on the physical Android display and receive it with a real Windows camera.';
      break;
    case 'fqr1-windows-to-android':
      specific = 'Run the FQR1 compatibility path from the Windows display to a physical Android camera receiver.';
      break;
    case 'fqr1-android-to-windows':
      specific = 'Run the FQR1 compatibility path from the physical Android display to a real Windows camera receiver.';
      break;
    case 'fqr2-mid-cycle':
      specific = 'Start the receiver only after the broadcast is already in progress, then complete from the ongoing FQR2 stream.';
      break;
    case 'fqr2-repair-phase':
      specific = 'Begin during the FQR2 repair phase, intentionally miss frames, and require repair information rather than a perfect systematic pass.';
      break;
    case 'fqr2-large-file':
      specific = 'Use a generated FQR2 payload greater than 8 MiB so the persistent-storage path is exercised.';
      break;
    case 'fqr2-interruption-resume':
      specific = 'Interrupt only after durable progress exists, restart or reopen as required, and verify that durable progress is actually resumed.';
      break;
    default:
      fail('FQR_EVIDENCE_SCENARIO', 'unsupported ceremony scenario');
  }
  return [specific, ...COMMON_PHYSICAL_INSTRUCTIONS];
}

export async function prepareCeremony({
  scenario,
  runId,
  payloadBytes,
  workspace,
  execGh,
  controlSha,
  artifactFetcher = defaultArtifactFetcher,
  windowsBinaryPath,
  androidBinaryPath,
  now = () => new Date(),
} = {}) {
  if (typeof scenario !== 'string') fail('FQR_EVIDENCE_SCENARIO', 'scenario is required');
  const protocol = protocolForScenario(scenario);
  const maxBytes = protocol.version === 'FQR1' ? FQR1_MAX : FQR2_MAX;
  if (!Number.isSafeInteger(payloadBytes) || payloadBytes < 1 || payloadBytes > maxBytes) {
    fail('FQR_EVIDENCE_PAYLOAD', `payloadBytes must be 1..${maxBytes}`);
  }
  if (typeof workspace !== 'string' || workspace.length === 0) fail('FQR_EVIDENCE_FILE', 'workspace is required');
  if (windowsBinaryPath !== undefined || androidBinaryPath !== undefined) {
    fail('FQR_EVIDENCE_ARTIFACT_FETCH', 'authoritative preparation does not accept operator-supplied binary paths');
  }
  if (typeof artifactFetcher !== 'function') fail('FQR_EVIDENCE_ARTIFACT_FETCH', 'artifactFetcher must be callable');

  const build = resolveNativeBuild({ runId, execGh });
  const trustedControlSha = controlSha ?? currentHeadSha();
  if (!SHA40.test(trustedControlSha || '')) fail('FQR_EVIDENCE_BUILD_AUTHORITY', 'controlSha must be lowercase 40-hex');
  if (trustedControlSha !== build.commitSha) {
    fail('FQR_EVIDENCE_BUILD_AUTHORITY', 'trusted control HEAD must equal the admitted Native Builds commit');
  }

  let created = false;
  try {
    fs.mkdirSync(workspace, { recursive: false, mode: 0o700 });
    created = true;
    const artifactRoot = path.join(workspace, 'artifacts');
    fs.mkdirSync(artifactRoot, { recursive: false, mode: 0o700 });

    const windowsDir = path.join(artifactRoot, 'windows');
    const windowsFetched = await artifactFetcher({
      platform: 'windows', artifact: build.artifacts.windows, runId, destinationDir: windowsDir,
    });
    const windowsPath = validateFetchedArtifact({
      platform: 'windows', artifact: build.artifacts.windows, destinationDir: windowsDir, fetched: windowsFetched,
    });
    assertBuildIdentityStable(build, resolveNativeBuild({ runId, execGh }));

    const androidDir = path.join(artifactRoot, 'android');
    const androidFetched = await artifactFetcher({
      platform: 'android', artifact: build.artifacts.android, runId, destinationDir: androidDir,
    });
    const androidPath = validateFetchedArtifact({
      platform: 'android', artifact: build.artifacts.android, destinationDir: androidDir, fetched: androidFetched,
    });
    assertBuildIdentityStable(build, resolveNativeBuild({ runId, execGh }));

    const payloadPath = path.join(workspace, 'payload.bin');
    const sourceSha256 = generatePayload(payloadPath, payloadBytes);
    const windowsSha = await hashFile(windowsPath);
    const androidSha = await hashFile(androidPath);
    const startedAtValue = now();
    const startedAt = (startedAtValue instanceof Date ? startedAtValue : new Date(startedAtValue)).toISOString();

    const raw = {
      schemaVersion: 1,
      scenario,
      control: { repository: REPOSITORY, commitSha: trustedControlSha },
      build: {
        ...build,
        artifacts: {
          windows: { ...build.artifacts.windows, binarySha256: windowsSha },
          android: { ...build.artifacts.android, binarySha256: androidSha },
        },
      },
      payload: { generated: true, generatorVersion: 1, bytes: payloadBytes, sourceSha256 },
      protocol,
      startedAt,
    };
    const normalized = validatePreparation(raw, { authoritative: true });
    const preparation = validatePreparation({ ...normalized, ceremonyId: deriveCeremonyId(normalized) }, { authoritative: true });
    const manifestPath = path.join(workspace, 'preparation.json');
    fs.writeFileSync(manifestPath, `${JSON.stringify(preparation, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
    return preparation;
  } catch (error) {
    if (created) fs.rmSync(workspace, { recursive: true, force: true });
    if (error?.code?.startsWith('FQR_EVIDENCE_')) throw error;
    fail('FQR_EVIDENCE_FILE', error?.message || 'preparation failed');
  }
}

function args(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i];
    const value = argv[i + 1];
    if (!key?.startsWith('--') || value === undefined) fail('FQR_EVIDENCE_CLI', 'arguments must be --key value pairs');
    out[key.slice(2)] = value;
  }
  return out;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const a = args(process.argv.slice(2));
    const result = await prepareCeremony({
      scenario: a.scenario,
      runId: Number(a['run-id']),
      payloadBytes: Number(a['payload-bytes']),
      workspace: a.workspace,
    });
    console.log(`Prepared physical ceremony ${result.ceremonyId}`);
    console.log(`- Verified Windows binary: artifacts/windows/${BINARY_NAMES.windows}`);
    console.log(`- Verified Android binary: artifacts/android/${BINARY_NAMES.android}`);
    for (const instruction of physicalInstructionsForScenario(result.scenario)) {
      console.log(`- ${instruction}`);
    }
  } catch (error) {
    console.error(error?.message || String(error));
    process.exitCode = 1;
  }
}