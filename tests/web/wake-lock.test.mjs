import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const moduleUrl = new URL('../../apps/web/src/wake-lock.js', import.meta.url);

function fakeDocument() {
  const listeners = new Map();
  return {
    visibilityState: 'visible',
    addEventListener(name, fn) { listeners.set(name, fn); },
    removeEventListener(name, fn) { if (listeners.get(name) === fn) listeners.delete(name); },
    dispatch(name) { listeners.get(name)?.(); },
  };
}

test('wake lock acquires only while active and releases when inactive', async () => {
  assert.ok(fs.existsSync(moduleUrl), 'wake-lock module must exist');
  const { createWakeLockController } = await import(moduleUrl);
  const doc = fakeDocument();
  let requests = 0;
  let releases = 0;
  const api = { async request(kind) { assert.equal(kind, 'screen'); requests += 1; return { async release() { releases += 1; } }; } };
  const controller = createWakeLockController({ wakeLockApi: api, documentRef: doc });
  await controller.sync(true);
  await controller.sync(true);
  assert.equal(requests, 1);
  await controller.sync(false);
  assert.equal(releases, 1);
  controller.destroy();
});

test('wake lock reacquires after visibility returns and unsupported APIs are non-fatal', async () => {
  assert.ok(fs.existsSync(moduleUrl), 'wake-lock module must exist');
  const { createWakeLockController } = await import(moduleUrl);
  const doc = fakeDocument();
  let requests = 0;
  const api = { async request() { requests += 1; return { async release() {} }; } };
  const controller = createWakeLockController({ wakeLockApi: api, documentRef: doc });
  await controller.sync(true);
  doc.visibilityState = 'hidden';
  doc.dispatch('visibilitychange');
  doc.visibilityState = 'visible';
  doc.dispatch('visibilitychange');
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.ok(requests >= 2);
  controller.destroy();

  const unsupported = createWakeLockController({ wakeLockApi: null, documentRef: doc });
  await assert.doesNotReject(() => unsupported.sync(true));
  unsupported.destroy();
});
