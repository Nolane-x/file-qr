import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as evidence from '../../scripts/physical-evidence-github.mjs';

const ORIGIN = 'https://fileqr.nolane-file.workers.dev';
const SHA = 'a'.repeat(40);
const HASH = 'b'.repeat(64);

function journal(role, forcedRelay = false, attemptId = 7) {
  return {
    schemaVersion: 1,
    enabled: true,
    forcedRelay,
    origin: ORIGIN,
    role,
    invalid: false,
    events: [
      { sequence: 1, type: 'direct-started', attemptId, transport: 'webrtc-direct', observedAtMs: 1000 },
      { sequence: 2, type: 'direct-exhausted', attemptId, transport: 'webrtc-direct', observedAtMs: 2000 },
      { sequence: 3, type: 'relay-connected', attemptId, transport: 'worker-relay', observedAtMs: 3000 },
      { sequence: 4, type: 'transfer-complete', attemptId, transport: 'worker-relay', observedAtMs: 4000 },
    ],
  };
}

function rawDeployment() {
  return { repository: 'Nolane-x/file-qr', workflow: 'Deploy Web', workflowRunId: 123, event: 'push', headBranch: 'main', commitSha: SHA };
}

function execForDeploy() {
  return (endpoint) => {
    if (endpoint.endsWith('/branches/main')) return JSON.stringify({ name: 'main', commit: { sha: SHA } });
    return JSON.stringify({ id: 123, name: 'Deploy Web', event: 'push', head_branch: 'main', head_sha: SHA, status: 'completed', conclusion: 'success', repository: { full_name: 'Nolane-x/file-qr' } });
  };
}

function input(deployment, overrides = {}) {
  return {
    deployment,
    productionOrigin: ORIGIN,
    sourceSha256: HASH,
    receivedSha256: HASH,
    sender: journal('sender'),
    receiver: journal('receiver'),
    ...overrides,
  };
}

test('validator requires live deployment authority and natural direct exhaustion before worker transport', () => {
  assert.equal(typeof evidence.validateRestrictiveRelayEvidence, 'function');
  const deployment = evidence.resolveWebDeploy({ runId: 123, execGh: execForDeploy() });
  const proof = evidence.validateRestrictiveRelayEvidence(input(deployment));
  assert.equal(proof.result, 'PASS');
  assert.equal(proof.sourceCommit, SHA);
  assert.equal(proof.attemptId, 7);
  assert.deepEqual(proof.sequence, ['direct-started', 'direct-exhausted', 'relay-connected', 'transfer-complete']);

  assert.throws(() => evidence.validateRestrictiveRelayEvidence(input(rawDeployment())), /AUTHORITY/);
  assert.throws(() => evidence.validateRestrictiveRelayEvidence(input(deployment, { sender: journal('sender', true) })), /forced relay/i);
  assert.throws(() => evidence.validateRestrictiveRelayEvidence(input(deployment, { receivedSha256: 'c'.repeat(64) })), /SHA-256/i);
  assert.throws(() => evidence.validateRestrictiveRelayEvidence(input(deployment, { receiver: journal('receiver', false, 8) })), /attempt/i);
  assert.throws(() => evidence.validateRestrictiveRelayEvidence(input(deployment, { productionOrigin: 'https://example.invalid' })), /canonical production origin/i);

  const missingExhaustion = journal('sender');
  missingExhaustion.events.splice(1, 1);
  assert.throws(() => evidence.validateRestrictiveRelayEvidence(input(deployment, { sender: missingExhaustion })), /direct-exhausted/i);

  const invalidJournal = journal('receiver');
  invalidJournal.invalid = true;
  assert.throws(() => evidence.validateRestrictiveRelayEvidence(input(deployment, { receiver: invalidJournal })), /valid enabled evidence record/i);

  assert.throws(() => evidence.validateRestrictiveRelayEvidence(input(deployment, { sender: { ...journal('sender'), extra: true } })), /unknown or missing fields/i);
});

test('file finalizer reads endpoint journals and atomically publishes only validated PASS evidence', () => {
  assert.equal(typeof evidence.finalizeRestrictiveRelayEvidenceFiles, 'function');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fileqr-relay-evidence-'));
  try {
    const senderPath = path.join(dir, 'sender.json');
    const receiverPath = path.join(dir, 'receiver.json');
    const outputPath = path.join(dir, 'proof.json');
    fs.writeFileSync(senderPath, JSON.stringify(journal('sender')));
    fs.writeFileSync(receiverPath, JSON.stringify(journal('receiver')));

    const record = evidence.finalizeRestrictiveRelayEvidenceFiles({
      deployRunId: 123,
      productionOrigin: ORIGIN,
      sourceSha256: HASH,
      receivedSha256: HASH,
      senderPath,
      receiverPath,
      outputPath,
      execGh: execForDeploy(),
    });

    assert.equal(record.result, 'PASS');
    assert.deepEqual(JSON.parse(fs.readFileSync(outputPath, 'utf8')), record);
    assert.equal(fs.statSync(outputPath).mode & 0o777, 0o600);

    const invalidOutput = path.join(dir, 'invalid-proof.json');
    fs.writeFileSync(invalidOutput, JSON.stringify({ result: 'PASS', stale: true }));
    fs.writeFileSync(senderPath, JSON.stringify(journal('sender', true)));
    assert.throws(() => evidence.finalizeRestrictiveRelayEvidenceFiles({
      deployRunId: 123,
      productionOrigin: ORIGIN,
      sourceSha256: HASH,
      receivedSha256: HASH,
      senderPath,
      receiverPath,
      outputPath: invalidOutput,
      execGh: execForDeploy(),
    }), /forced relay/i);
    assert.equal(fs.existsSync(invalidOutput), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('operator CLI resolves live deploy authority and writes a validated restrictive-relay PASS record', () => {
  const cliPath = path.resolve('scripts/finalize-restrictive-relay-evidence.mjs');
  assert.equal(fs.existsSync(cliPath), true, 'operator finalizer CLI must exist');

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fileqr-relay-cli-'));
  try {
    const binDir = path.join(dir, 'bin');
    fs.mkdirSync(binDir);
    const fakeGh = path.join(binDir, 'gh');
    fs.writeFileSync(fakeGh, `#!/usr/bin/env node\nconst endpoint = process.argv[3] || '';\nconst sha = '${SHA}';\nif (endpoint.endsWith('/branches/main')) {\n  process.stdout.write(JSON.stringify({ name: 'main', commit: { sha } }));\n} else {\n  process.stdout.write(JSON.stringify({ id: 123, name: 'Deploy Web', event: 'push', head_branch: 'main', head_sha: sha, status: 'completed', conclusion: 'success', repository: { full_name: 'Nolane-x/file-qr' } }));\n}\n`);
    fs.chmodSync(fakeGh, 0o755);

    const senderPath = path.join(dir, 'sender.json');
    const receiverPath = path.join(dir, 'receiver.json');
    const outputPath = path.join(dir, 'proof.json');
    fs.writeFileSync(senderPath, JSON.stringify(journal('sender')));
    fs.writeFileSync(receiverPath, JSON.stringify(journal('receiver')));

    const result = spawnSync(process.execPath, [
      cliPath,
      '--deploy-run-id', '123',
      '--production-origin', ORIGIN,
      '--source-sha256', HASH,
      '--received-sha256', HASH,
      '--sender', senderPath,
      '--receiver', receiverPath,
      '--output', outputPath,
    ], {
      encoding: 'utf8',
      env: { ...process.env, PATH: `${binDir}${path.delimiter}${process.env.PATH || ''}` },
    });

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /PASS/);
    const record = JSON.parse(fs.readFileSync(outputPath, 'utf8'));
    assert.equal(record.result, 'PASS');
    assert.equal(record.sourceCommit, SHA);
    assert.equal(record.deployRunId, 123);
    assert.equal(record.forcedRelay, false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
