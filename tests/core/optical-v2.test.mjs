import test from 'node:test';
import assert from 'node:assert/strict';
import {
  FQR2_BLOCK_BYTES,
  FQR2_MAX_FILE_BYTES,
  FQR2_MAX_SEQ_NUM,
  encodeFqr2Manifest,
  decodeFqr2Manifest,
  encodeFqr2Part,
  decodeFqr2Part,
  expectedBlockGeometry,
} from '../../packages/core/optical-v2.js';

test('FQR2 manifest round-trips fixed v0.2 geometry', () => {
  const frame = encodeFqr2Manifest({
    streamId: '0123456789AB', fileSize: 131073, symbolBytes: 768,
    name: 'sample.bin', type: 'application/octet-stream',
  });
  const decoded = decodeFqr2Manifest(frame);
  assert.equal(decoded.blockBytes, FQR2_BLOCK_BYTES);
  assert.equal(decoded.blockCount, 3);
  assert.equal(decoded.fileSize, 131073);
  assert.equal(decoded.name, 'sample.bin');
  assert.equal(decoded.type, 'application/octet-stream');
});

test('FQR2 zero-byte stream is one logical block with K=1', () => {
  const manifest = decodeFqr2Manifest(encodeFqr2Manifest({
    streamId: '0123456789AB', fileSize: 0, symbolBytes: 768,
    name: 'empty.bin', type: 'application/octet-stream',
  }));
  assert.equal(manifest.blockCount, 1);
  assert.deepEqual(expectedBlockGeometry(manifest, 0), { blockLength: 0, k: 1 });
});

test('FQR2 manifest rejects oversized file and non-v0.2 block geometry', () => {
  assert.throws(() => encodeFqr2Manifest({
    streamId: '0123456789AB', fileSize: FQR2_MAX_FILE_BYTES + 1,
    symbolBytes: 768, name: 'x', type: 'application/octet-stream',
  }), /file size/i);
  const frame = encodeFqr2Manifest({
    streamId: '0123456789AB', fileSize: 1, symbolBytes: 768,
    name: 'x', type: 'application/octet-stream',
  });
  const parts = frame.split('|');
  parts[4] = '32768';
  assert.throws(() => decodeFqr2Manifest(parts.join('|')), /geometry|block/i);
});

test('FQR2 manifest rejects metadata beyond 2048 UTF-8 bytes', () => {
  assert.throws(() => encodeFqr2Manifest({
    streamId: '0123456789AB', fileSize: 1, symbolBytes: 768,
    name: 'é'.repeat(1100), type: 'application/octet-stream',
  }), /metadata/i);
});

test('FQR2 part round-trips exact payload and rejects CRC corruption', () => {
  const manifest = decodeFqr2Manifest(encodeFqr2Manifest({
    streamId: '0123456789AB', fileSize: 65536, symbolBytes: 768,
    name: 'sample.bin', type: 'application/octet-stream',
  }));
  const payload = Uint8Array.from({ length: 768 }, (_, i) => i & 255);
  const frame = encodeFqr2Part({
    streamId: manifest.streamId, blockIndex: 0, seqNum: 1,
    seqLen: 86, blockLength: 65536,
    blockSha256: '11'.repeat(32), payload,
  });
  const decoded = decodeFqr2Part(frame, manifest);
  assert.equal(decoded.seqNum, 1);
  assert.deepEqual(decoded.payload, payload);
  const parts = frame.split('|');
  parts[8] = '00000000';
  assert.throws(() => decodeFqr2Part(parts.join('|'), manifest), /CRC/i);
});

test('FQR2 part rejects sequence overflow, wrong hash syntax and wrong payload length', () => {
  const manifest = decodeFqr2Manifest(encodeFqr2Manifest({
    streamId: '0123456789AB', fileSize: 10, symbolBytes: 768,
    name: 'x', type: 'application/octet-stream',
  }));
  const base = {
    streamId: manifest.streamId, blockIndex: 0, seqNum: 1,
    seqLen: 1, blockLength: 10, blockSha256: '22'.repeat(32),
    payload: new Uint8Array(768),
  };
  assert.throws(() => encodeFqr2Part({ ...base, seqNum: FQR2_MAX_SEQ_NUM + 1 }), /sequence/i);
  assert.throws(() => encodeFqr2Part({ ...base, blockSha256: 'AA'.repeat(32) }), /SHA|hash/i);
  assert.throws(() => decodeFqr2Part(encodeFqr2Part({ ...base, payload: new Uint8Array(767) }), manifest), /payload|symbol/i);
});
