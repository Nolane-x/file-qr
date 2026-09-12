import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const main = fs.readFileSync(new URL('../../apps/web/src/main.js', import.meta.url), 'utf8');

test('web runtime wires direct-first policy to encrypted Worker relay fallback', () => {
  assert.match(main, /createTransportPolicy/);
  assert.match(main, /createRelayCryptoContext/);
  assert.match(main, /createWorkerRelayTransport/);
  assert.match(main, /connectRelay/);
  assert.match(main, /directExhausted\(\{\s*committedBytes:/);
  assert.match(main, /Trying another connection path/i);
  assert.match(main, /worker-relay/);
  assert.match(main, /Relayed securely/i);
});

test('relay runtime keeps QR-only confidentiality boundary explicit', () => {
  assert.match(main, /parseReceivePayloadDetails/);
  assert.match(main, /relaySecret/);
  assert.match(main, /relayCapability/);
  assert.match(main, /scan(?:ning)? the sender QR|scan the sender QR/i);
  assert.match(main, /receiveFile\([^)]*relaySecret/);
});

test('relay runtime reuses existing file offer resume sink and completion protocol', () => {
  assert.match(main, /file-offer/);
  assert.match(main, /resume-request/);
  assert.match(main, /transfer-complete/);
  assert.match(main, /complete-ack/);
  assert.match(main, /createReceiveSink/);
  assert.match(main, /validateResumeOffset/);
  assert.match(main, /relayTransport/);
});

test('transport switch refuses silent same-attempt splicing after new bytes are committed', () => {
  assert.match(main, /committedBytes/);
  assert.match(main, /switchingTransport/);
  assert.match(main, /retry-new-attempt|new attempt/i);
});
