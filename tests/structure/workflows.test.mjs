import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

function read(path) { return fs.readFileSync(new URL(path, import.meta.url), 'utf8'); }

test('pages workflow deploys built web artifact with current Pages actions', () => {
  const yml = read('../../.github/workflows/pages.yml');
  assert.ok(yml.includes('actions/configure-pages@v5'));
  assert.ok(yml.includes('actions/upload-pages-artifact@v4'));
  assert.ok(yml.includes('actions/deploy-pages@v4'));
  assert.ok(yml.includes('apps/web/dist'));
});

test('native workflow contains Windows and permission-aware Android build jobs', () => {
  const yml = read('../../.github/workflows/native.yml');
  assert.ok(yml.includes('windows-latest'));
  assert.ok(yml.includes('tauri build'));
  assert.ok(yml.includes('npm run android:init'));
  assert.ok(yml.includes('android.permission.CAMERA'));
  assert.ok(yml.includes('android.hardware.camera.any'));
  assert.ok(yml.includes('tauri android build'));
});
