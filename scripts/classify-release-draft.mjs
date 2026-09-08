export function classifyReleaseDraft(metadata, {
  expectedRepository,
  expectedWorkflow,
} = {}) {
  if (metadata?.author?.login !== 'github-actions[bot]') {
    return 'foreign-or-ambiguous-draft';
  }

  const markerPrefix = `<!-- file-qr-native-release:v1 repo=${expectedRepository} workflow=${expectedWorkflow} target=`;
  if (typeof metadata?.body !== 'string' || !metadata.body.includes(markerPrefix)) {
    return 'foreign-or-ambiguous-draft';
  }

  return 'recoverable-owned-draft';
}
