import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const root = new URL('../../', import.meta.url);

test('restrictive relay evidence kit exists without changing transport policy', () => {
  const moduleUrl = new URL('apps/web/src/relay-evidence.js', root);
  const validatorUrl = new URL('scripts/validate-restrictive-relay-evidence.mjs', root);
  const policy = fs.readFileSync(new URL('apps/web/src/transport-policy.js', root), 'utf8');
  assert.equal(fs.existsSync(moduleUrl), true, 'relay evidence module must exist');
  assert.equal(fs.existsSync(validatorUrl), true, 'relay evidence validator must exist');
  assert.doesNotMatch(policy, /relayEvidence/i, 'evidence observability must not influence transport policy');
});
