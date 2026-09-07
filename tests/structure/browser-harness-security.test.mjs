import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const workflow = fs.readFileSync(new URL('../../.github/workflows/browser-reliability.yml', import.meta.url), 'utf8');

function compareSemver(left, right) {
  const a = left.split('.').map(Number);
  const b = right.split('.').map(Number);
  for (let i = 0; i < 3; i += 1) {
    if (a[i] !== b[i]) return a[i] - b[i];
  }
  return 0;
}

test('browser reliability harness avoids the vulnerable Playwright installer range', () => {
  const match = workflow.match(/playwright@(\d+\.\d+\.\d+)/);
  assert.ok(match, 'browser workflow must pin an explicit Playwright version');
  assert.ok(
    compareSemver(match[1], '1.55.1') >= 0,
    `Playwright ${match[1]} is in the CVE-2025-59288 affected range (<1.55.1)`,
  );
});
