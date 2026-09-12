import test from 'node:test';
import assert from 'node:assert/strict';
import { runWorkerRelayProbe } from './production-worker-relay.mjs';

const WEB_ORIGIN = process.env.FILE_QR_BROWSER_ORIGIN || 'http://127.0.0.1:5173';
const FORCE_RELAY_QUERY = 'forceRelay=1&relayEvidence=1';

test('encrypted Worker relay transfers exact bytes and exposes sanitized evidence journal', { timeout: 180_000 }, async () => {
  const evidence = await runWorkerRelayProbe({
    origin: WEB_ORIGIN,
    payloadBytes: 4 * 1024 * 1024 + 137,
    evidencePath: null,
    forceRelayQuery: FORCE_RELAY_QUERY,
    requireProductionOrigin: false,
  });

  assert.equal(evidence.result, 'PASS');
  assert.equal(evidence.transport, 'worker-relay');
  assert.equal(evidence.forcedRelay, true);
  assert.equal(evidence.receivedSha256, evidence.sourceSha256);
  assert.equal(evidence.sender.relaySocketObserved, true);
  assert.equal(evidence.receiver.relaySocketObserved, true);
  assert.equal(evidence.sender.journal.forcedRelay, true);
  assert.equal(evidence.receiver.journal.forcedRelay, true);
  assert.deepEqual(evidence.sender.journal.events.map((event) => event.type), ['relay-connected', 'transfer-complete']);
  assert.deepEqual(evidence.receiver.journal.events.map((event) => event.type), ['relay-connected', 'transfer-complete']);
});
