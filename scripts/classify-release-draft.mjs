const FULL_SHA = /^[0-9a-f]{40}$/;

export function classifyReleaseDraft(metadata, {
  expectedRepository,
  expectedWorkflow,
} = {}) {
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
