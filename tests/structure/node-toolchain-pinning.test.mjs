import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const workflowsDir = path.resolve(here, '../../.github/workflows');
const expectedNode = '24.20.0';

test('trusted workflows pin one exact Node patch version', () => {
  const violations = [];
  let setupNodeSteps = 0;

  for (const name of fs.readdirSync(workflowsDir).filter((entry) => /\.ya?ml$/i.test(entry)).sort()) {
    const file = path.join(workflowsDir, name);
    const source = fs.readFileSync(file, 'utf8');
    const setupCount = (source.match(/uses:\s*actions\/setup-node@[0-9a-f]{40}/g) || []).length;
    if (setupCount === 0) continue;

    setupNodeSteps += setupCount;
    const versions = [...source.matchAll(/node-version:\s*['\"]?([^'\"\s#]+)['\"]?/g)].map((match) => match[1]);

    if (versions.length !== setupCount) {
      violations.push(`${name}: expected ${setupCount} node-version entries for ${setupCount} setup-node steps, found ${versions.length}`);
      continue;
    }

    for (const version of versions) {
      if (version !== expectedNode) {
        violations.push(`${name}: node-version must be ${expectedNode}, found ${version}`);
      }
    }
  }

  assert.ok(setupNodeSteps > 0, 'expected at least one trusted setup-node step');
  assert.deepEqual(violations, []);
});
