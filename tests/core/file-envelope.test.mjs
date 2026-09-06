import test from 'node:test';
import assert from 'node:assert/strict';
import { encodeFileEnvelope, decodeFileEnvelope } from '../../packages/core/file-envelope.js';

test('file envelope round trips metadata and bytes', () => {
  const encoded = encodeFileEnvelope({ name: 'hello.txt', type: 'text/plain' }, new TextEncoder().encode('hello'));
  const decoded = decodeFileEnvelope(encoded);
  assert.equal(decoded.name, 'hello.txt');
  assert.equal(decoded.type, 'text/plain');
  assert.equal(decoded.size, 5);
  assert.equal(new TextDecoder().decode(decoded.bytes), 'hello');
});

test('file envelope rejects truncated payloads', () => {
  const encoded = encodeFileEnvelope({ name: 'x.bin', type: '' }, Uint8Array.of(1,2,3));
  assert.throws(() => decodeFileEnvelope(encoded.slice(0, -1)), /size/i);
});
