import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveNativeBuild } from '../../scripts/physical-evidence-github.mjs';

const SHA = 'a'.repeat(40);
const H1 = '1'.repeat(64);
const H2 = '2'.repeat(64);

function run(overrides = {}) {
  return {
    id: 123,
    name: 'Native Builds',
    event: 'push',
    head_branch: 'main',
    head_sha: SHA,
    status: 'completed',
    conclusion: 'success',
    repository: { full_name: 'Nolane-x/file-qr' },
    ...overrides,
  };
}

function artifacts(overrides = {}) {
  return {
    artifacts: [
      { id: 10, name: 'file-qr-windows', digest: `sha256:${H1}`, expired: false, workflow_run: { id: 123, head_sha: SHA } },
      { id: 11, name: 'file-qr-android', digest: `sha256:${H2}`, expired: false, workflow_run: { id: 123, head_sha: SHA } },
    ],
    ...overrides,
  };
}

function stub({ runValue = run(), artifactsValue = artifacts() } = {}) {
  return (endpoint) => JSON.stringify(endpoint.endsWith('/artifacts') ? artifactsValue : runValue);
}

test('resolver accepts exactly one successful completed main Native Builds run with both artifacts', () => {
  const resolved = resolveNativeBuild({ runId: 123, execGh: stub() });
  assert.equal(resolved.repository, 'Nolane-x/file-qr');
  assert.equal(resolved.workflow, 'Native Builds');
  assert.equal(resolved.workflowRunId, 123);
  assert.equal(resolved.event, 'push');
  assert.equal(resolved.headBranch, 'main');
  assert.equal(resolved.commitSha, SHA);
  assert.equal(resolved.artifacts.windows.artifactId, 10);
  assert.equal(resolved.artifacts.android.artifactId, 11);
});

test('resolver rejects wrong repository, workflow, event, branch, status and conclusion', () => {
  for (const bad of [
    run({ repository: { full_name: 'other/repo' } }),
    run({ name: 'CI' }),
    run({ event: 'pull_request' }),
    run({ head_branch: 'feature' }),
    run({ status: 'in_progress', conclusion: null }),
    run({ status: 'completed', conclusion: 'failure' }),
    run({ status: 'completed', conclusion: 'cancelled' }),
  ]) {
    assert.throws(() => resolveNativeBuild({ runId: 123, execGh: stub({ runValue: bad }) }), /FQR_EVIDENCE_GITHUB_AUTHORITY/);
  }
});

test('resolver rejects missing, duplicate, expired and malformed artifacts', () => {
  const base = artifacts().artifacts;
  const cases = [
    { artifacts: [base[0]] },
    { artifacts: [base[0], base[0], base[1]] },
    { artifacts: [{ ...base[0], expired: true }, base[1]] },
    { artifacts: [{ ...base[0], digest: 'sha256:nope' }, base[1]] },
    { artifacts: [{ ...base[0], workflow_run: { id: 999, head_sha: SHA } }, base[1]] },
  ];
  for (const value of cases) {
    assert.throws(() => resolveNativeBuild({ runId: 123, execGh: stub({ artifactsValue: value }) }), /FQR_EVIDENCE_GITHUB_ARTIFACT/);
  }
});

test('resolver fails closed on command or JSON errors', () => {
  assert.throws(() => resolveNativeBuild({ runId: 123, execGh: () => { throw new Error('offline'); } }), /FQR_EVIDENCE_GITHUB/);
  assert.throws(() => resolveNativeBuild({ runId: 123, execGh: () => '{bad' }), /FQR_EVIDENCE_GITHUB/);
});
