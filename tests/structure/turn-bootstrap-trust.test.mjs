import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const workflowUrl = new URL('../../.github/workflows/turn-bootstrap.yml', import.meta.url);
const bootstrapUrl = new URL('../../scripts/bootstrap-production-turn.mjs', import.meta.url);

test('production TURN bootstrap is manual-only and refuses non-main refs before checkout', () => {
  assert.ok(fs.existsSync(workflowUrl), 'trusted TURN bootstrap workflow must exist');
  const workflow = fs.readFileSync(workflowUrl, 'utf8');

  assert.match(workflow, /workflow_dispatch:/);
  assert.doesNotMatch(workflow, /pull_request:/);
  assert.doesNotMatch(workflow, /pull_request_target:/);
  assert.doesNotMatch(workflow, /workflow_run:/);
  assert.doesNotMatch(workflow, /\n\s{2}push:/);
  assert.match(workflow, /permissions:\s*\n\s{2}contents:\s*read/);
  assert.match(
    workflow,
    /\n\s{2}bootstrap:\s*\n\s{4}if:\s*github\.ref\s*==\s*['"]refs\/heads\/main['"]\s*&&\s*github\.actor\s*==\s*github\.repository_owner/,
  );
  assert.match(workflow, /actions\/checkout@v6[\s\S]*ref:\s*main/);
});

test('trusted TURN bootstrap keeps Calls creation and Worker secret-write credentials separate', () => {
  assert.ok(fs.existsSync(workflowUrl), 'trusted TURN bootstrap workflow must exist');
  const workflow = fs.readFileSync(workflowUrl, 'utf8');

  assert.match(workflow, /CLOUDFLARE_ACCOUNT_ID:\s*\$\{\{\s*secrets\.CLOUDFLARE_ACCOUNT_ID\s*\}\}/);
  assert.match(workflow, /CLOUDFLARE_API_TOKEN:\s*\$\{\{\s*secrets\.CLOUDFLARE_API_TOKEN\s*\}\}/);
  assert.match(workflow, /CLOUDFLARE_CALLS_API_TOKEN:\s*\$\{\{\s*secrets\.CLOUDFLARE_CALLS_API_TOKEN\s*\}\}/);
  assert.match(workflow, /bootstrap-production-turn\.mjs/);
});

test('TURN bootstrap script is fail-closed, masks generated key material, and writes only Worker TURN secrets', () => {
  assert.ok(fs.existsSync(bootstrapUrl), 'production TURN bootstrap script must exist');
  const script = fs.readFileSync(bootstrapUrl, 'utf8');

  assert.match(script, /\/v1\/sessions/);
  assert.match(script, /\/v1\/turn-credentials/);
  assert.match(script, /turn-not-configured/);
  assert.match(script, /CLOUDFLARE_CALLS_API_TOKEN/);
  assert.match(script, /callsApiToken/);
  assert.match(script, /calls\/turn_keys/);
  assert.match(script, /authorization:\s*`Bearer \$\{callsApiToken\}`/);
  assert.match(script, /Calls Write/);
  assert.match(script, /CLOUDFLARE_API_TOKEN/);
  assert.match(script, /wrangler/);
  assert.match(script, /secret/);
  assert.match(script, /bulk/);
  assert.match(script, /TURN_KEY_ID/);
  assert.match(script, /TURN_KEY_API_TOKEN/);
  assert.match(script, /add-mask/);
  assert.match(script, /file-qr-signaling-production/);
  assert.ok(!/console\.log\([^\n]*(?:TURN_KEY_API_TOKEN|result\.key|turnKey)/.test(script));
});
