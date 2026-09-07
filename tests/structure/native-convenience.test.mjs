import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

function read(path) { return fs.readFileSync(new URL(path, import.meta.url), 'utf8'); }

test('native network receive exposes Scan, Paste and Type without duplicating the web transfer engine', () => {
  const html = read('../../apps/native/index.html');
  const main = read('../../apps/native/src/main.js');

  assert.ok(html.includes('data-paste-code'));
  assert.ok(html.includes('data-native-scan'));
  assert.ok(html.includes('data-scan-qr'));
  assert.ok(html.includes('data-scanner'));
  assert.ok(html.includes('data-scanner-video'));
  assert.ok(html.includes('data-scanner-overlay'));
  assert.ok(html.includes('data-scanner-cancel'));

  assert.ok(main.includes("removeAttribute('data-scan-qr')"));
  assert.ok(main.includes("await import('../../web/src/main.js')"));
  assert.ok(main.indexOf("removeAttribute('data-scan-qr')") < main.indexOf("await import('../../web/src/main.js')"), 'Android must detach the browser scanner before the shared web engine wires listeners');
  assert.ok(main.includes('parseReceivePayload'));
  assert.ok(main.includes('requestSubmit()'));
  assert.ok(main.includes('createAndroidBarcodeScanner'));
});

test('Android native scanner capability is mobile-only and exposes barcode scanner commands', () => {
  const capabilityUrl = new URL('../../apps/native/src-tauri/capabilities/android-barcode.json', import.meta.url);
  assert.ok(fs.existsSync(capabilityUrl), 'Android barcode capability should exist');
  const capability = JSON.parse(fs.readFileSync(capabilityUrl, 'utf8'));
  assert.deepEqual(capability.platforms, ['android']);
  assert.deepEqual(capability.windows, ['main']);
  assert.ok(capability.permissions.includes('barcode-scanner:default'));
});
