import test from 'node:test';
import assert from 'node:assert/strict';
import { createIceRecoveryController, detectSelectedCandidateType } from '../../apps/web/src/webrtc.js';

test('hard ICE failure restarts and renegotiates at most once per attempt', async () => {
  let restarts = 0;
  let renegotiations = 0;
  let exhausted = 0;
  const peer = { restartIce() { restarts += 1; } };
  const controller = createIceRecoveryController(
    peer,
    async () => { renegotiations += 1; },
    { onExhausted() { exhausted += 1; } },
  );

  assert.equal(await controller.handleState('failed'), 'restarted');
  assert.equal(await controller.handleState('failed'), 'exhausted');
  assert.equal(restarts, 1);
  assert.equal(renegotiations, 1);
  assert.equal(exhausted, 1);
  assert.equal(controller.restartUsed, true);
});

test('disconnected gets a grace period and connected cancels pending recovery', async () => {
  let scheduled = null;
  let cancelled = 0;
  let restarts = 0;
  const peer = { restartIce() { restarts += 1; } };
  const controller = createIceRecoveryController(peer, async () => {}, {
    graceMs: 5000,
    schedule(fn, ms) { scheduled = { fn, ms }; return 77; },
    cancel(id) { if (id === 77) cancelled += 1; },
  });

  assert.equal(await controller.handleState('disconnected'), 'waiting');
  assert.equal(scheduled.ms, 5000);
  assert.equal(await controller.handleState('connected'), 'connected');
  assert.equal(cancelled, 1);
  assert.equal(restarts, 0);
});

test('selected candidate diagnostics distinguish relay from direct paths', async () => {
  const directStats = new Map([
    ['transport', { id: 'transport', type: 'transport', selectedCandidatePairId: 'pair' }],
    ['pair', { id: 'pair', type: 'candidate-pair', state: 'succeeded', localCandidateId: 'local', remoteCandidateId: 'remote' }],
    ['local', { id: 'local', type: 'local-candidate', candidateType: 'srflx' }],
    ['remote', { id: 'remote', type: 'remote-candidate', candidateType: 'host' }],
  ]);
  assert.equal(await detectSelectedCandidateType({ async getStats() { return directStats; } }), 'direct');

  const relayStats = new Map([
    ['transport', { id: 'transport', type: 'transport', selectedCandidatePairId: 'pair' }],
    ['pair', { id: 'pair', type: 'candidate-pair', state: 'succeeded', localCandidateId: 'local', remoteCandidateId: 'remote' }],
    ['local', { id: 'local', type: 'local-candidate', candidateType: 'relay' }],
    ['remote', { id: 'remote', type: 'remote-candidate', candidateType: 'srflx' }],
  ]);
  assert.equal(await detectSelectedCandidateType({ async getStats() { return relayStats; } }), 'relay');
  assert.equal(await detectSelectedCandidateType({ async getStats() { return new Map(); } }), 'unknown');
});
