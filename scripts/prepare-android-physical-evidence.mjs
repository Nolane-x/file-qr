import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveNativeBuild } from './physical-evidence-github.mjs';
import {
  currentHeadSha,
  defaultArtifactFetcher,
} from './prepare-optical-physical-evidence.mjs';

const SHA40 = /^[a-f0-9]{40}$/;
const SHA64 = /^[a-f0-9]{64}$/;
const APK_NAME = 'FileQR-Android-arm64.apk';

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

async function fetchAndroidArtifact({ artifact, runId, outputDir }) {
  return defaultArtifactFetcher({
    platform: 'android',
    artifact,
    runId,
    destinationDir: outputDir,
  });
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
    !sameArtifact(admitted?.artifacts?.android, observed?.artifacts?.android)
  ) {
    fail('FQR_ANDROID_PHYSICAL_DRIFT', 'Native Builds Android artifact identity changed during materialization');
  }
}

function clearOwnedPartial(outputDir, authorityPath) {
  if (fs.existsSync(authorityPath)) fs.unlinkSync(authorityPath);
  const apkPath = path.join(outputDir, APK_NAME);
  if (fs.existsSync(apkPath)) fs.unlinkSync(apkPath);
  if (fs.existsSync(outputDir) && fs.readdirSync(outputDir).length === 0) fs.rmdirSync(outputDir);
}

export async function prepareAndroidPhysicalEvidence({
  runId,
  outputDir,
  authorityPath,
  execGh,
  controlSha,
  artifactFetcher = fetchAndroidArtifact,
  now = () => new Date(),
} = {}) {
  if (!Number.isSafeInteger(runId) || runId < 1) fail('FQR_ANDROID_PHYSICAL_INPUT', 'runId must be a positive integer');
  if (typeof outputDir !== 'string' || outputDir.length === 0) fail('FQR_ANDROID_PHYSICAL_INPUT', 'outputDir is required');
  if (typeof authorityPath !== 'string' || authorityPath.length === 0) fail('FQR_ANDROID_PHYSICAL_INPUT', 'authorityPath is required');
  if (typeof artifactFetcher !== 'function') fail('FQR_ANDROID_PHYSICAL_FETCH', 'artifactFetcher must be callable');
  if (fs.existsSync(outputDir) || fs.existsSync(authorityPath)) {
    fail('FQR_ANDROID_PHYSICAL_INPUT', 'outputDir and authorityPath must not already exist');
  }

  const build = resolveNativeBuild({ runId, execGh });
  const trustedControlSha = controlSha ?? currentHeadSha();
  if (!SHA40.test(trustedControlSha || '') || trustedControlSha !== build.commitSha) {
    fail('FQR_ANDROID_PHYSICAL_AUTHORITY', 'trusted control HEAD must equal the admitted Native Builds commit');
  }

  try {
    const artifact = build.artifacts.android;
    const fetched = await artifactFetcher({ artifact, runId, outputDir });
    if (!fetched || !SHA64.test(fetched.archiveSha256 || '')) {
      fail('FQR_ANDROID_PHYSICAL_BYTES', 'artifact fetch did not report a valid archive SHA-256');
    }
    if (`sha256:${fetched.archiveSha256}` !== artifact.artifactDigest) {
      fail('FQR_ANDROID_PHYSICAL_BYTES', 'downloaded Android archive does not match GitHub artifact digest');
    }

    let entries;
    try {
      entries = fs.readdirSync(outputDir, { withFileTypes: true });
    } catch {
      fail('FQR_ANDROID_PHYSICAL_LAYOUT', 'artifact extraction directory is missing');
    }
    if (entries.length !== 1 || entries[0].name !== APK_NAME || !entries[0].isFile()) {
      fail('FQR_ANDROID_PHYSICAL_LAYOUT', `artifact must contain exactly ${APK_NAME}`);
    }

    const apkPath = path.join(outputDir, APK_NAME);
    const stat = fs.lstatSync(apkPath);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size < 1) {
      fail('FQR_ANDROID_PHYSICAL_LAYOUT', 'canonical APK must be a non-empty regular file');
    }

    assertBuildIdentityStable(build, resolveNativeBuild({ runId, execGh }));

    const observedAtValue = now();
    const observedAt = (observedAtValue instanceof Date ? observedAtValue : new Date(observedAtValue)).toISOString();
    const authority = {
      schemaVersion: 1,
      repository: build.repository,
      workflow: build.workflow,
      workflowRunId: build.workflowRunId,
      commitSha: build.commitSha,
      artifactId: artifact.artifactId,
      artifactName: artifact.name,
      artifactDigest: artifact.artifactDigest,
      archiveSha256: fetched.archiveSha256,
      apkSha256: await hashFile(apkPath),
      apkBytes: stat.size,
      observedAt,
    };

    fs.writeFileSync(authorityPath, `${JSON.stringify(authority, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
    return authority;
  } catch (error) {
    clearOwnedPartial(outputDir, authorityPath);
    throw error;
  }
}

function parseCliArgs(argv) {
  const values = new Map();
  const allowed = new Set(['--run-id', '--output-dir', '--authority']);
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!allowed.has(flag) || value === undefined || values.has(flag)) {
      fail('FQR_ANDROID_PHYSICAL_INPUT', 'expected --run-id <id> --output-dir <dir> --authority <file>');
    }
    values.set(flag, value);
  }
  const runIdText = values.get('--run-id') || '';
  if (values.size !== 3 || !/^\d+$/.test(runIdText)) {
    fail('FQR_ANDROID_PHYSICAL_INPUT', 'expected --run-id <id> --output-dir <dir> --authority <file>');
  }
  const runId = Number(runIdText);
  if (!Number.isSafeInteger(runId) || runId < 1) {
    fail('FQR_ANDROID_PHYSICAL_INPUT', 'runId must be a positive integer');
  }
  return {
    runId,
    outputDir: values.get('--output-dir'),
    authorityPath: values.get('--authority'),
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const authority = await prepareAndroidPhysicalEvidence(parseCliArgs(process.argv.slice(2)));
    console.log(`Android physical build authority: PASS (run ${authority.workflowRunId}, apk ${authority.apkSha256})`);
  } catch (error) {
    console.error(error?.message || String(error));
    process.exitCode = 1;
  }
}
