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

function input(overrides = {}) {
  return {
    deployment: { repository: 'Nolane-x/file-qr', workflow: 'Deploy Web', workflowRunId: 123, event: 'push', headBranch: 'main', commitSha: SHA },
    productionOrigin: ORIGIN,
    sourceSha256: HASH,
    receivedSha256: HASH,
    sender: journal('sender'),
    receiver: journal('receiver'),
    ...overrides,
  };
}

test('validator requires natural direct exhaustion before worker transport', () => {
  assert.equal(typeof evidence.validateRestrictiveRelayEvidence, 'function');
  const proof = evidence.validateRestrictiveRelayEvidence(input());
  assert.equal(proof.result, 'PASS');
  assert.equal(proof.sourceCommit, SHA);
  assert.equal(proof.attemptId, 7);
  assert.throws(() => evidence.validateRestrictiveRelayEvidence(input({ sender: journal('sender', true) })), /forced relay/i);
  assert.throws(() => evidence.validateRestrictiveRelayEvidence(input({ receivedSha256: 'c'.repeat(64) })), /SHA-256/i);
  assert.throws(() => evidence.validateRestrictiveRelayEvidence(input({ receiver: journal('receiver', false, 8) })), /attempt/i);
});
