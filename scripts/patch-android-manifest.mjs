import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const androidRoot = path.join(root, 'apps', 'native', 'src-tauri', 'gen', 'android');
const toolsNamespace = 'xmlns:tools="http://schemas.android.com/tools"';
const cameraFeature = '<uses-feature android:name="android.hardware.camera.any" android:required="false" tools:replace="android:required" />';
const cameraFeaturePattern = /<uses-feature\b(?=[^>]*\bandroid:name\s*=\s*["']android\.hardware\.camera\.any["'])[^>]*\/?>/;

function normalizeCameraFeatureTag(tag) {
  const base = tag
    .replace(/\s+android:required\s*=\s*(?:"[^"]*"|'[^']*')/g, '')
    .replace(/\s+tools:replace\s*=\s*(?:"[^"]*"|'[^']*')/g, '')
    .replace(/\s*\/?>$/, '');
  return `${base} android:required="false" tools:replace="android:required" />`;
}

export function patchManifestText(source) {
  const manifestMatch = source.match(/<manifest\b[^>]*>/);
  if (!manifestMatch) throw new Error('AndroidManifest.xml has no <manifest> root');

  let output = source;
  let manifestRoot = manifestMatch[0];
  if (/\bxmlns:tools\s*=/.test(manifestRoot)) {
    if (!/\bxmlns:tools\s*=\s*["']http:\/\/schemas\.android\.com\/tools["']/.test(manifestRoot)) {
      throw new Error('AndroidManifest.xml has an unexpected tools namespace');
    }
  } else {
    const patchedRoot = manifestRoot.replace(/>$/, ` ${toolsNamespace}>`);
    output = output.replace(manifestRoot, patchedRoot);
    manifestRoot = patchedRoot;
  }

  const additions = [];
  if (!output.includes('android.permission.CAMERA')) {
    additions.push('    <uses-permission android:name="android.permission.CAMERA" />');
  }

  if (cameraFeaturePattern.test(output)) {
    output = output.replace(cameraFeaturePattern, (tag) => normalizeCameraFeatureTag(tag));
  } else {
    additions.push(`    ${cameraFeature}`);
  }

  if (additions.length) {
    output = output.replace(/(<manifest\b[^>]*>)/, `$1\n${additions.join('\n')}`);
  }
  return output;
}

function findManifests(dir) {
  if (!fs.existsSync(dir)) return [];
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...findManifests(full));
    else if (entry.name === 'AndroidManifest.xml' && full.includes(`${path.sep}app${path.sep}src${path.sep}main${path.sep}`)) out.push(full);
  }
  return out;
}

export function patchGeneratedAndroidManifests(dir = androidRoot) {
  const manifests = findManifests(dir);
  if (!manifests.length) throw new Error(`No generated app AndroidManifest.xml found under ${dir}`);
  for (const manifest of manifests) {
    const before = fs.readFileSync(manifest, 'utf8');
    const after = patchManifestText(before);
    if (after !== before) fs.writeFileSync(manifest, after);
    console.log(`Android camera permission ready: ${path.relative(root, manifest)}`);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  patchGeneratedAndroidManifests();
}
