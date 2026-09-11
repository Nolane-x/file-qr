import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { summarizeEvidenceMatrix } from '../packages/core/physical-evidence.js';

function fail(code, message) {
  const error = new Error(`${code}: ${message}`);
  error.code = code;
  throw error;
}

function readEvidence(filePath) {
  if (typeof filePath !== 'string' || filePath.length === 0) {
    fail('FQR_EVIDENCE_MATRIX_INPUT', 'evidence path must be a non-empty string');
  }
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    fail('FQR_EVIDENCE_MATRIX_INPUT', 'evidence file is missing or invalid JSON');
  }
}

function atomicWriteJson(outputPath, value) {
  if (typeof outputPath !== 'string' || outputPath.length === 0) {
    fail('FQR_EVIDENCE_MATRIX_INPUT', 'output path must be a non-empty string');
  }
  const tmp = `${outputPath}.tmp`;
  fs.mkdirSync(path.dirname(outputPath), { recursive: true, mode: 0o700 });
  let fd;
  try {
    try { fs.rmSync(tmp, { force: true }); } catch {}
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
    fail('FQR_EVIDENCE_MATRIX_WRITE', error?.message || 'could not publish matrix summary');
  }
}

export function writeEvidenceSummary({ evidencePaths, outputPath } = {}) {
  if (!Array.isArray(evidencePaths) || evidencePaths.length === 0) {
    fail('FQR_EVIDENCE_MATRIX_INPUT', 'at least one evidence path is required');
  }

  let records;
  try {
    records = evidencePaths.map(readEvidence);
  } catch (error) {
    try { fs.rmSync(`${outputPath}.tmp`, { force: true }); } catch {}
    throw error;
  }

  const summary = summarizeEvidenceMatrix(records);
  atomicWriteJson(outputPath, summary);
  if (!summary.matrixComplete) {
    fail('FQR_EVIDENCE_MATRIX_INCOMPLETE', `missing categories: ${summary.missing.join(', ')}`);
  }
  return summary;
}

function parseArgs(argv) {
  const evidencePaths = [];
  let outputPath;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--output') {
      if (outputPath !== undefined || argv[i + 1] === undefined) {
        fail('FQR_EVIDENCE_CLI', '--output requires exactly one value');
      }
      outputPath = argv[i + 1];
      i += 1;
      continue;
    }
    if (arg?.startsWith('--')) fail('FQR_EVIDENCE_CLI', `unknown argument ${arg}`);
    evidencePaths.push(arg);
  }
  if (!outputPath || evidencePaths.length === 0) {
    fail('FQR_EVIDENCE_CLI', 'usage: node scripts/summarize-optical-physical-evidence.mjs <evidence.json>... --output <summary.json>');
  }
  return { evidencePaths, outputPath };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const summary = writeEvidenceSummary(parseArgs(process.argv.slice(2)));
    console.log(`Physical evidence matrix: PASS (${summary.recordIds.length} records)`);
  } catch (error) {
    console.error(error?.message || String(error));
    process.exitCode = 1;
  }
}
