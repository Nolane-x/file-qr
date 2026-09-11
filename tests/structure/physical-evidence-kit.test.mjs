import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');

test('physical evidence kit files exist only in approved evidence scope', () => {
  for (const p of [
    'packages/core/physical-evidence.js',
    'scripts/physical-evidence-github.mjs',
    'scripts/prepare-optical-physical-evidence.mjs',
    'scripts/finalize-optical-physical-evidence.mjs',
    'scripts/summarize-optical-physical-evidence.mjs',
    'scripts/collect-windows-physical-evidence.mjs',
  ]) {
    assert.ok(fs.existsSync(path.join(root, p)), `${p} must exist`);
  }
});

test('existing self-hosted Android physical workflow remains manual-only and trusted-main-only', () => {
  const workflow = read('.github/workflows/android-physical-evidence.yml');
  assert.match(workflow, /workflow_dispatch:/);
  assert.doesNotMatch(workflow, /\bpull_request:/);
  assert.doesNotMatch(workflow, /\bpush:/);
  assert.match(workflow, /runs-on:\s*\[self-hosted,\s*linux,\s*file-qr-android-device\]/);
  assert.match(workflow, /if:\s*github\.ref\s*==\s*['"]refs\/heads\/main['"]/);
  assert.match(workflow, /with:\s*\n\s*ref:\s*main/);
});

test('no new PR-triggered physical self-hosted workflow is introduced', () => {
  const dir = path.join(root, '.github/workflows');
  const files = fs.readdirSync(dir).filter((name) => /physical|ceremony/i.test(name));
  assert.deepEqual(files, ['android-physical-evidence.yml']);
});

test('kit does not alter package version or dependency policy', () => {
  const pkg = JSON.parse(read('package.json'));
  assert.equal(pkg.version, '0.4.0');
  assert.equal(pkg.scripts.test, 'node --test');
});

test('evidence scripts prohibit invasive capture and secret-bearing integrations', () => {
  const planned = [
    'scripts/physical-evidence-github.mjs',
    'scripts/prepare-optical-physical-evidence.mjs',
    'scripts/finalize-optical-physical-evidence.mjs',
    'scripts/summarize-optical-physical-evidence.mjs',
    'scripts/collect-windows-physical-evidence.mjs',
  ];
  const source = planned.map(read).join('\n');
  assert.doesNotMatch(source, /screencap|screenrecord|screenshot|MediaRecorder|getUserMedia|camera frame/i);
  assert.doesNotMatch(source, /secrets\.|CLOUDFLARE_|WINDOWS_CERTIFICATE|ANDROID_KEY_|GH_TOKEN\s*=/);
});

test('transfer and production authority modules do not import evidence kit', () => {
  for (const p of [
    'packages/core/optical.js',
    'packages/core/session.js',
    'services/signaling/src/index.js',
    'scripts/bootstrap-production-turn.mjs',
  ]) {
    assert.doesNotMatch(read(p), /physical-evidence|physical ceremony/i, `${p} must stay isolated`);
  }
});

test('Windows collector source cannot persist PnP identities or capture imagery', () => {
  const source = read('scripts/collect-windows-physical-evidence.mjs');
  assert.match(source, /Get-PnpDevice\s+-Class\s+Camera/);
  assert.doesNotMatch(source, /InstanceId|FriendlyName|DeviceID|screenshot|frame|video|audio/i);
});
