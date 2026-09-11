import test from 'node:test';
import assert from 'node:assert/strict';

const androidHelperUrl = new URL('../../scripts/configure-android-signing.mjs', import.meta.url);
const windowsHelperUrl = new URL('../../scripts/configure-windows-signing.mjs', import.meta.url);

function count(source, needle) {
  return source.split(needle).length - 1;
}

test('Android signing Gradle patch is deterministic and idempotent', async () => {
  const { patchGradleText, renderKeystoreProperties } = await import(androidHelperUrl.href);
  assert.equal(typeof patchGradleText, 'function');
  assert.equal(typeof renderKeystoreProperties, 'function');

  const fixture = `plugins {\n    id("com.android.application")\n}\n\nandroid {\n    namespace = "com.nolane.fileqr"\n\n    buildTypes {\n        getByName("release") {\n            isMinifyEnabled = false\n        }\n    }\n}\n`;

  const once = patchGradleText(fixture);
  const twice = patchGradleText(once);

  assert.equal(twice, once, 'Android signing Gradle patch must be idempotent');
  assert.equal(count(once, 'import java.util.Properties'), 1);
  assert.equal(count(once, 'import java.io.FileInputStream'), 1);
  assert.equal(count(once, 'create("release")'), 1);
  assert.equal(count(once, 'signingConfig = signingConfigs.getByName("release")'), 1);
  assert.match(once, /keyAlias\s*=\s*keystoreProperties\["keyAlias"\]/);
  assert.match(once, /storePassword\s*=\s*keystoreProperties\["password"\]/);

  const properties = renderKeystoreProperties({
    keyAlias: 'upload',
    keyPassword: 'test-password',
    keystorePath: '/tmp/file-qr-release.jks',
  });
  assert.equal(
    properties,
    'password=test-password\nkeyAlias=upload\nstoreFile=/tmp/file-qr-release.jks\n',
  );
});

test('Windows signing config transform is deterministic and non-destructive', async () => {
  const { applyWindowsSigningConfig } = await import(windowsHelperUrl.href);
  assert.equal(typeof applyWindowsSigningConfig, 'function');

  const input = {
    productName: 'File QR',
    bundle: {
      active: true,
      windows: { allowDowngrades: true },
    },
  };
  const thumbprint = 'A'.repeat(40);
  const output = applyWindowsSigningConfig(input, {
    certificateThumbprint: thumbprint,
    timestampUrl: 'https://timestamp.example.test',
  });

  assert.notEqual(output, input);
  assert.equal(input.bundle.windows.certificateThumbprint, undefined);
  assert.equal(output.bundle.windows.allowDowngrades, true);
  assert.equal(output.bundle.windows.certificateThumbprint, thumbprint);
  assert.equal(output.bundle.windows.digestAlgorithm, 'sha256');
  assert.equal(output.bundle.windows.timestampUrl, 'https://timestamp.example.test');

  assert.throws(
    () => applyWindowsSigningConfig(input, { certificateThumbprint: 'bad', timestampUrl: 'https://timestamp.example.test' }),
    /thumbprint/i,
  );
  assert.throws(
    () => applyWindowsSigningConfig(input, { certificateThumbprint: thumbprint, timestampUrl: 'not-a-url' }),
    /timestamp/i,
  );
});
