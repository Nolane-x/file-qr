import test from 'node:test';
import assert from 'node:assert/strict';
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
