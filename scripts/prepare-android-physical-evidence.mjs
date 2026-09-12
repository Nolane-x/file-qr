import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { resolveNativeBuild } from './physical-evidence-github.mjs';

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

export async function prepareAndroidPhysicalEvidence({
  runId,
  outputDir,
  authorityPath,
  execGh,
  controlSha,
  artifactFetcher,
  now = () => new Date(),
} = {}) {
  if (!Number.isSafeInteger(runId) || runId < 1) fail('FQR_ANDROID_PHYSICAL_INPUT', 'runId must be a positive integer');
  if (typeof outputDir !== 'string' || outputDir.length === 0) fail('FQR_ANDROID_PHYSICAL_INPUT', 'outputDir is required');
  if (typeof authorityPath !== 'string' || authorityPath.length === 0) fail('FQR_ANDROID_PHYSICAL_INPUT', 'authorityPath is required');
  if (typeof artifactFetcher !== 'function') fail('FQR_ANDROID_PHYSICAL_FETCH', 'artifactFetcher must be callable');

  const build = resolveNativeBuild({ runId, execGh });
  if (!SHA40.test(controlSha || '') || controlSha !== build.commitSha) {
    fail('FQR_ANDROID_PHYSICAL_AUTHORITY', 'trusted control HEAD must equal the admitted Native Builds commit');
  }

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

  fs.writeFileSync(authorityPath, `${JSON.stringify(authority, null, 2)}\n`, { mode: 0o600 });
  return authority;
}
