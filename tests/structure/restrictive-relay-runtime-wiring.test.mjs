import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const root = new URL('../../', import.meta.url);
const read = (file) => fs.readFileSync(new URL(file, root), 'utf8');

test('relay evidence wiring observes production transitions without steering policy', () => {
  const session = read('apps/web/src/runtime-session.js');
  const direct = read('apps/web/src/runtime-direct.js');
  const relay = read('apps/web/src/runtime-relay.js');
  const transfer = read('apps/web/src/runtime-transfer.js');
  const policy = read('apps/web/src/transport-policy.js');

  assert.match(session, /relayEvidence\.reset\(\)/);
  assert.match(session, /searchParams\.set\(['"]relayEvidence['"],\s*['"]1['"]\)/);
  assert.match(direct, /relayEvidence\.directStarted/);
  assert.match(direct, /relayEvidence\.directExhausted/);
  assert.match(relay, /relayEvidence\.relayConnected/);
  assert.match(transfer, /relayEvidence\.transferComplete/);
  assert.doesNotMatch(policy, /relayEvidence/i);
});
