import test from 'node:test';
import assert from 'node:assert/strict';
import { readWebRuntimeSource } from '../helpers/web-runtime-source.mjs';

const runtime = readWebRuntimeSource();

test('web runtime wires direct-first policy to encrypted Worker relay fallback', () => {
  assert.match(runtime, /createTransportPolicy/);
  assert.match(runtime, /createRelayCryptoContext/);
  assert.match(runtime, /createWorkerRelayTransport/);
  assert.match(runtime, /connectRelay/);
  assert.match(runtime, /directExhausted\(\{\s*committedBytes:/);
  assert.match(runtime, /Trying another connection path/i);
  assert.match(runtime, /worker-relay/);
  assert.match(runtime, /Relayed securely/i);
});

test('relay runtime keeps QR-only confidentiality boundary explicit', () => {
  assert.match(runtime, /parseReceivePayloadDetails/);
  assert.match(runtime, /relaySecret/);
  assert.match(runtime, /relayCapability/);
  assert.match(runtime, /scan(?:ning)? the sender QR|scan the sender QR/i);
  assert.match(runtime, /receiveFile\([^)]*relaySecret/);
});

test('relay runtime reuses existing file offer resume sink and completion protocol', () => {
  for (const token of ['file-offer', 'resume-request', 'transfer-complete', 'complete-ack']) {
    assert.ok(runtime.includes(token), `missing ${token}`);
  }
  assert.match(runtime, /createReceiveSink/);
  assert.match(runtime, /validateResumeOffset/);
  assert.match(runtime, /relayTransport/);
});

test('transport switch refuses silent same-attempt splicing after new bytes are committed', () => {
  assert.match(runtime, /committedBytes/);
  assert.match(runtime, /switchingTransport/);
  assert.match(runtime, /retry-new-attempt|new attempt/i);
});
