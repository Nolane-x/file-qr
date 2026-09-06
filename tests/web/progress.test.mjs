import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const moduleUrl = new URL('../../apps/web/src/progress.js', import.meta.url);

test('ETA formatting stays bounded and readable', async () => {
  assert.ok(fs.existsSync(moduleUrl), 'progress module must exist');
  const { formatEta, estimateEta } = await import(moduleUrl);
  assert.equal(formatEta(42_000), '~42s left');
  assert.equal(formatEta(492_000), '~8m 12s left');
  assert.equal(formatEta(3_840_000), '~1h 04m left');
  assert.equal(estimateEta(0, 100, 1_000), null);
  assert.equal(estimateEta(50, 100, 5_000), '~5s left');
  assert.equal(estimateEta(100, 100, 5_000), null);
});
