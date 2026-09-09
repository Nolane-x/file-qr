import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

function read(path) {
  return fs.readFileSync(new URL(path, import.meta.url), 'utf8');
}

function readOptional(path) {
  try {
    return read(path);
  } catch (error) {
    if (error?.code === 'ENOENT') return '';
    throw error;
  }
}

test('dependency install scripts are fail-closed and explicitly reviewed', () => {
  const pkg = JSON.parse(read('../../package.json'));
  const npmrc = readOptional('../../.npmrc');
  const violations = [];

  if (!/^strict-allow-scripts=true$/m.test(npmrc)) {
    violations.push('.npmrc must enable strict-allow-scripts=true');
  }
  if (pkg.allowScripts?.['esbuild@0.28.1'] !== false) {
    violations.push('esbuild@0.28.1 install script must be explicitly denied');
  }
  if (pkg.allowScripts?.['workerd@1.20260903.1'] !== false) {
    violations.push('workerd@1.20260903.1 install script must be explicitly denied');
  }

  assert.deepEqual(violations, []);
});
