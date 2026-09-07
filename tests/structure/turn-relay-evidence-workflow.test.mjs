import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const workflowUrl = new URL('../../.github/workflows/turn-relay-evidence.yml', import.meta.url);
const harnessUrl = new URL('../browser/production-turn-relay.mjs', import.meta.url);

test('production TURN evidence workflow runs after deploy and around trusted evidence changes', () => {
  assert.ok(fs.existsSync(workflowUrl), 'TURN relay evidence workflow must exist');
  const workflow = fs.readFileSync(workflowUrl, 'utf8');

  assert.match(workflow, /workflow_run:/);
  assert.match(workflow, /workflows:\s*\[?['"]?Deploy Signaling['"]?\]?/);
  assert.match(workflow, /workflow_dispatch:/);
  assert.match(workflow, /push:/);
  assert.match(workflow, /pull_request:/);
  assert.match(workflow, /branches:\s*\[main\]/);
  assert.match(workflow, /\.github\/workflows\/turn-relay-evidence\.yml/);
  assert.match(workflow, /tests\/browser\/production-turn-relay\.mjs/);
  assert.match(workflow, /github\.event_name\s*==\s*['"]push['"]/);
  assert.match(workflow, /github\.event_name\s*==\s*['"]pull_request['"]/);
  assert.match(workflow, /github\.event\.pull_request\.head\.repo\.full_name\s*==\s*github\.repository/);
  assert.match(workflow, /github\.event\.workflow_run\.conclusion\s*==\s*['"]success['"]/);
  assert.match(workflow, /playwright@1\.63\.0/);
  assert.match(workflow, /production-turn-relay\.mjs/);
  assert.match(workflow, /upload-artifact@v4/);
  assert.match(workflow, /turn-relay-evidence\.json/);
});

test('production TURN relay harness is fail-closed and never records TURN credentials', () => {
  assert.ok(fs.existsSync(harnessUrl), 'TURN relay harness must exist');
  const harness = fs.readFileSync(harnessUrl, 'utf8');

  assert.match(harness, /iceTransportPolicy:\s*['"]relay['"]/);
  assert.match(harness, /\/v1\/sessions/);
  assert.match(harness, /\/v1\/turn-credentials/);
  assert.match(harness, /selectedCandidateType/);
  assert.match(harness, /relay/);
  assert.match(harness, /turn-relay-evidence\.json/);
  assert.match(harness, /throw new Error/);

  assert.ok(!/credential\s*:\s*iceServer\.credential/.test(harness));
  assert.ok(!/username\s*:\s*iceServer\.username/.test(harness));
});

test('TURN relay evidence workflow is a secretless verifier with no production mutation path', () => {
  assert.ok(fs.existsSync(workflowUrl), 'TURN relay evidence workflow must exist');
  const workflow = fs.readFileSync(workflowUrl, 'utf8');

  assert.doesNotMatch(workflow, /bootstrap-production-turn\.mjs/);
  assert.doesNotMatch(workflow, /Bootstrap production TURN/i);
  assert.doesNotMatch(workflow, /CLOUDFLARE_ACCOUNT_ID/);
  assert.doesNotMatch(workflow, /CLOUDFLARE_API_TOKEN/);
  assert.doesNotMatch(workflow, /CLOUDFLARE_CALLS_API_TOKEN/);
  assert.doesNotMatch(workflow, /secrets\./);
});
