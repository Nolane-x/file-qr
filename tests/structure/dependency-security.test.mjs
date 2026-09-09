import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

function read(path) {
  return fs.readFileSync(new URL(path, import.meta.url), 'utf8');
}

test('Cloudflare tooling overrides newly disclosed vulnerable transitive leaves', () => {
  const pkg = JSON.parse(read('../../package.json'));

  assert.equal(pkg.overrides?.undici, '7.29.1', 'root policy must override the vulnerable transitive Undici leaf');
  assert.equal(pkg.overrides?.sharp, '0.35.4', 'root policy must override the vulnerable transitive Sharp leaf');
});

test('CI fails closed on future high or critical npm advisories', () => {
  const yml = read('../../.github/workflows/ci.yml');
  assert.ok(yml.includes('npm audit --audit-level=high'), 'CI must reject High/Critical npm audit findings');
});
