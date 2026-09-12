import test from 'node:test';
import assert from 'node:assert/strict';
import * as github from '../../scripts/physical-evidence-github.mjs';

const SHA = 'a'.repeat(40);

function execFor(runOverrides = {}, branchSha = SHA) {
  return (endpoint) => {
    if (endpoint.endsWith('/branches/main')) return JSON.stringify({ name: 'main', commit: { sha: branchSha } });
    return JSON.stringify({ id: 123, name: 'Deploy Web', event: 'push', head_branch: 'main', head_sha: SHA, status: 'completed', conclusion: 'success', repository: { full_name: 'Nolane-x/file-qr' }, ...runOverrides });
  };
}

test('web deploy authority requires one successful current-main push', () => {
  assert.equal(typeof github.resolveWebDeploy, 'function');
  const resolved = github.resolveWebDeploy({ runId: 123, execGh: execFor() });
  assert.equal(resolved.commitSha, SHA);
  assert.equal(resolved.workflow, 'Deploy Web');
  assert.throws(() => github.resolveWebDeploy({ runId: 123, execGh: execFor({ event: 'pull_request' }) }), /AUTHORITY/);
  assert.throws(() => github.resolveWebDeploy({ runId: 123, execGh: execFor({}, 'b'.repeat(40)) }), /AUTHORITY/);
});
