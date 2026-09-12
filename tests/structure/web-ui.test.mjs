import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { readWebRuntimeSource } from '../helpers/web-runtime-source.mjs';

const runtime = readWebRuntimeSource();

test('web UI exposes send, receive, downloads and accessible status', () => {
  const html = fs.readFileSync(new URL('../../apps/web/index.html', import.meta.url), 'utf8');
  for (const token of ['data-dropzone', 'data-receive-form', 'data-download-windows', 'data-download-android', 'aria-live="polite"', 'data-qr']) {
    assert.ok(html.includes(token), `missing ${token}`);
  }
});

test('web receive UI exposes paste and camera scanner hooks', () => {
  const html = fs.readFileSync(new URL('../../apps/web/index.html', import.meta.url), 'utf8');
  for (const token of ['data-paste-code', 'data-scan-qr', 'data-scanner', 'data-scanner-video', 'data-scanner-overlay', 'data-scanner-cancel', 'data-eta']) {
    assert.ok(html.includes(token), `missing ${token}`);
  }
});

test('web state copy includes every release-critical state', () => {
  for (const state of ['idle','preparing','ready','connecting','sending','receiving','verifying','done','expired','cancelled','failed','unsupported']) {
    assert.ok(runtime.includes(state), `missing state ${state}`);
  }
});

test('web signaling buffers remote ICE until a remote description exists', () => {
  assert.ok(runtime.includes('await candidateBuffer.add(message.candidate)'));
  assert.ok(!runtime.includes('await peer.addIceCandidate(message.candidate)'));
});

test('composed web runtime orchestrates scanner parsing, wake lock, ETA and bounded connection timeout', () => {
  for (const token of ["from './receive-payload.js'", "from './scanner.js'", "from './wake-lock.js'", "from './progress.js'", '30_000', 'connectionState', 'pagehide']) {
    assert.ok(runtime.includes(token), `missing integration token ${token}`);
  }
  assert.ok(runtime.includes('Not a File QR receive code.'));
});

test('main entrypoint stays thin while runtime responsibilities remain focused', () => {
  const main = fs.readFileSync(new URL('../../apps/web/src/main.js', import.meta.url), 'utf8');
  assert.match(main, /runtime-ui\.js/);
  assert.match(main, /bootstrapFileQrUi\(\)/);
  assert.ok(main.split('\n').length < 12, 'main.js must remain a thin composition root');
});
