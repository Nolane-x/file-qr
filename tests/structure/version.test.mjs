import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

function read(path) { return fs.readFileSync(new URL(path, import.meta.url), 'utf8'); }

test('v0.2 release metadata is aligned across JS, Tauri and Rust', () => {
  const root = JSON.parse(read('../../package.json'));
  const tauri = JSON.parse(read('../../apps/native/src-tauri/tauri.conf.json'));
  const cargo = read('../../apps/native/src-tauri/Cargo.toml');
  assert.equal(root.version, '0.2.0');
  assert.equal(tauri.version, '0.2.0');
  assert.match(cargo, /version = "0\.2\.0"/);
});
