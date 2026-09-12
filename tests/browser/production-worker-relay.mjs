import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { chromium } from 'playwright';

const DEFAULT_PRODUCTION_ORIGIN = 'https://fileqr.nolane-file.workers.dev';
const DEFAULT_PAYLOAD_BYTES = 4 * 1024 * 1024 + 137;
const WINDOWS_CHROMIUM_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Safari/537.36';

function digest(input) {
  return createHash('sha256').update(input).digest('hex');
}

async function hashDownload(download) {
  const stream = await download.createReadStream();
  assert.ok(stream, 'browser download stream must be readable');
  const hash = createHash('sha256');
  for await (const chunk of stream) hash.update(chunk);
  return hash.digest('hex');
}

async function waitForState(page, expected, timeout = 120_000) {
  await page.waitForFunction(
    (state) => document.body?.dataset?.state === state,
    expected,
    { timeout },
  );
}

async function slowFileReads(page) {
  await page.addInitScript(() => {
    const originalSlice = Blob.prototype.slice;
    Blob.prototype.slice = function (...args) {
      const sliced = originalSlice.apply(this, args);
      const originalArrayBuffer = sliced.arrayBuffer.bind(sliced);
      sliced.arrayBuffer = async () => {
        await new Promise((resolve) => setTimeout(resolve, 4));
        return originalArrayBuffer();
      };
      return sliced;
    };
  });
}

function observeRelaySockets(page) {
  const observed = { relaySocketObserved: false };
  page.on('websocket', (socket) => {
    try {
      if (new URL(socket.url()).pathname.endsWith('/relay')) observed.relaySocketObserved = true;
    } catch { /* ignore malformed diagnostic URLs */ }
  });
  return observed;
}

export async function runWorkerRelayProbe({
  origin = DEFAULT_PRODUCTION_ORIGIN,
  payloadBytes = DEFAULT_PAYLOAD_BYTES,
  evidencePath = null,
  forceRelayQuery = 'forceRelay=1',
  requireProductionOrigin = true,
} = {}) {
  if (!Number.isSafeInteger(payloadBytes) || payloadBytes < 1024 || payloadBytes > 16 * 1024 * 1024) {
    throw new Error('Worker relay evidence payload size is outside the bounded test range');
  }
  if (evidencePath) fs.rmSync(evidencePath, { force: true });

  const base = new URL(origin);
  if (requireProductionOrigin) {
    assert.equal(base.protocol, 'https:', 'production relay evidence must use HTTPS');
    assert.equal(base.hostname, 'fileqr.nolane-file.workers.dev', 'production relay evidence must target the canonical File QR Worker');
  }
  const entry = new URL(`/?${forceRelayQuery}`, base.origin);
  assert.equal(entry.searchParams.get('forceRelay'), '1', 'evidence probe must explicitly force Worker relay');

  const payload = randomBytes(payloadBytes);
  const sourceSha256 = digest(payload);
  const browser = await chromium.launch({ headless: true });
  let receivedSha256 = '';
  let senderFinalState = '';
  let receiverFinalState = '';
  let senderRelayObserved = false;
  let receiverRelayObserved = false;

  try {
    const senderContext = await browser.newContext({ userAgent: WINDOWS_CHROMIUM_UA, acceptDownloads: true });
    const receiverContext = await browser.newContext({ userAgent: WINDOWS_CHROMIUM_UA, acceptDownloads: true });
    await senderContext.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: base.origin });
    const sender = await senderContext.newPage();
    const receiver = await receiverContext.newPage();
    await slowFileReads(sender);
    const senderSockets = observeRelaySockets(sender);
    const receiverSockets = observeRelaySockets(receiver);

    await sender.goto(entry.toString(), { waitUntil: 'domcontentloaded' });
    await sender.locator('[data-file-input]').setInputFiles({
      name: 'worker-relay-evidence.bin',
      mimeType: 'application/octet-stream',
      buffer: payload,
    });
    await waitForState(sender, 'ready', 60_000);
    await sender.locator('[data-copy-link]').click();
    const receiveUrl = await sender.evaluate(() => navigator.clipboard.readText());
    assert.ok(receiveUrl, 'sender must expose a structured receive link through Copy link');

    const receive = new URL(receiveUrl);
    assert.equal(receive.origin, base.origin, 'receive URL must stay on the tested web origin');
    assert.equal(receive.searchParams.get('forceRelay'), '1', 'receive URL must preserve evidence-only force relay mode');
    assert.match(receive.searchParams.get('receive') || '', /^[0-9A-Z]{5}-[0-9A-Z]{5}$/);
    assert.match(receive.searchParams.get('relay') || '', /^[A-Za-z0-9_-]{43}$/);

    const downloadPromise = receiver.waitForEvent('download', { timeout: 120_000 });
    await receiver.goto(receive.toString(), { waitUntil: 'domcontentloaded' });
    await receiver.waitForFunction(
      () => /Relayed securely|secure relay/i.test(document.querySelector('[data-status]')?.textContent || '')
        || /Relayed securely/i.test(document.querySelector('[data-eta]')?.textContent || ''),
      null,
      { timeout: 30_000 },
    );
    const download = await downloadPromise;
    receivedSha256 = await hashDownload(download);
    assert.equal(receivedSha256, sourceSha256, 'received bytes must independently match the random source payload SHA-256');

    await waitForState(receiver, 'done', 30_000);
    await waitForState(sender, 'ready', 30_000);
    senderFinalState = await sender.evaluate(() => document.body?.dataset?.state || '');
    receiverFinalState = await receiver.evaluate(() => document.body?.dataset?.state || '');
    senderRelayObserved = senderSockets.relaySocketObserved;
    receiverRelayObserved = receiverSockets.relaySocketObserved;
    assert.equal(senderRelayObserved, true, 'sender must open the dedicated Worker relay WebSocket');
    assert.equal(receiverRelayObserved, true, 'receiver must open the dedicated Worker relay WebSocket');

    await senderContext.close();
    await receiverContext.close();
  } finally {
    await browser.close();
  }

  const evidence = {
    schemaVersion: 1,
    result: 'PASS',
    testedAt: new Date().toISOString(),
    productionOrigin: base.origin,
    transport: 'worker-relay',
    forcedRelay: true,
    payloadBytes,
    sourceSha256,
    receivedSha256,
    sender: { finalState: senderFinalState, relaySocketObserved: senderRelayObserved },
    receiver: { finalState: receiverFinalState, relaySocketObserved: receiverRelayObserved },
  };

  if (evidencePath) fs.writeFileSync(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`, { mode: 0o600 });
  return evidence;
}

const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  const evidencePath = process.env.FILE_QR_WORKER_RELAY_EVIDENCE_PATH || 'worker-relay-evidence.json';
  const evidence = await runWorkerRelayProbe({
    origin: process.env.FILE_QR_PRODUCTION_ORIGIN || DEFAULT_PRODUCTION_ORIGIN,
    evidencePath,
    requireProductionOrigin: true,
  });
  console.log(`Worker relay evidence: ${evidence.result}; ${evidence.payloadBytes} random bytes matched by SHA-256.`);
}
