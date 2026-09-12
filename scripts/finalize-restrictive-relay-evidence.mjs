import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { finalizeRestrictiveRelayEvidenceFiles } from './physical-evidence-github.mjs';

const REQUIRED_ARGS = Object.freeze([
  'deploy-run-id',
  'production-origin',
  'source-sha256',
  'received-sha256',
  'sender',
  'receiver',
  'output',
]);

function fail(message) {
  throw new Error(`FQR_EVIDENCE_CLI: ${message}`);
}

export function parseRestrictiveRelayEvidenceArgs(argv) {
  if (!Array.isArray(argv) || argv.length !== REQUIRED_ARGS.length * 2) {
    fail('exactly seven --key value arguments are required');
  }

  const values = {};
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (typeof flag !== 'string' || !flag.startsWith('--') || typeof value !== 'string' || value.length === 0) {
      fail('arguments must be non-empty --key value pairs');
    }
    const key = flag.slice(2);
    if (!REQUIRED_ARGS.includes(key)) fail(`unknown argument --${key}`);
    if (Object.hasOwn(values, key)) fail(`duplicate argument --${key}`);
    values[key] = value;
  }

  for (const key of REQUIRED_ARGS) {
    if (!Object.hasOwn(values, key)) fail(`missing argument --${key}`);
  }

  const deployRunId = Number(values['deploy-run-id']);
  if (!Number.isSafeInteger(deployRunId) || deployRunId < 1 || String(deployRunId) !== values['deploy-run-id']) {
    fail('--deploy-run-id must be a canonical positive integer');
  }

  return {
    deployRunId,
    productionOrigin: values['production-origin'],
    sourceSha256: values['source-sha256'],
    receivedSha256: values['received-sha256'],
    senderPath: values.sender,
    receiverPath: values.receiver,
    outputPath: values.output,
  };
}

export function runRestrictiveRelayEvidenceCli(argv = process.argv.slice(2)) {
  const args = parseRestrictiveRelayEvidenceArgs(argv);
  const record = finalizeRestrictiveRelayEvidenceFiles(args);
  if (record.result !== 'PASS') fail('validator did not return PASS');
  return record;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    runRestrictiveRelayEvidenceCli();
    process.stdout.write('Restrictive relay evidence: PASS\n');
  } catch (error) {
    process.stderr.write(`${error?.message || String(error)}\n`);
    process.exitCode = 1;
  }
}
