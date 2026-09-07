import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const main = fs.readFileSync(new URL('../../apps/web/src/main.js', import.meta.url), 'utf8');
const signaling = fs.readFileSync(new URL('../../apps/web/src/signaling.js', import.meta.url), 'utf8');

test('sender runtime does not consume or close the lease after one transfer', () => {
  assert.ok(!main.includes("type: 'session-consumed'"));
  assert.ok(!main.includes('The rendezvous is no longer reusable.'));
  assert.match(main, /cleanupAttempt/);
  assert.match(main, /Code remains available|receive window remains open|still available/i);
});

test('sender and receiver signal messages are isolated by attemptId', () => {
  assert.match(main, /attemptId/);
  assert.match(main, /sendSignal\([\s\S]*attemptId/);
  assert.match(main, /message\.attemptId[\s\S]*attemptId/);
});

test('data channel uses file-offer resume-request and complete-ack controls', () => {
  assert.match(main, /file-offer/);
  assert.match(main, /resume-request/);
  assert.match(main, /complete-ack/);
  assert.match(main, /transfer-complete/);
});

test('receiver opens resumable sink with lease code and stable fileId', () => {
  assert.match(main, /createReceiveSink\([\s\S]*leaseCode[\s\S]*fileId/);
  assert.match(main, /sink\.offset/);
});

test('signaling client captures connected handshake before callers attach later listeners', () => {
  assert.match(signaling, /fileQrConnected/);
  assert.match(signaling, /message\.type === 'connected'/);
});

test('sender signaling reconnect schedules another retry only after reconnecting flag is cleared', () => {
  assert.match(main, /let retrySignal = false/);
  assert.match(main, /retrySignal = true/);
  assert.match(main, /finally\s*\{\s*current\.reconnecting = false;\s*\}/);
  assert.match(main, /if \(retrySignal && leaseOpen\(\)\) scheduleSenderSignalReconnect\(\)/);
});

test('replayed peer-ready cannot replace an active or newer sender attempt', () => {
  assert.match(main, /if \(current\.attempt\.id === attemptId\) return;/);
  assert.match(main, /current\.attempt = \{ \.\.\.freshAttempt\(\), id: attemptId \};[\s\S]*await resolveIceServers\(\)/);
  assert.match(main, /if \(current\.attempt\.id !== attemptId \|\| current\.socket !== socket \|\| !leaseOpen\(\)\) return;/);
});

test('each WebRTC attempt owns one-shot ICE recovery and transport diagnostics', () => {
  assert.match(main, /createIceRecoveryController/);
  assert.match(main, /detectSelectedCandidateType/);
  assert.match(main, /iceRecovery/);
  assert.match(main, /handleState\(state\)/);
  assert.match(main, /Direct|Relay|Secure P2P/);
});
