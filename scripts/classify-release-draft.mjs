export function classifyReleaseDraft(metadata) {
  if (metadata?.author?.login !== 'github-actions[bot]') {
    return 'foreign-or-ambiguous-draft';
  }
  return 'recoverable-owned-draft';
}
