import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const triggerUrl = new URL('../../.github/workflows/premerge-native-publisher-proof-trigger.yml', import.meta.url);
assert.ok(fs.existsSync(triggerUrl), 'trusted publisher-proof label trigger workflow must exist');
const workflow = fs.readFileSync(triggerUrl, 'utf8');

test('publisher-proof trigger is label-only and fail-closed to same-repository main PRs', () => {
  assert.match(workflow, /pull_request_target:\s*\n\s+types:\s*\[labeled\]/);
  assert.doesNotMatch(workflow, /\n\s{2}(pull_request|push|workflow_run|workflow_dispatch):/);
  assert.match(workflow, /github\.event\.action\s*==\s*['"]labeled['"]/);
  assert.match(workflow, /github\.event\.label\.name\s*==\s*['"]publisher-proof['"]/);
  assert.match(workflow, /github\.event\.pull_request\.base\.ref\s*==\s*['"]main['"]/);
  assert.match(workflow, /github\.event\.pull_request\.head\.repo\.full_name\s*==\s*github\.repository/);
});

test('publisher-proof trigger rejects PR head, repository, base, and trusted-main drift', () => {
  assert.match(workflow, /github\.event\.pull_request\.head\.sha/);
  assert.match(workflow, /github\.event\.pull_request\.number/);
  assert.match(workflow, /gh api[^\n]*repos\/\$GITHUB_REPOSITORY\/pulls\/\$PR_NUMBER/);
  assert.match(workflow, /\.head\.sha/);
  assert.match(workflow, /\.head\.repo\.full_name/);
  assert.match(workflow, /\.base\.ref/);
  assert.match(workflow, /publisher-proof PR head changed after label/i);
  assert.match(workflow, /publisher-proof PR repository changed after label/i);
  assert.match(workflow, /publisher-proof PR base changed after label/i);
  assert.match(workflow, /repos\/\$GITHUB_REPOSITORY\/git\/ref\/heads\/main/);
  assert.match(workflow, /trusted main advanced after publisher-proof trigger/i);
});

test('publisher-proof trigger dispatches only the exact event head to the trusted manual proof workflow', () => {
  assert.match(workflow, /premerge-native-publisher-proof\.yml/);
  assert.match(workflow, /candidate_sha=/);
  assert.match(workflow, /EVENT_HEAD_SHA/);
  assert.match(workflow, /--ref\s+main/);
});

test('publisher-proof trigger never checks out or executes candidate repository code', () => {
  assert.doesNotMatch(workflow, /actions\/checkout/);
  assert.doesNotMatch(workflow, /secrets\./);
  assert.doesNotMatch(workflow, /npm (?:install|ci|run)/);
  assert.doesNotMatch(workflow, /\bnode\b/);
  assert.match(workflow, /actions:\s*write/);
  assert.match(workflow, /contents:\s*read/);
  assert.match(workflow, /pull-requests:\s*read/);
});
