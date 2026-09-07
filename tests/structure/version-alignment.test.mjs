import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const TARGET_VERSION = '0.4.0';
const rootPackage = JSON.parse(fs.readFileSync(new URL('../../package.json', import.meta.url), 'utf8'));
const lock = JSON.parse(fs.readFileSync(new URL('../../package-lock.json', import.meta.url), 'utf8'));
const tauri = JSON.parse(fs.readFileSync(new URL('../../apps/native/src-tauri/tauri.conf.json', import.meta.url), 'utf8'));
const cargo = fs.readFileSync(new URL('../../apps/native/src-tauri/Cargo.toml', import.meta.url), 'utf8');

test('release metadata is aligned at v0.4.0', () => {
  assert.equal(rootPackage.version, TARGET_VERSION);
  assert.equal(lock.version, TARGET_VERSION);
  assert.equal(lock.packages?.['']?.version, TARGET_VERSION);
  assert.equal(tauri.version, TARGET_VERSION);
  assert.match(cargo, new RegExp(`^version\\s*=\\s*"${TARGET_VERSION.replaceAll('.', '\\.') }"$`, 'm'));
});
