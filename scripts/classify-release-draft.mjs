import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const FULL_SHA = /^[0-9a-f]{40}$/;

export function classifyReleaseDraft(metadata, {
  expectedTag,
  expectedRepository,
  expectedWorkflow,
} = {}) {
  if (metadata?.isDraft === false) {
    return 'published-existing-release';
  }
  if (metadata?.isDraft !== true) {
    return 'foreign-or-ambiguous-draft';
  }

  if (metadata?.tagName !== expectedTag) {
    return 'foreign-or-ambiguous-draft';
  }

  if (metadata?.author?.login !== 'github-actions[bot]') {
    return 'foreign-or-ambiguous-draft';
  }

  const target = typeof metadata?.targetCommitish === 'string'
    ? metadata.targetCommitish.toLowerCase()
    : '';
  if (!FULL_SHA.test(target)) {
    return 'foreign-or-ambiguous-draft';
  }

  const exactMarker = `<!-- file-qr-native-release:v1 repo=${expectedRepository} workflow=${expectedWorkflow} target=${target} -->`;
  const markerPresent = typeof metadata?.body === 'string'
    && metadata.body.split(/\r?\n/).some((line) => line.trim() === exactMarker);
  if (!markerPresent) {
    return 'foreign-or-ambiguous-draft';
  }

  return 'recoverable-owned-draft';
}

function runCli() {
  const [metadataPath, expectedTag, expectedRepository, expectedWorkflow] = process.argv.slice(2);
  if (![metadataPath, expectedTag, expectedRepository, expectedWorkflow].every(Boolean)) {
    throw new Error('usage: classify-release-draft.mjs <metadata.json> <tag> <repository> <workflow>');
  }

  const metadata = JSON.parse(fs.readFileSync(metadataPath, 'utf8'));
  const decision = classifyReleaseDraft(metadata, {
    expectedTag,
    expectedRepository,
    expectedWorkflow,
  });
  process.stdout.write(`${decision}\n`);
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : '';
if (invokedPath === fileURLToPath(import.meta.url)) {
  runCli();
}
