import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const yml = fs.readFileSync(new URL('../../.github/workflows/signaling.yml', import.meta.url), 'utf8');

test('signaling deploy follows relevant main changes and keeps manual dispatch', () => {
  assert.ok(yml.includes('workflow_dispatch:'), 'manual deploy escape hatch must remain');
  assert.ok(yml.includes('push:'), 'signaling deploy must run automatically on relevant main pushes');
  assert.ok(yml.includes('branches: [main]'));

  for (const path of [
    'services/signaling/**',
    'packages/core/**',
    'package.json',
    'package-lock.json',
    '.github/workflows/signaling.yml',
  ]) {
    assert.ok(yml.includes(path), `missing signaling deploy path trigger: ${path}`);
  }

  assert.ok(yml.includes('group: deploy-signaling-production'));
  assert.ok(yml.includes('cancel-in-progress: false'));
});
