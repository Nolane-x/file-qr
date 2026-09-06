import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

test('web UI exposes send, receive, downloads and accessible status', () => {
  const html = fs.readFileSync(new URL('../../apps/web/index.html', import.meta.url), 'utf8');
  for (const token of ['data-dropzone', 'data-receive-form', 'data-download-windows', 'data-download-android', 'aria-live="polite"', 'data-qr']) {
    assert.ok(html.includes(token), `missing ${token}`);
  }
});

test('web state copy includes every release-critical state', () => {
  const js = fs.readFileSync(new URL('../../apps/web/src/main.js', import.meta.url), 'utf8');
  for (const state of ['idle','preparing','ready','connecting','sending','receiving','verifying','done','expired','cancelled','failed','unsupported']) {
    assert.ok(js.includes(state), `missing state ${state}`);
  }
});

test('web signaling buffers remote ICE until a remote description exists', () => {
  const source = fs.readFileSync(new URL('../../apps/web/src/main.js', import.meta.url), 'utf8');
  assert.ok(source.includes('await candidateBuffer.add(message.candidate)'));
  assert.ok(!source.includes('await peer.addIceCandidate(message.candidate)'));
});
