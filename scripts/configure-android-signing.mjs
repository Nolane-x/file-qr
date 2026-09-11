import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const defaultRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function assertSingleLine(name, value) {
  if (/\r|\n/.test(value)) {
    throw new Error(`${name} contains unsupported newline characters`);
  }
}

function escapePropertyValue(value) {
  assertSingleLine('Java properties value', value);
  let escaped = String(value)
    .replace(/\\/g, '\\\\')
    .replace(/\t/g, '\\t')
    .replace(/\f/g, '\\f');
  escaped = escaped.replace(/^ +/, (spaces) => '\\ '.repeat(spaces.length));
  return escaped;
}

export function renderKeystoreProperties({ keyAlias, keyPassword, keystorePath }) {
  const alias = String(keyAlias ?? '');
  const password = String(keyPassword ?? '');
  const storeFile = String(keystorePath ?? '');

  if (!alias.trim()) throw new Error('ANDROID_KEY_ALIAS is missing');
  if (!password) throw new Error('ANDROID_KEY_PASSWORD is missing');
  if (!storeFile) throw new Error('Android keystore path is missing');
  assertSingleLine('ANDROID_KEY_ALIAS', alias);
  assertSingleLine('ANDROID_KEY_PASSWORD', password);
  assertSingleLine('Android keystore path', storeFile);

  return [
    `password=${escapePropertyValue(password)}`,
    `keyAlias=${escapePropertyValue(alias)}`,
    `storeFile=${escapePropertyValue(storeFile)}`,
    '',
  ].join('\n');
}

export function patchGradleText(source) {
  let gradle = String(source ?? '');
  if (!gradle.trim()) throw new Error('Generated Android app Gradle file is empty');

  const imports = [];
  if (!gradle.includes('import java.util.Properties')) imports.push('import java.util.Properties');
  if (!gradle.includes('import java.io.FileInputStream')) imports.push('import java.io.FileInputStream');
  if (imports.length) gradle = `${imports.join('\n')}\n${gradle}`;

  if (!/create\("release"\)\s*\{/.test(gradle)) {
    const buildTypesMatch = gradle.match(/^(\s*)buildTypes\s*\{/m);
    if (!buildTypesMatch) {
      throw new Error('Generated Android app Gradle file has no buildTypes block');
    }
    const indent = buildTypesMatch[1];
    const signingConfig = [
      `${indent}signingConfigs {`,
      `${indent}    create("release") {`,
      `${indent}        val keystorePropertiesFile = rootProject.file("keystore.properties")`,
      `${indent}        val keystoreProperties = Properties()`,
      `${indent}        keystoreProperties.load(FileInputStream(keystorePropertiesFile))`,
      `${indent}        keyAlias = keystoreProperties["keyAlias"] as String`,
      `${indent}        keyPassword = keystoreProperties["password"] as String`,
      `${indent}        storeFile = file(keystoreProperties["storeFile"] as String)`,
      `${indent}        storePassword = keystoreProperties["password"] as String`,
      `${indent}    }`,
      `${indent}}`,
      '',
    ].join('\n');
    gradle = gradle.replace(buildTypesMatch[0], `${signingConfig}${buildTypesMatch[0]}`);
  }

  const signingAssignment = 'signingConfig = signingConfigs.getByName("release")';
  if (!gradle.includes(signingAssignment)) {
    const releaseMatch = gradle.match(/^(\s*)getByName\("release"\)\s*\{/m);
    if (!releaseMatch) {
      throw new Error('Generated Android app Gradle file has no release build type');
    }
    const indent = releaseMatch[1];
    gradle = gradle.replace(
      releaseMatch[0],
      `${releaseMatch[0]}\n${indent}    ${signingAssignment}`,
    );
  }

  return gradle;
}

function decodeKeystoreBase64(value) {
  const normalized = String(value ?? '').replace(/\s+/g, '');
  if (!normalized || !/^[A-Za-z0-9+/]*={0,2}$/.test(normalized) || normalized.length % 4 === 1) {
    throw new Error('ANDROID_KEY_BASE64 is not valid base64');
  }
  const bytes = Buffer.from(normalized, 'base64');
  const canonical = bytes.toString('base64').replace(/=+$/g, '');
  if (canonical !== normalized.replace(/=+$/g, '') || bytes.length < 32) {
    throw new Error('ANDROID_KEY_BASE64 decoded to an invalid keystore payload');
  }
  return bytes;
}

export function configureAndroidSigning({ root = defaultRoot, env = process.env } = {}) {
  const androidRoot = path.join(root, 'apps', 'native', 'src-tauri', 'gen', 'android');
  const gradlePath = path.join(androidRoot, 'app', 'build.gradle.kts');
  const propertiesPath = path.join(androidRoot, 'keystore.properties');

  const keyBase64 = String(env.ANDROID_KEY_BASE64 || '');
  const keyPassword = String(env.ANDROID_KEY_PASSWORD || '');
  const keyAlias = String(env.ANDROID_KEY_ALIAS || '').trim();
  const keystorePath = path.resolve(
    String(
      env.FILE_QR_ANDROID_KEYSTORE_PATH
        || path.join(env.RUNNER_TEMP || os.tmpdir(), 'file-qr-release.jks'),
    ),
  );

  if (!keyBase64 || !keyPassword || !keyAlias) {
    throw new Error(
      'Android release signing requires ANDROID_KEY_BASE64, ANDROID_KEY_PASSWORD, and ANDROID_KEY_ALIAS',
    );
  }
  if (!fs.existsSync(gradlePath)) {
    throw new Error(`Generated Android app Gradle file not found: ${gradlePath}`);
  }

  const gradle = patchGradleText(fs.readFileSync(gradlePath, 'utf8'));
  const keystoreBytes = decodeKeystoreBase64(keyBase64);
  const properties = renderKeystoreProperties({ keyAlias, keyPassword, keystorePath });

  fs.mkdirSync(path.dirname(keystorePath), { recursive: true });
  fs.writeFileSync(keystorePath, keystoreBytes, { mode: 0o600 });
  fs.writeFileSync(propertiesPath, properties, { mode: 0o600 });
  fs.writeFileSync(gradlePath, gradle);
  console.log('Android release signing configuration ready.');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  configureAndroidSigning();
}
