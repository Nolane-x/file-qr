import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const workflowDir = fileURLToPath(new URL('../../.github/workflows/', import.meta.url));

function workflowFiles() {
  return fs.readdirSync(workflowDir)
    .filter((name) => /\.ya?ml$/i.test(name))
    .sort();
}

function externalUses(content) {
  const refs = [];
  const pattern = /^\s*(?:-\s*)?uses:\s*([^\s#]+).*$/gm;
  for (const match of content.matchAll(pattern)) {
    const target = match[1];
    if (target.startsWith('./') || target.startsWith('docker://')) continue;
    refs.push(target);
  }
  return refs;
}

test('every external GitHub Action is pinned to an immutable commit SHA', () => {
  const mutable = [];

  for (const name of workflowFiles()) {
    const content = fs.readFileSync(path.join(workflowDir, name), 'utf8');
    for (const target of externalUses(content)) {
      const at = target.lastIndexOf('@');
      const ref = at === -1 ? '' : target.slice(at + 1);
      if (!/^[a-f0-9]{40}$/i.test(ref)) mutable.push(`${name}: ${target}`);
    }
  }

  assert.deepEqual(
    mutable,
    [],
    `external GitHub Actions must use full 40-hex commit SHAs:\n${mutable.join('\n')}`,
  );
});
