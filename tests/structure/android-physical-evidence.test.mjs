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
  assert.match(workflow, /actions\/upload-artifact@[0-9a-f]{40}\b/);
  assert.match(workflow, /android-physical-evidence\.json/);
});

test('self-hosted Android evidence refuses non-main dispatch refs and checks out trusted main', () => {
  const workflow = fs.readFileSync(workflowUrl, 'utf8');

  assert.match(workflow, /if:\s*github\.ref\s*==\s*['"]refs\/heads\/main['"]/);
  assert.match(workflow, /uses:\s*actions\/checkout@[0-9a-f]{40}\b[^\n]*[\s\S]*?with:\s*\n\s*ref:\s*main/);
  assert.match(workflow, /TRUSTED_MAIN_SHA:\s*\$\{\{\s*github\.sha\s*\}\}/);
});

test('physical Android evidence binds the installed APK to one authoritative Native Builds main run', () => {
  const workflow = fs.readFileSync(workflowUrl, 'utf8');

  assert.match(workflow, /native_run_id:/);
  assert.doesNotMatch(workflow, /release_tag:/);
  assert.match(workflow, /physical-evidence-github\.mjs/);
  assert.match(workflow, /verifyAndroidPhysicalArtifact/);
  assert.match(workflow, /FILE_QR_ANDROID_AUTHORITY_PATH:\s*android-physical-authority\.json/);
  assert.match(workflow, /FILE_QR_APK:\s*trusted-android-artifact\/FileQR-Android-arm64\.apk/);
  assert.match(workflow, /android-physical-authority\.json/);
  assert.match(workflow, /x\.apkSha256\s*!==\s*authority\?\.apk\?\.sha256/);
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
