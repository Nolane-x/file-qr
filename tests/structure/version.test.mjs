import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

function read(path) { return fs.readFileSync(new URL(path, import.meta.url), 'utf8'); }

test('release metadata stays aligned across JS, Tauri and Rust', () => {
  const root = JSON.parse(read('../../package.json'));
  const tauri = JSON.parse(read('../../apps/native/src-tauri/tauri.conf.json'));
  const cargo = read('../../apps/native/src-tauri/Cargo.toml');
  const escapedVersion = root.version.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

  assert.match(root.version, /^\d+\.\d+\.\d+$/);
  assert.equal(tauri.version, root.version);
  assert.match(cargo, new RegExp(`^version\\s*=\\s*"${escapedVersion}"$`, 'm'));
});
