import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

test('native shell is File QR and exposes network plus offline optical modes', () => {
  const conf = JSON.parse(fs.readFileSync(new URL('../../apps/native/src-tauri/tauri.conf.json', import.meta.url), 'utf8'));
  assert.equal(conf.identifier, 'com.nolane.fileqr');
  assert.equal(conf.productName, 'File QR');
  const html = fs.readFileSync(new URL('../../apps/native/index.html', import.meta.url), 'utf8');
  assert.ok(html.includes('data-mode="network"'));
  assert.ok(html.includes('data-mode="optical"'));
  assert.ok(html.includes('data-camera'));
});
