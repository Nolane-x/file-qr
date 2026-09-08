import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const helperUrl = new URL('../../scripts/classify-release-draft.mjs', import.meta.url);

const repo = 'Nolane-x/file-qr';
const workflow = '.github/workflows/native.yml';
const tag = 'v0.4.0';
const target = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const marker = `<!-- file-qr-native-release:v1 repo=${repo} workflow=${workflow} target=${target} -->`;

test('trusted stale CI draft is classified as recoverable', async () => {
  assert.ok(fs.existsSync(helperUrl), 'release draft ownership classifier must exist');
  const { classifyReleaseDraft } = await import(helperUrl.href);
  const decision = classifyReleaseDraft({
    isDraft: true,
    tagName: tag,
    author: { login: 'github-actions[bot]' },
    targetCommitish: target,
    body: `${marker}\n\nGenerated release notes`,
  }, {
    expectedTag: tag,
    expectedRepository: repo,
    expectedWorkflow: workflow,
  });

  assert.equal(decision, 'recoverable-owned-draft');
});
