import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const workflowUrl = new URL('../../.github/workflows/android-physical-evidence.yml', import.meta.url);
const collectorUrl = new URL('../../scripts/collect-android-physical-evidence.mjs', import.meta.url);

test('physical Android evidence is manual-only on a dedicated self-hosted device runner', () => {
  assert.ok(fs.existsSync(workflowUrl), 'physical Android evidence workflow must exist');
  const workflow = fs.readFileSync(workflowUrl, 'utf8');

  assert.match(workflow, /workflow_dispatch:/);
  assert.doesNotMatch(workflow, /\bpull_request:/);
  assert.doesNotMatch(workflow, /\bpush:/);
  assert.match(workflow, /runs-on:\s*\[self-hosted,\s*linux,\s*file-qr-android-device\]/);
  assert.match(workflow, /collect-android-physical-evidence\.mjs/);
  assert.match(workflow, /actions\/upload-artifact@v4/);
  assert.match(workflow, /android-physical-evidence\.json/);
});

test('physical Android collector proves a non-emulator camera path without recording camera imagery', () => {
  assert.ok(fs.existsSync(collectorUrl), 'physical Android evidence collector must exist');
  const source = fs.readFileSync(collectorUrl, 'utf8');

  assert.match(source, /adb[\s\S]*devices/);
  assert.match(source, /ro\.kernel\.qemu/);
  assert.match(source, /com\.nolane\.fileqr/);
  assert.match(source, /android\.permission\.CAMERA/);
  assert.match(source, /uiautomator[\s\S]*dump/);
  assert.match(source, /Scan QR/);
  assert.match(source, /dumpsys[\s\S]*media\.camera/);
  assert.match(source, /KEYCODE_BACK/);
  assert.match(source, /createHash\(['"]sha256['"]\)/);
  assert.match(source, /deviceSerialHash/);
  assert.match(source, /buildFingerprintHash/);
  assert.match(source, /cameraOwnerObserved/);
  assert.match(source, /appRecovered/);
  assert.doesNotMatch(source, /screencap|screenrecord/);
});
