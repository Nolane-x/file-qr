import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

function read(path) { return fs.readFileSync(new URL(path, import.meta.url), 'utf8'); }

test('web deployment uses Cloudflare Workers static assets with production smoke test', () => {
  const yml = read('../../.github/workflows/pages.yml');
  assert.ok(yml.includes('wrangler deploy --config apps/web/wrangler.jsonc'));
  assert.ok(yml.includes('CLOUDFLARE_API_TOKEN'));
  assert.ok(yml.includes('CLOUDFLARE_ACCOUNT_ID'));
  assert.ok(yml.includes('https://fileqr.nolane-file.workers.dev'));
  assert.ok(!yml.includes('actions/configure-pages@v6'));
  assert.ok(!yml.includes('actions/deploy-pages@v5'));
});

test('GitHub Pages mirror keeps repo base isolated from Cloudflare root build', () => {
  const workflowUrl = new URL('../../.github/workflows/github-pages.yml', import.meta.url);
  assert.ok(fs.existsSync(workflowUrl), 'GitHub Pages mirror workflow should exist');
  const yml = fs.readFileSync(workflowUrl, 'utf8');
  const vite = read('../../apps/web/vite.config.js');
  const cloudflare = read('../../.github/workflows/pages.yml');
  assert.ok(yml.includes('pull_request:'));
  assert.ok(yml.includes('actions/configure-pages@v6'));
  assert.ok(yml.includes('actions/upload-pages-artifact@v5'));
  assert.ok(yml.includes('actions/deploy-pages@v5'));
  assert.ok(yml.includes('pages: write'));
  assert.ok(yml.includes('id-token: write'));
  assert.ok(yml.includes('VITE_BASE: /file-qr/'));
  assert.ok(yml.includes('VITE_SIGNALING_ORIGIN:'));
  assert.ok(yml.includes('https://file-qr-signaling.nolane-file.workers.dev'));
  assert.ok(yml.includes("github.event_name != 'pull_request' && github.ref == 'refs/heads/main'"));
  assert.ok(yml.includes("grep -q '/file-qr/assets/' apps/web/dist/index.html"));
  assert.ok(vite.includes("base: process.env.VITE_BASE || '/'"));
  assert.ok(!vite.includes('GITHUB_ACTIONS'));
  assert.ok(!cloudflare.includes('VITE_BASE: /file-qr/'));
});

test('web worker configuration publishes the Vite dist directory as static assets', () => {
  const configUrl = new URL('../../apps/web/wrangler.jsonc', import.meta.url);
  assert.ok(fs.existsSync(configUrl));
  const config = read('../../apps/web/wrangler.jsonc');
  assert.ok(config.includes('"name": "fileqr"'));
  assert.ok(config.includes('"directory": "./dist"'));
  assert.ok(config.includes('"not_found_handling": "single-page-application"'));
});

test('web build defaults to the Cloudflare root path without action-global coupling', () => {
  const vite = read('../../apps/web/vite.config.js');
  assert.ok(vite.includes("base: process.env.VITE_BASE || '/'"));
  assert.ok(!vite.includes('GITHUB_ACTIONS'));
});

test('native workflow contains Windows and permission-aware Android build jobs', () => {
  const yml = read('../../.github/workflows/native.yml');
  assert.ok(yml.includes('windows-latest'));
  assert.ok(yml.includes('tauri build'));
  assert.ok(yml.includes('npm run android:init'));
  assert.ok(yml.includes('android.permission.CAMERA'));
  assert.ok(yml.includes('android.hardware.camera.any'));
  assert.ok(yml.includes('tauri android build'));
});

test('native workflow publishes one release per package version from main', () => {
  const yml = read('../../.github/workflows/native.yml');
  assert.ok(yml.includes("github.ref == 'refs/heads/main'"));
  assert.ok(yml.includes("node -p \"require('./package.json').version\""));
  assert.ok(yml.includes('gh release view "$TAG"'));
  assert.ok(yml.includes('gh release create "$TAG"'));
  assert.ok(yml.includes('--target "$GITHUB_SHA"'));
  assert.ok(yml.includes('actions/download-artifact@v5'));
});

test('CI dry-runs the Cloudflare web deployment configuration', () => {
  const yml = read('../../.github/workflows/ci.yml');
  const pkg = JSON.parse(read('../../package.json'));
  assert.equal(pkg.scripts['check:web-deploy'], 'wrangler deploy --dry-run --config apps/web/wrangler.jsonc');
  assert.ok(yml.includes('npm run check:web-deploy'));
});
