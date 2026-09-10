import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolveNativeBuild } from './physical-evidence-github.mjs';
import { deriveCeremonyId, validatePreparation } from '../packages/core/physical-evidence.js';

const FQR1_MAX = 8 * 1024 * 1024;
const FQR2_MAX = 64 * 1024 * 1024;
const SHA40 = /^[a-f0-9]{40}$/;

function fail(code, message) {
  const error = new Error(`${code}: ${message}`);
  error.code = code;
  throw error;
}

function requireFile(filePath, label) {
  try {
    const stat = fs.statSync(filePath);
    if (!stat.isFile() || stat.size < 1) fail('FQR_EVIDENCE_FILE', `${label} must be a non-empty file`);
  } catch (error) {
    if (error?.code === 'FQR_EVIDENCE_FILE') throw error;
    fail('FQR_EVIDENCE_FILE', `${label} not found`);
  }
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

function currentHeadSha() {
  const result = spawnSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  const sha = String(result.stdout || '').trim();
  if (result.error || result.status !== 0 || !SHA40.test(sha)) fail('FQR_EVIDENCE_BUILD_AUTHORITY', 'cannot resolve trusted control HEAD');
  return sha;
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

export async function prepareCeremony({
  scenario,
  runId,
  windowsBinaryPath,
  androidBinaryPath,
  payloadBytes,
  workspace,
  execGh,
  controlSha,
  now = () => new Date(),
} = {}) {
  if (typeof scenario !== 'string') fail('FQR_EVIDENCE_SCENARIO', 'scenario is required');
  const protocol = protocolForScenario(scenario);
  const maxBytes = protocol.version === 'FQR1' ? FQR1_MAX : FQR2_MAX;
  if (!Number.isSafeInteger(payloadBytes) || payloadBytes < 1 || payloadBytes > maxBytes) {
    fail('FQR_EVIDENCE_PAYLOAD', `payloadBytes must be 1..${maxBytes}`);
  }
  if (typeof workspace !== 'string' || workspace.length === 0) fail('FQR_EVIDENCE_FILE', 'workspace is required');

  requireFile(windowsBinaryPath, 'Windows binary');
  requireFile(androidBinaryPath, 'Android binary');
  const build = resolveNativeBuild({ runId, execGh });
  const trustedControlSha = controlSha ?? currentHeadSha();
  if (!SHA40.test(trustedControlSha || '')) fail('FQR_EVIDENCE_BUILD_AUTHORITY', 'controlSha must be lowercase 40-hex');

  let created = false;
  try {
    fs.mkdirSync(workspace, { recursive: false, mode: 0o700 });
    created = true;
    const payloadPath = path.join(workspace, 'payload.bin');
    const sourceSha256 = generatePayload(payloadPath, payloadBytes);
    const windowsSha = await hashFile(windowsBinaryPath);
    const androidSha = await hashFile(androidBinaryPath);
    const startedAtValue = now();
    const startedAt = (startedAtValue instanceof Date ? startedAtValue : new Date(startedAtValue)).toISOString();

    const raw = {
      schemaVersion: 1,
      scenario,
      control: { repository: 'Nolane-x/file-qr', commitSha: trustedControlSha },
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
      windowsBinaryPath: a['windows-binary'],
      androidBinaryPath: a['android-binary'],
      payloadBytes: Number(a['payload-bytes']),
      workspace: a.workspace,
    });
    console.log(`Prepared physical ceremony ${result.ceremonyId}`);
  } catch (error) {
    console.error(error?.message || String(error));
    process.exitCode = 1;
  }
}
