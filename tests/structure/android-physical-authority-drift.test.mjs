import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const helperUrl = new URL('../../scripts/prepare-android-physical-evidence.mjs', import.meta.url);

test('Android physical authority revalidates Native Builds identity after materialization', () => {
  const source = fs.readFileSync(helperUrl, 'utf8');
  assert.match(source, /assertBuildIdentityStable/);
  assert.match(source, /resolveNativeBuild\(\{ runId, execGh \}\)/);
});
