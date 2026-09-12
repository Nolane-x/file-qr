import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const root = new URL('../../', import.meta.url);
const read = (relative) => fs.readFileSync(new URL(relative, root), 'utf8');

test('evidence hooks use existing files and leave transport policy unchanged', () => {
  const core = read('apps/web/src/runtime-core.js');
  const policy = read('apps/web/src/transport-policy.js');
  const evidence = read('packages/core/physical-evidence.js');
  const authority = read('scripts/physical-evidence-github.mjs');
  assert.match(core, /RELAY_EVIDENCE_MODE/);
  assert.match(core, /FileQrRelayEvidence/);
  assert.match(evidence, /validateRestrictiveRelayEvidence/);
  assert.match(authority, /resolveWebDeploy/);
  assert.doesNotMatch(policy, /relayEvidence/i);
});
