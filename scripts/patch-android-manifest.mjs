import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const androidRoot = path.join(root, 'apps', 'native', 'src-tauri', 'gen', 'android');

export function patchManifestText(source) {
  const additions = [];
  if (!source.includes('android.permission.CAMERA')) {
    additions.push('    <uses-permission android:name="android.permission.CAMERA" />');
  }
  if (!source.includes('android.hardware.camera.any')) {
    additions.push('    <uses-feature android:name="android.hardware.camera.any" android:required="false" />');
  }
  if (!additions.length) return source;
  if (!/<manifest\b[^>]*>/.test(source)) throw new Error('AndroidManifest.xml has no <manifest> root');
  return source.replace(/(<manifest\b[^>]*>)/, `$1\n${additions.join('\n')}`);
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
