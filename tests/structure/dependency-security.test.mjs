import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

function read(path) {
  return fs.readFileSync(new URL(path, import.meta.url), 'utf8');
}

test('Cloudflare tooling resolves the patched Undici v7 security release', () => {
  const pkg = JSON.parse(read('../../package.json'));
  const lock = JSON.parse(read('../../package-lock.json'));
  const undici = lock.packages?.['node_modules/undici'];

  assert.equal(pkg.overrides?.undici, '7.29.1', 'root policy must override the vulnerable transitive Undici leaf');
  assert.equal(undici?.version, '7.29.1', 'package lock must resolve patched Undici 7.29.1');
  assert.equal(undici?.resolved, 'https://registry.npmjs.org/undici/-/undici-7.29.1.tgz');
});

test('CI fails closed on future high or critical npm advisories', () => {
  const yml = read('../../.github/workflows/ci.yml');
  assert.ok(yml.includes('npm audit --audit-level=high'), 'CI must reject High/Critical npm audit findings');
});
