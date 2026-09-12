import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const workflowUrl = new URL('../../.github/workflows/android-physical-evidence.yml', import.meta.url);
const collectorUrl = new URL('../../scripts/collect-android-physical-evidence.mjs', import.meta.url);
const authorityUrl = new URL('../../scripts/prepare-android-physical-evidence.mjs', import.meta.url);

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

test('self-hosted Android evidence binds to an authoritative main Native Builds run instead of a release tag', () => {
  const workflow = fs.readFileSync(workflowUrl, 'utf8');

  assert.match(workflow, /native_run_id:/);
  assert.doesNotMatch(workflow, /release_tag:/);
  assert.doesNotMatch(workflow, /gh release download/);
  assert.match(workflow, /prepare-android-physical-evidence\.mjs/);
  assert.match(workflow, /android-build-authority\.json/);
  assert.match(workflow, /FILE_QR_APK:\s*physical-input\/FileQR-Android-arm64\.apk/);
});

test('self-hosted Android evidence refuses non-main dispatch refs and checks out trusted main', () => {
  const workflow = fs.readFileSync(workflowUrl, 'utf8');

  assert.match(workflow, /if:\s*github\.ref\s*==\s*['"]refs\/heads\/main['"]/);
  assert.match(workflow, /uses:\s*actions\/checkout@[0-9a-f]{40}\b[^\n]*[\s\S]*?with:\s*\n\s*ref:\s*main/);
});

test('Android physical authority helper exposes a fail-closed exact-run CLI using shared artifact primitives', () => {
  assert.ok(fs.existsSync(authorityUrl), 'Android physical authority helper must exist');
  const source = fs.readFileSync(authorityUrl, 'utf8');

  assert.match(source, /--run-id/);
  assert.match(source, /--output-dir/);
  assert.match(source, /--authority/);
  assert.match(source, /defaultArtifactFetcher/);
  assert.match(source, /currentHeadSha/);
  assert.match(source, /prepare-optical-physical-evidence\.mjs/);
});

test('physical workflow validates the exact run and GitHub artifact digest encoding', () => {
  const workflow = fs.readFileSync(workflowUrl, 'utf8');
  assert.match(workflow, /EXPECTED_NATIVE_RUN_ID/);
  assert.match(workflow, /\^sha256:\[a-f0-9\]\{64\}\$/);
  assert.match(workflow, /archiveSha256/);
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