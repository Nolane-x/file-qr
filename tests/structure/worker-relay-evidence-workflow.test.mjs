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

test('worker relay evidence auto-follows successful trusted-main web deploy and stays secretless', () => {
  const workflow = requireFile('.github/workflows/worker-relay-evidence.yml');
  assert.match(workflow, /workflow_dispatch:/);
  assert.match(workflow, /workflow_run:/);
  assert.match(workflow, /workflows:\s*\[?['"]?Deploy Web['"]?\]?/);
  assert.match(workflow, /types:\s*\[completed\]/);
  assert.doesNotMatch(workflow, /pull_request:|\npush:/);
  assert.match(workflow, /workflow_run\.conclusion\s*==\s*'success'/);
  assert.match(workflow, /workflow_run\.head_branch\s*==\s*'main'/);
  assert.match(workflow, /workflow_run\.head_sha/);
  assert.match(workflow, /ref:\s*\$\{\{/);
  assert.match(workflow, /for attempt in/);
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
    'sourceCommit',
    'worker-relay',
    'relaySocketObserved',
    "pathname.endsWith('/relay')",
    'FILE_QR_WORKER_RELAY_EVIDENCE_PATH',
    'FILE_QR_SOURCE_COMMIT',
  ]) assert.ok(probe.includes(token), `missing production relay proof token ${token}`);
  assert.match(probe, /assert\.equal\(receivedSha256, sourceSha256/);
  assert.match(probe, /assert\.equal\(senderRelayObserved, true/);
  assert.match(probe, /assert\.equal\(receiverRelayObserved, true/);
  assert.doesNotMatch(probe, /assert\.match\([^\n]*(?:relay|receive)/i, 'receive/relay authority assertions must not echo authority into logs');
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

test('README describes direct-first Worker relay without overstating hosted evidence', () => {
  const readme = requireFile('README.md');
  assert.match(readme, /direct-first/i);
  assert.match(readme, /Worker relay/i);
  assert.match(readme, /QR-only|QR.*secret/i);
  assert.match(readme, /TURN.*optional|optional TURN/is);
  assert.match(readme, /hosted.*evidence/is);
  assert.match(readme, /physical.*restrictive-network|restrictive-network.*physical/is);
  assert.match(readme, /manual.*code.*(?:does not|cannot).*relay/is);
});

test('security model separates relay admission authority from QR-only payload confidentiality', () => {
  const security = requireFile('SECURITY.md');
  for (const pattern of [
    /Worker relay/i,
    /QR-only|QR.*relay secret/i,
    /HKDF-SHA-256/i,
    /AES-256-GCM/i,
    /attempt-scoped/i,
    /capabilit/i,
    /ciphertext.*(?:not|never).*persist|(?:not|never).*persist.*ciphertext/is,
    /manual.*code.*(?:does not|cannot).*relay/is,
    /TURN.*optional|optional TURN/is,
  ]) assert.match(security, pattern);
});

test('protocol documents bounded encrypted relay framing resume and evidence-only force mode', () => {
  const protocol = requireFile('docs/architecture/PROTOCOL.md');
  for (const pattern of [
    /Encrypted Worker relay/i,
    /URL fragment/i,
    /\/v1\/sessions\/\{code\}\/relay/,
    /forceRelay=1/,
    /64 KiB/i,
    /8 unacknowledged|eight unacknowledged/i,
    /every 4.*250 ms|four.*250 ms/is,
    /30 s|30-second/i,
    /4 relay attempts|four relay attempts/i,
    /relay-budget/,
    /validated.*(?:resume|offset)|(?:resume|offset).*validated/is,
    /same-attempt.*(?:splice|switch).*blocked|blocked.*same-attempt/is,
  ]) assert.match(protocol, pattern);
});
