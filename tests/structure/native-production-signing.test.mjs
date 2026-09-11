import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const workflowUrl = new URL('../../.github/workflows/native.yml', import.meta.url);
const windowsConfigUrl = new URL('../../scripts/configure-windows-signing.mjs', import.meta.url);
const androidConfigUrl = new URL('../../scripts/configure-android-signing.mjs', import.meta.url);

const workflow = fs.readFileSync(workflowUrl, 'utf8');

test('main Windows artifacts require certificate-backed Authenticode and post-build verification', () => {
  assert.match(workflow, /Assert production Windows signing secrets/);
  assert.match(workflow, /WINDOWS_CERTIFICATE:\s*\$\{\{\s*secrets\.WINDOWS_CERTIFICATE\s*\}\}/);
  assert.match(workflow, /WINDOWS_CERTIFICATE_PASSWORD:\s*\$\{\{\s*secrets\.WINDOWS_CERTIFICATE_PASSWORD\s*\}\}/);
  assert.match(workflow, /Configure Tauri Windows signing/);
  assert.match(workflow, /configure-windows-signing\.mjs/);
  assert.match(workflow, /Verify Windows Authenticode signature/);
  assert.match(workflow, /Get-AuthenticodeSignature/);
  assert.match(workflow, /Status\s*-ne\s*['"]Valid['"]/);
  assert.match(workflow, /github\.event_name\s*==\s*['"]push['"]/);
  assert.match(workflow, /github\.ref\s*==\s*['"]refs\/heads\/main['"]/);

  assert.ok(fs.existsSync(windowsConfigUrl), 'Windows signing configuration helper must exist');
  const helper = fs.readFileSync(windowsConfigUrl, 'utf8');
  assert.match(helper, /certificateThumbprint/);
  assert.match(helper, /digestAlgorithm/);
  assert.match(helper, /sha256/);
  assert.match(helper, /timestampUrl/);
});

test('Windows signing material is removed from the runner after every build path', () => {
  assert.match(workflow, /Cleanup Windows signing material/);
  assert.match(
    workflow,
    /Cleanup Windows signing material[\s\S]*if:\s*always\(\)[\s\S]*Remove-Item[\s\S]*Cert:\\CurrentUser\\My/,
  );
  assert.match(workflow, /Remove-Item[\s\S]*file-qr-code-signing\.pfx/);
});

test('main Android artifacts require a release keystore and apksigner verification', () => {
  assert.match(workflow, /Assert production Android signing secrets/);
  assert.match(workflow, /ANDROID_KEY_BASE64:\s*\$\{\{\s*secrets\.ANDROID_KEY_BASE64\s*\}\}/);
  assert.match(workflow, /ANDROID_KEY_PASSWORD:\s*\$\{\{\s*secrets\.ANDROID_KEY_PASSWORD\s*\}\}/);
  assert.match(workflow, /ANDROID_KEY_ALIAS:\s*\$\{\{\s*secrets\.ANDROID_KEY_ALIAS\s*\}\}/);
  assert.match(workflow, /Configure Android release signing/);
  assert.match(workflow, /configure-android-signing\.mjs/);
  assert.match(workflow, /Build signed production APK/);
  assert.match(workflow, /Build installable preview APK/);
  assert.match(workflow, /android build --apk --target aarch64/);
  assert.match(workflow, /android build --apk --debug --target aarch64/);
  assert.match(workflow, /Verify Android APK signature/);
  assert.match(workflow, /apksigner\s+verify/);

  assert.ok(fs.existsSync(androidConfigUrl), 'Android signing configuration helper must exist');
  const helper = fs.readFileSync(androidConfigUrl, 'utf8');
  assert.match(helper, /keystore\.properties/);
  assert.match(helper, /signingConfigs/);
  assert.match(helper, /getByName\(['"]release['"]\)/);
  assert.match(helper, /ANDROID_KEY_BASE64/);
  assert.match(helper, /ANDROID_KEY_PASSWORD/);
  assert.match(helper, /ANDROID_KEY_ALIAS/);
  assert.ok(!/console\.log\([^\n]*(?:PASSWORD|BASE64|keystore)/i.test(helper));
});

test('Android signature verification binds the APK signer to the configured release certificate', () => {
  assert.match(workflow, /FILE_QR_ANDROID_CERT_SHA256/);
  assert.match(workflow, /keytool\s+-exportcert/);
  assert.match(workflow, /sha256sum/);
  assert.match(
    workflow,
    /Verify Android APK signature[\s\S]*Signer #1 certificate SHA-256 digest[\s\S]*FILE_QR_ANDROID_CERT_SHA256/,
  );
  assert.match(workflow, /Android APK signer certificate does not match the configured release keystore/);
});

test('preview Android build exercises generated signing config through the Tauri lifecycle', () => {
  assert.match(workflow, /Exercise Android release signing patch with ephemeral CI key/);
  assert.match(workflow, /keytool\s+-genkeypair/);
  assert.match(workflow, /base64\s+-w0/);
  assert.match(workflow, /configure-android-signing\.mjs/);
  assert.match(workflow, /github\.event_name\s*!=\s*['"]push['"]/);
  assert.match(
    workflow,
    /Exercise Android release signing patch with ephemeral CI key[\s\S]*Build installable preview APK[\s\S]*Cleanup ephemeral Android signing material/,
  );
  assert.match(workflow, /Cleanup ephemeral Android signing material/);
  assert.match(workflow, /if:\s*always\(\)/);
  assert.match(workflow, /rm\s+-f[\s\S]*file-qr-ci-patched\.jks/);
  assert.match(workflow, /rm\s+-f[\s\S]*keystore\.properties/);
});

test('release publication remains downstream of both platform signing jobs', () => {
  assert.match(workflow, /release:[\s\S]*needs:\s*\[windows, android\]/);
  assert.match(workflow, /Release \$TAG already exists; leaving it unchanged\./);
});

test('release publication is serialized so one run cannot delete another live draft', () => {
  assert.match(
    workflow,
    /release:[\s\S]*?concurrency:\s*\n\s{6}group:\s*file-qr-native-release\s*\n\s{6}cancel-in-progress:\s*false/,
  );
});

test('future release publication is draft-first and verifies before immutable publish', () => {
  const createIndex = workflow.indexOf('gh release create "$TAG"');
  const verifyIndex = workflow.indexOf('Verify draft release bytes and attestations');
  const publishIndex = workflow.indexOf('gh release edit "$TAG" --draft=false');

  assert.ok(createIndex >= 0, 'release creation command must exist');
  assert.match(workflow, /gh release create "\$TAG"[\s\S]{0,700}--draft/);
  assert.ok(verifyIndex > createIndex, 'draft bytes/attestations must be verified after draft creation');
  assert.ok(publishIndex > verifyIndex, 'draft must be published only after verification succeeds');
});

test('failed owned draft publication is recoverable without replacing published or foreign releases', () => {
  assert.match(workflow, /gh release view "\$TAG"[\s\S]*--json author,body,isDraft,tagName,targetCommitish/);
  assert.match(workflow, /classify-release-draft\.mjs/);
  assert.match(workflow, /recoverable-owned-draft/);
  assert.match(
    workflow,
    /recoverable-owned-draft\)[\s\S]*gh release delete "\$TAG"[\s\S]*--cleanup-tag[\s\S]*--yes/,
  );
  assert.match(workflow, /Removing owned stale draft release \$TAG before rebuilding it\./);
  assert.match(workflow, /published-existing-release/);
  assert.match(workflow, /Release \$TAG already exists; leaving it unchanged\./);
  assert.match(workflow, /foreign-or-ambiguous-draft/);
  assert.match(workflow, /Refusing to delete foreign or ambiguous draft release \$TAG\./);
});