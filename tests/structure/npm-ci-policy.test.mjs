import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const workflowDir = fileURLToPath(new URL('../../.github/workflows/', import.meta.url));
const ephemeralPlaywrightInstall = 'npm install --no-save --package-lock=false playwright@1.63.0';

function workflowFiles() {
  return fs.readdirSync(workflowDir)
    .filter((name) => /\.ya?ml$/i.test(name))
    .sort();
}

function mutableProjectInstalls(name, content) {
  const offenders = [];
  for (const [index, line] of content.split(/\r?\n/).entries()) {
    const trimmed = line.trim();
    if (!trimmed.includes('npm install')) continue;
    if (trimmed.includes(ephemeralPlaywrightInstall)) continue;
    offenders.push(`${name}:${index + 1}: ${trimmed}`);
  }
  return offenders;
}

test('trusted workflows use frozen npm ci for repository project installs', () => {
  const offenders = [];

  for (const name of workflowFiles()) {
    const content = fs.readFileSync(path.join(workflowDir, name), 'utf8');
    offenders.push(...mutableProjectInstalls(name, content));
  }

  assert.deepEqual(
    offenders,
    [],
    `trusted workflows must use npm ci for repository project installs; only the explicit no-save Playwright bootstrap is exempt:\n${offenders.join('\n')}`,
  );
});
