import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { patchManifestText } from '../../scripts/patch-android-manifest.mjs';

test('Android manifest patch adds camera permission and optional camera feature exactly once', () => {
  const input = '<manifest xmlns:android="http://schemas.android.com/apk/res/android">\n    <uses-permission android:name="android.permission.INTERNET" />\n</manifest>\n';
  const once = patchManifestText(input);
  assert.ok(once.includes('<uses-permission android:name="android.permission.CAMERA" />'));
  assert.ok(once.includes('<uses-feature android:name="android.hardware.camera.any" android:required="false" />'));
  assert.equal(patchManifestText(once), once);
});

test('native Android build always runs the camera manifest patch after tauri android init', () => {
  const pkg = JSON.parse(fs.readFileSync(new URL('../../apps/native/package.json', import.meta.url), 'utf8'));
  const workflow = fs.readFileSync(new URL('../../.github/workflows/native.yml', import.meta.url), 'utf8');
  assert.match(pkg.scripts['android:init'], /tauri android init.*patch-android-manifest\.mjs/);
  assert.ok(workflow.includes('run: npm run android:init'));
  assert.ok(workflow.includes("grep -R -q 'android.permission.CAMERA'"));
});
