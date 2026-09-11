import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { patchManifestText } from '../../scripts/patch-android-manifest.mjs';

test('Android manifest patch keeps all camera hardware optional after merge and permission inference', () => {
  const input = '<manifest xmlns:android="http://schemas.android.com/apk/res/android">\n    <uses-permission android:name="android.permission.INTERNET" />\n    <uses-feature android:name="android.hardware.camera.any" />\n</manifest>\n';
  const once = patchManifestText(input);
  assert.ok(once.includes('xmlns:tools="http://schemas.android.com/tools"'));
  assert.ok(once.includes('<uses-permission android:name="android.permission.CAMERA" />'));
  assert.ok(once.includes('<uses-feature android:name="android.hardware.camera.any" android:required="false" tools:replace="android:required" />'));
  assert.ok(once.includes('<uses-feature android:name="android.hardware.camera" android:required="false" />'));
  assert.ok(once.includes('<uses-feature android:name="android.hardware.camera.autofocus" android:required="false" />'));
  assert.equal((once.match(/android\.hardware\.camera\.any/g) || []).length, 1);
  assert.equal((once.match(/android\.hardware\.camera"/g) || []).length, 1);
  assert.equal((once.match(/android\.hardware\.camera\.autofocus/g) || []).length, 1);
  assert.equal(patchManifestText(once), once);
});

test('native Android build always runs the camera manifest patch after tauri android init', () => {
  const pkg = JSON.parse(fs.readFileSync(new URL('../../apps/native/package.json', import.meta.url), 'utf8'));
  const workflow = fs.readFileSync(new URL('../../.github/workflows/native.yml', import.meta.url), 'utf8');
  assert.match(pkg.scripts['android:init'], /tauri android init.*patch-android-manifest\.mjs/);
  assert.ok(workflow.includes('run: npm run android:init'));
  assert.ok(workflow.includes("grep -R -q 'android.permission.CAMERA'"));
});

test('native Android build verifies the merged APK keeps camera hardware optional', () => {
  const workflow = fs.readFileSync(new URL('../../.github/workflows/native.yml', import.meta.url), 'utf8');
  assert.match(workflow, /aapt2[^\n]*dump badging/);
  assert.ok(workflow.includes('uses-feature-not-required'));
  assert.ok(workflow.includes('android.hardware.camera.any'));
  assert.ok(workflow.includes('android.hardware.camera.autofocus'));
  assert.ok(workflow.includes("camera_features=('android.hardware.camera.any' 'android.hardware.camera' 'android.hardware.camera.autofocus')"));
  assert.match(workflow, /Packaged Android camera feature became required/);
});
