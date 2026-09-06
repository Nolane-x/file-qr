import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const moduleUrl = new URL('../../apps/web/src/scanner.js', import.meta.url);

function fakeCanvasClass() { return class FakeQRCanvas {}; }

function makeHarness(preferEnvironment) {
  const calls = [];
  const camera = {
    stopped: 0,
    readFrame() { return 'https://fileqr.nolane-file.workers.dev/?receive=ABCDEFGHJK'; },
    stop() { this.stopped += 1; },
  };
  let loopFn = null;
  let loopCancelled = 0;
  return {
    calls,
    camera,
    deps: {
      video: {}, overlay: {}, preferEnvironment,
      cameraApi: {
        rearCamera: async () => { calls.push('rear'); return camera; },
        selfieCamera: async () => { calls.push('selfie'); return camera; },
      },
      frameLoopFn(fn) { loopFn = fn; return () => { loopCancelled += 1; }; },
      QRCanvasClass: fakeCanvasClass(),
    },
    runFrame() { loopFn?.(); },
    get loopCancelled() { return loopCancelled; },
  };
}

test('scanner chooses the environment camera on Android-style clients', async () => {
  assert.ok(fs.existsSync(moduleUrl), 'scanner module must exist');
  const { createQrScanner } = await import(moduleUrl);
  const h = makeHarness(true);
  const scanner = createQrScanner(h.deps);
  await scanner.start(() => {});
  assert.deepEqual(h.calls, ['rear']);
  scanner.stop();
});

test('scanner chooses selfie/default camera on desktop and stops after one decode', async () => {
  assert.ok(fs.existsSync(moduleUrl), 'scanner module must exist');
  const { createQrScanner } = await import(moduleUrl);
  const h = makeHarness(false);
  const values = [];
  const scanner = createQrScanner(h.deps);
  await scanner.start(value => values.push(value));
  assert.deepEqual(h.calls, ['selfie']);
  h.runFrame();
  h.runFrame();
  assert.deepEqual(values, ['https://fileqr.nolane-file.workers.dev/?receive=ABCDEFGHJK']);
  assert.equal(h.camera.stopped, 1);
  assert.equal(h.loopCancelled, 1);
  scanner.stop();
  assert.equal(h.camera.stopped, 1);
});
