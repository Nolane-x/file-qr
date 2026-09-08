import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const helperUrl = new URL('../../scripts/classify-release-draft.mjs', import.meta.url);

const repo = 'Nolane-x/file-qr';
const workflow = '.github/workflows/native.yml';
const tag = 'v0.4.0';
const target = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const marker = `<!-- file-qr-native-release:v1 repo=${repo} workflow=${workflow} target=${target} -->`;

async function classify(metadata) {
  assert.ok(fs.existsSync(helperUrl), 'release draft ownership classifier must exist');
  const { classifyReleaseDraft } = await import(`${helperUrl.href}?case=${Date.now()}-${Math.random()}`);
  return classifyReleaseDraft(metadata, {
    expectedTag: tag,
    expectedRepository: repo,
    expectedWorkflow: workflow,
  });
}

test('trusted stale CI draft is classified as recoverable', async () => {
  const decision = await classify({
    isDraft: true,
    tagName: tag,
    author: { login: 'github-actions[bot]' },
    targetCommitish: target,
    body: `${marker}\n\nGenerated release notes`,
  });

  assert.equal(decision, 'recoverable-owned-draft');
});

test('foreign manual draft fails closed instead of being recoverable', async () => {
  const decision = await classify({
    isDraft: true,
    tagName: tag,
    author: { login: 'Nolane-x' },
    targetCommitish: target,
    body: `${marker}\n\nManual draft`,
  });

  assert.equal(decision, 'foreign-or-ambiguous-draft');
});
