import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const workflowUrl = new URL('../../.github/workflows/signaling.yml', import.meta.url);

test('manual production signaling deploy refuses non-main refs before secret-bearing steps', () => {
  const workflow = fs.readFileSync(workflowUrl, 'utf8');

  assert.match(workflow, /workflow_dispatch:/);
  assert.match(
    workflow,
    /\n\s{2}deploy:\s*\n\s{4}if:\s*github\.event_name\s*!=\s*['"]workflow_dispatch['"]\s*\|\|\s*github\.ref\s*==\s*['"]refs\/heads\/main['"]/,
  );
  assert.match(workflow, /CLOUDFLARE_API_TOKEN/);
  assert.match(workflow, /CLOUDFLARE_ACCOUNT_ID/);
  assert.doesNotMatch(workflow, /pull_request_target:/);
});
