import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { readWebRuntimeSource } from '../helpers/web-runtime-source.mjs';

const runtime = readWebRuntimeSource();
const signaling = fs.readFileSync(new URL('../../apps/web/src/signaling.js', import.meta.url), 'utf8');

test('sender runtime does not consume or close the lease after one transfer', () => {
  assert.ok(!runtime.includes("type: 'session-consumed'"));
  assert.ok(!runtime.includes('The rendezvous is no longer reusable.'));
  assert.match(runtime, /cleanupAttempt/);
  assert.match(runtime, /Code remains available|receive window remains open|still available/i);
});

test('sender and receiver signal messages are isolated by attemptId', () => {
  assert.match(runtime, /attemptId/);
  assert.match(runtime, /sendSignal\([\s\S]*attemptId/);
  assert.match(runtime, /message\.attemptId[\s\S]*attemptId/);
});

test('direct and relay paths share file-offer resume and completion controls', () => {
  for (const token of ['file-offer', 'resume-request', 'complete-ack', 'transfer-complete']) {
    assert.ok(runtime.includes(token), `missing ${token}`);
  }
  assert.match(runtime, /handleSenderControlMessage/);
  assert.match(runtime, /receiveFileOffer/);
});

test('receiver opens resumable sink with lease code and stable fileId', () => {
  assert.match(runtime, /createReceiveSink\([\s\S]*leaseCode[\s\S]*fileId/);
  assert.match(runtime, /sink\.offset/);
});

test('signaling client captures connected handshake before callers attach later listeners', () => {
  assert.match(signaling, /fileQrConnected/);
  assert.match(signaling, /message\.type === 'connected'/);
});

test('sender signaling reconnect schedules another retry only after reconnecting flag is cleared', () => {
  assert.match(runtime, /let retrySignal = false/);
  assert.match(runtime, /retrySignal = true/);
  assert.match(runtime, /finally\s*\{[\s\S]*reconnecting = false;[\s\S]*\}/);
  assert.match(runtime, /if \(retrySignal && leaseOpen\(\)\) scheduleSenderSignalReconnect\(\)/);
});

test('replayed peer-ready cannot replace an active or newer sender attempt', () => {
  assert.match(runtime, /if \(current\(\)\.attempt\.id === attemptId\) return;/);
  assert.match(runtime, /cleanupAttempt\(\{ nextAttempt:[\s\S]*id: attemptId/);
  assert.match(runtime, /if \(current\(\)\.attempt\.id !== attemptId \|\| current\(\)\.socket !== socket \|\| !leaseOpen\(\)\) return;/);
});

test('sender owns ICE restart while receiver waits to avoid offer glare', () => {
  assert.match(runtime, /activeRestart:\s*role === 'sender'/);
  assert.match(runtime, /passiveFailureGraceMs:\s*10_000/);
  assert.match(runtime, /attachConnectionDiagnostics\(peer, socket, attemptId, 'sender'\)/);
  assert.match(runtime, /attachConnectionDiagnostics\(peer, socket, attemptId, 'receiver'\)/);
});

test('each WebRTC attempt owns one-shot ICE recovery and transport diagnostics', () => {
  assert.match(runtime, /createIceRecoveryController/);
  assert.match(runtime, /detectSelectedCandidateType/);
  assert.match(runtime, /iceRecovery/);
  assert.match(runtime, /handleState\(state\)/);
  assert.match(runtime, /Direct|Relay|Secure P2P/);
});

test('runtime binds one relay secret to the QR lease and preserves it only for structured receive payloads', () => {
  assert.match(runtime, /generateRelaySecret/);
  assert.match(runtime, /buildReceivePayloadUrl/);
  assert.match(runtime, /parseReceivePayloadDetails/);
  assert.match(runtime, /relaySecret/);
  assert.match(runtime, /receiveFile\([^)]*relaySecret/);
});
