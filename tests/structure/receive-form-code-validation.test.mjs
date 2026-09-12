import test from 'node:test';
import assert from 'node:assert/strict';
import { readWebRuntimeSource } from '../helpers/web-runtime-source.mjs';

const runtime = readWebRuntimeSource();

test('direct receive submission validates the raw code before normalization', () => {
  const start = runtime.indexOf('async function receiveFile(rawCode, relaySecret = null)');
  const end = runtime.indexOf('\nasync function onScannedPayload', start);
  assert.ok(start >= 0 && end > start, 'receiveFile runtime must be discoverable');

  const receiveFlow = runtime.slice(start, end);
  const rawValidation = receiveFlow.indexOf('isReceiveCode(rawCode)');
  const normalization = receiveFlow.indexOf('normalizeReceiveCode(rawCode)');

  assert.ok(rawValidation >= 0, 'receiveFile must validate the original user-entered code');
  assert.ok(normalization > rawValidation, 'receive code normalization must happen only after raw validation succeeds');
});

test('receive-code input formatting never truncates an invalid overlong value', () => {
  const handler = runtime.match(/ui\.codeInput\.addEventListener\('input', \(\) => \{([\s\S]*?)\}\);/);
  assert.ok(handler, 'receive-code input handler must be discoverable');
  assert.match(handler[1], /isReceiveCode\(ui\.codeInput\.value\)/);
  assert.match(handler[1], /if\s*\([^)]*isReceiveCode/);
});
