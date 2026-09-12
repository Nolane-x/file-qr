import test from 'node:test';
import assert from 'node:assert/strict';
import { runWorkerRelayProbe } from './production-worker-relay.mjs';

const WEB_ORIGIN = process.env.FILE_QR_BROWSER_ORIGIN || 'http://127.0.0.1:5173';
const FORCE_RELAY_QUERY = 'forceRelay=1';

test('encrypted Worker relay transfers exact bytes end to end without direct WebRTC', { timeout: 180_000 }, async () => {
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
});
