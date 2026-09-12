import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

function read(path) {
  return fs.readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8');
}

function requireFile(path) {
  assert.ok(fs.existsSync(new URL(`../../${path}`, import.meta.url)), `missing ${path}`);
  return read(path);
}

test('worker relay evidence workflow is manual trusted-main only and secretless', () => {
  const workflow = requireFile('.github/workflows/worker-relay-evidence.yml');
  assert.match(workflow, /workflow_dispatch:/);
  assert.doesNotMatch(workflow, /pull_request:|\npush:|workflow_run:/);
  assert.match(workflow, /if:\s*github\.ref == 'refs\/heads\/main'/);
  assert.match(workflow, /ref:\s*main/);
  assert.match(workflow, /https:\/\/fileqr\.nolane-file\.workers\.dev\/?/);
  assert.match(workflow, /tests\/browser\/production-worker-relay\.mjs/);
  assert.match(workflow, /worker-relay-evidence\.json/);
  assert.match(workflow, /actions\/upload-artifact@[a-f0-9]{40}/);
  assert.match(workflow, /if-no-files-found:\s*error/);
  assert.doesNotMatch(workflow, /secrets\./);
});

test('production probe forces encrypted Worker relay and independently hashes random payload bytes', () => {
  const probe = requireFile('tests/browser/production-worker-relay.mjs');
  for (const token of [
    'chromium',
    'randomBytes',
    "createHash('sha256')",
    'forceRelay=1',
    'sourceSha256',
    'receivedSha256',
    'worker-relay',
    'relaySocketObserved',
    "pathname.endsWith('/relay')",
    'FILE_QR_WORKER_RELAY_EVIDENCE_PATH',
  ]) assert.ok(probe.includes(token), `missing production relay proof token ${token}`);
  assert.match(probe, /assert\.equal\(receivedSha256, sourceSha256/);
  assert.match(probe, /assert\.equal\(senderRelayObserved, true/);
  assert.match(probe, /assert\.equal\(receiverRelayObserved, true/);
});

test('production evidence schema cannot persist rendezvous authority or transferred bytes', () => {
  const probe = requireFile('tests/browser/production-worker-relay.mjs');
  const evidenceSection = probe.slice(probe.indexOf('const evidence ='));
  assert.ok(evidenceSection.length > 0, 'evidence object must be explicit');
  for (const forbidden of ['relaySecret', 'relayCapability', 'receiveCode', 'senderToken', 'clientIp', 'fileBytes', 'payloadBase64']) {
    assert.ok(!evidenceSection.includes(forbidden), `evidence must not persist ${forbidden}`);
  }
});

test('PR browser reliability runs deterministic local Worker relay integrity proof', () => {
  const workflow = requireFile('.github/workflows/browser-reliability.yml');
  const localProbe = requireFile('tests/browser/worker-relay-integrity.mjs');
  assert.match(workflow, /worker-relay-integrity\.mjs/);
  assert.match(workflow, /FILE_QR_BROWSER_ORIGIN:\s*http:\/\/127\.0\.0\.1:5173/);
  assert.match(localProbe, /forceRelay=1/);
  assert.match(localProbe, /receivedSha256, evidence\.sourceSha256/);
  assert.match(localProbe, /relaySocketObserved/);
  assert.match(localProbe, /transport, 'worker-relay'/);
});
