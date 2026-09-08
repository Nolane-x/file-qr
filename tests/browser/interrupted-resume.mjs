import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';
import { OPFS_DURABILITY_CHECKPOINT_BYTES } from '../../apps/web/src/storage.js';

const WEB_ORIGIN = process.env.FILE_QR_BROWSER_ORIGIN || 'http://127.0.0.1:5173';
const TEST_BYTES = Number(process.env.FILE_QR_BROWSER_TEST_BYTES || 32 * 1024 * 1024);
const MIN_DURABLE_PERCENT = Math.ceil((OPFS_DURABILITY_CHECKPOINT_BYTES / TEST_BYTES) * 100) + 1;

async function waitForState(page, expected, timeout = 60_000) {
  await page.waitForFunction(
    (state) => document.body?.dataset?.state === state,
    expected,
    { timeout },
  );
}

async function waitForPartialProgress(page, minPercent) {
  await page.waitForFunction((minimum) => {
    if (document.body?.dataset?.state !== 'receiving') return false;
    const raw = document.querySelector('[data-progress-value]')?.textContent || '';
    const percent = Number.parseInt(raw, 10);
    return Number.isFinite(percent) && percent >= minimum && percent < 95;
  }, minPercent, { timeout: 60_000 });
}

async function waitForResumedTransfer(page, timeout = 60_000) {
  await page.waitForFunction(() => {
    if (document.body?.dataset?.state !== 'receiving') return false;
    const raw = document.querySelector('[data-progress-value]')?.textContent || '';
    const percent = Number.parseInt(raw, 10);
    const status = document.querySelector('[data-status]')?.textContent || '';
    return Number.isFinite(percent) && percent > 0 && /Resuming/i.test(status);
  }, null, { timeout });
}

function installSlowFileSlices(page) {
  return page.addInitScript(() => {
    const originalSlice = Blob.prototype.slice;
    Blob.prototype.slice = function (...args) {
      const sliced = originalSlice.apply(this, args);
      const originalArrayBuffer = sliced.arrayBuffer.bind(sliced);
      sliced.arrayBuffer = async () => {
        await new Promise((resolve) => setTimeout(resolve, 8));
        return originalArrayBuffer();
      };
      return sliced;
    };
  });
}

test('receiver interruption preserves partial bytes and resumes with the same lease code', { timeout: 180_000 }, async (t) => {
  assert.ok(
    MIN_DURABLE_PERCENT < 95,
    'browser resume fixture must be large enough to interrupt after a durability checkpoint and before completion',
  );

  const fixturePath = path.join(os.tmpdir(), `file-qr-browser-resume-${process.pid}.bin`);
  fs.writeFileSync(fixturePath, Buffer.alloc(TEST_BYTES, 0x5a));
  t.after(() => fs.rmSync(fixturePath, { force: true }));

  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());

  const senderContext = await browser.newContext({ acceptDownloads: true });
  const receiverContext = await browser.newContext({ acceptDownloads: true });
  const sender = await senderContext.newPage();
  await installSlowFileSlices(sender);
  await sender.goto(WEB_ORIGIN, { waitUntil: 'domcontentloaded' });

  await sender.locator('[data-file-input]').setInputFiles(fixturePath);
  await waitForState(sender, 'ready');
  const code = (await sender.locator('[data-code]').textContent())?.trim();
  assert.match(code || '', /^[0-9A-Z]{5}-[0-9A-Z]{5}$/);

  const receiver1 = await receiverContext.newPage();
  await receiver1.goto(WEB_ORIGIN, { waitUntil: 'domcontentloaded' });
  await receiver1.locator('[data-code-input]').fill(code);
  await receiver1.locator('[data-receive-form]').evaluate((form) => form.requestSubmit());
  await waitForPartialProgress(receiver1, MIN_DURABLE_PERCENT);

  const interruptedPercent = Number.parseInt(
    (await receiver1.locator('[data-progress-value]').textContent()) || '0',
    10,
  );
  assert.ok(
    interruptedPercent >= MIN_DURABLE_PERCENT && interruptedPercent < 95,
    `expected a durable partial transfer at >=${MIN_DURABLE_PERCENT}%, saw ${interruptedPercent}%`,
  );
  await receiver1.close();

  await waitForState(sender, 'ready');
  assert.equal((await sender.locator('[data-code]').textContent())?.trim(), code, 'sender must keep the same receive code after interruption');

  const receiver2 = await receiverContext.newPage();
  await receiver2.goto(WEB_ORIGIN, { waitUntil: 'domcontentloaded' });
  await receiver2.locator('[data-code-input]').fill(code);
  await receiver2.locator('[data-receive-form]').evaluate((form) => form.requestSubmit());
  await waitForResumedTransfer(receiver2);

  const resumedPercent = Number.parseInt(
    (await receiver2.locator('[data-progress-value]').textContent()) || '0',
    10,
  );
  const resumedStatus = (await receiver2.locator('[data-status]').textContent()) || '';
  assert.ok(resumedPercent > 0, `expected OPFS resume offset > 0, saw ${resumedPercent}%`);
  assert.match(resumedStatus, /Resuming/i, 'receiver should explicitly report a resumed transfer');

  await waitForState(receiver2, 'done', 120_000);
  await waitForState(sender, 'ready', 30_000);
  assert.equal((await sender.locator('[data-code]').textContent())?.trim(), code, 'completed receiver must not consume the lease');
});
