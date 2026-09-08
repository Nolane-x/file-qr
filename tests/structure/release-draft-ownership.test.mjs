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

test('bot-authored draft without the exact workflow ownership marker fails closed', async () => {
  const decision = await classify({
    isDraft: true,
    tagName: tag,
    author: { login: 'github-actions[bot]' },
    targetCommitish: target,
    body: '<!-- some-other-automation -->\n\nGenerated notes',
  });

  assert.equal(decision, 'foreign-or-ambiguous-draft');
});

test('ownership marker target must exactly match release targetCommitish', async () => {
  const otherTarget = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
  const wrongMarker = `<!-- file-qr-native-release:v1 repo=${repo} workflow=${workflow} target=${otherTarget} -->`;
  const decision = await classify({
    isDraft: true,
    tagName: tag,
    author: { login: 'github-actions[bot]' },
    targetCommitish: target,
    body: `${wrongMarker}\n\nGenerated notes`,
  });

  assert.equal(decision, 'foreign-or-ambiguous-draft');
});

test('draft tag must exactly match the package-version tag being recovered', async () => {
  const decision = await classify({
    isDraft: true,
    tagName: 'v9.9.9',
    author: { login: 'github-actions[bot]' },
    targetCommitish: target,
    body: `${marker}\n\nGenerated notes`,
  });

  assert.equal(decision, 'foreign-or-ambiguous-draft');
});

test('published release is classified as existing and never enters draft recovery', async () => {
  const decision = await classify({
    isDraft: false,
    tagName: tag,
    author: { login: 'Nolane-x' },
    targetCommitish: 'main',
    body: 'Published release notes without any CI ownership marker',
  });

  assert.equal(decision, 'published-existing-release');
});
