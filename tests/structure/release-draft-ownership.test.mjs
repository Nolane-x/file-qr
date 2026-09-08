import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const helperUrl = new URL('../../scripts/classify-release-draft.mjs', import.meta.url);
const nativeWorkflowUrl = new URL('../../.github/workflows/native.yml', import.meta.url);

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

test('classifier CLI emits the decision for workflow metadata JSON', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fileqr-release-state-'));
  const metadataPath = path.join(dir, 'release.json');
  fs.writeFileSync(metadataPath, JSON.stringify({
    isDraft: true,
    tagName: tag,
    author: { login: 'github-actions[bot]' },
    targetCommitish: target,
    body: `${marker}\n\nGenerated notes`,
  }));

  const result = spawnSync(process.execPath, [
    fileURLToPath(helperUrl),
    metadataPath,
    tag,
    repo,
    workflow,
  ], { encoding: 'utf8' });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), 'recoverable-owned-draft');
});

test('native release workflow deletes only an owned stale draft and marks new drafts', () => {
  const nativeWorkflow = fs.readFileSync(nativeWorkflowUrl, 'utf8');
  const stateStart = nativeWorkflow.indexOf('Check whether package-version release already exists');
  const manifestStart = nativeWorkflow.indexOf('Create deterministic SHA-256 release manifest');
  assert.ok(stateStart >= 0 && manifestStart > stateStart, 'release-state section must exist');
  const stateSection = nativeWorkflow.slice(stateStart, manifestStart);

  assert.match(stateSection, /--json\s+(?:author,body,isDraft,tagName,targetCommitish|isDraft,author,body,targetCommitish,tagName)/);
  assert.match(stateSection, /classify-release-draft\.mjs/);
  assert.match(stateSection, /recoverable-owned-draft/);
  assert.match(stateSection, /published-existing-release/);
  assert.match(stateSection, /foreign-or-ambiguous-draft/);
  assert.match(stateSection, /Refusing to delete.*foreign|foreign.*refusing to delete/i);
  assert.doesNotMatch(stateSection, /if \[ "\$is_draft" = ['"]true['"] \]; then/);

  const deleteIndex = stateSection.indexOf('gh release delete "$TAG"');
  const recoverIndex = stateSection.indexOf('recoverable-owned-draft');
  const foreignIndex = stateSection.indexOf('foreign-or-ambiguous-draft');
  assert.ok(recoverIndex >= 0 && deleteIndex > recoverIndex, 'delete must be downstream of owned-draft decision');
  assert.ok(foreignIndex > deleteIndex, 'foreign fail-closed branch must remain separate from deletion');

  const createStart = nativeWorkflow.indexOf('Create draft package-version release');
  const verifyStart = nativeWorkflow.indexOf('Verify draft release bytes and attestations');
  assert.ok(createStart >= 0 && verifyStart > createStart, 'draft create section must exist');
  const createSection = nativeWorkflow.slice(createStart, verifyStart);
  assert.match(createSection, /file-qr-native-release:v1 repo=\$GITHUB_REPOSITORY workflow=\.github\/workflows\/native\.yml target=\$GITHUB_SHA/);
  assert.match(createSection, /--notes\s+"\$OWNERSHIP_MARKER"/);
  assert.match(createSection, /--generate-notes/);
  assert.match(createSection, /--draft/);
});
