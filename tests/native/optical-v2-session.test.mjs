import test from 'node:test';
import assert from 'node:assert/strict';
import { createFqr2Broadcaster, createFqr2Receiver } from '../../apps/native/src/optical-v2-session.js';
import { encodeFqr2Manifest, encodeFqr2Part, decodeFqr2Manifest, decodeFqr2Part } from '../../packages/core/optical-v2.js';

function makeFile(size) {
  const bytes = Uint8Array.from({ length: size }, (_, i) => i & 255);
  const slices = [];
  let wholeArrayBufferCalls = 0;
  return {
    name: 'sample.bin', type: 'application/octet-stream', size, slices,
    get wholeArrayBufferCalls() { return wholeArrayBufferCalls; },
    async arrayBuffer() { wholeArrayBufferCalls += 1; return bytes.slice().buffer; },
    slice(start, end) {
      slices.push([start, end]);
      const chunk = bytes.slice(start, end);
      return { async arrayBuffer() { return chunk.buffer; } };
    },
  };
}

test('broadcaster reads exactly one file block per visit and never whole-file arrayBuffer', async () => {
  const file = makeFile(3 * 65536 + 7);
  const broadcaster = createFqr2Broadcaster(file, {
    streamId: '0123456789AB', symbolBytes: 768,
    emitFrame: async () => {}, yieldControl: async () => {},
  });
  await broadcaster.runVisits(4);
  assert.deepEqual(file.slices, [[0,65536],[65536,131072],[131072,196608],[196608,196615]]);
  assert.equal(file.wholeArrayBufferCalls, 0);
});

test('broadcaster emits manifest before each block visit and systematic first-cycle parts', async () => {
  const file = makeFile(10);
  const frames = [];
  const broadcaster = createFqr2Broadcaster(file, {
    streamId: '0123456789AB', symbolBytes: 768,
    emitFrame: async frame => frames.push(frame), yieldControl: async () => {},
  });
  await broadcaster.runVisits(1);
  assert.match(frames[0], /^FQR2\|M\|/);
  const manifest = decodeFqr2Manifest(frames[0]);
  assert.equal(manifest.blockCount, 1);
  assert.match(frames[1], /^FQR2\|P\|/);
  const part = decodeFqr2Part(frames[1], manifest);
  assert.equal(part.seqNum, 1);
});

test('later block visits use fresh repair sequence numbers rather than replaying systematic identity', async () => {
  const file = makeFile(10);
  const frames = [];
  const broadcaster = createFqr2Broadcaster(file, {
    streamId: '0123456789AB', symbolBytes: 768,
    emitFrame: async frame => frames.push(frame), yieldControl: async () => {},
  });
  await broadcaster.runVisits(2);
  const manifests = frames.filter(frame => frame.startsWith('FQR2|M|'));
  const parts = frames.filter(frame => frame.startsWith('FQR2|P|'));
  assert.equal(manifests.length, 2);
  const manifest = decodeFqr2Manifest(manifests[0]);
  assert.deepEqual(parts.map(frame => decodeFqr2Part(frame, manifest).seqNum), [1,2]);
});

test('receiver ignores parts before manifest and owns only one incomplete block at a time', async () => {
  const writes = [];
  const store = {
    completedBlocks: 0,
    hasBlock: () => false,
    async writeVerifiedBlock(index) { writes.push(index); this.completedBlocks += 1; },
    async finalize() { return new File([], 'sample.bin'); },
    async abort() {}, async cleanup() {},
  };
  const receiver = createFqr2Receiver({ openStore: async () => store });
  const manifestFrame = encodeFqr2Manifest({
    streamId: '0123456789AB', fileSize: 65540, symbolBytes: 768,
    name: 'sample.bin', type: 'application/octet-stream',
  });
  const manifest = decodeFqr2Manifest(manifestFrame);
  const block0Part = encodeFqr2Part({
    streamId: manifest.streamId, blockIndex: 0, seqNum: 1, seqLen: 86,
    blockLength: 65536, blockSha256: '11'.repeat(32), payload: new Uint8Array(768),
  });
  const block1Part = encodeFqr2Part({
    streamId: manifest.streamId, blockIndex: 1, seqNum: 1, seqLen: 1,
    blockLength: 4, blockSha256: '22'.repeat(32), payload: new Uint8Array(768),
  });
  assert.deepEqual(await receiver.accept(block0Part), { accepted: false, reason: 'manifest-required' });
  await receiver.accept(manifestFrame);
  await receiver.accept(block0Part);
  assert.equal(receiver.activeBlockIndex, 0);
  await receiver.accept(block1Part);
  assert.equal(receiver.activeBlockIndex, 0);
  assert.equal(receiver.bufferedOtherBlockCount, 0);
  assert.deepEqual(writes, []);
});

test('receiver retries store opening after a transient manifest admission failure', async () => {
  let openAttempts = 0;
  const store = {
    completedBlocks: 0,
    hasBlock: () => false,
    async writeVerifiedBlock() {},
    async finalize() { return new File([], 'sample.bin'); },
    async abort() {}, async cleanup() {},
  };
  const receiver = createFqr2Receiver({
    openStore: async () => {
      openAttempts += 1;
      if (openAttempts === 1) throw new Error('storage temporarily unavailable');
      return store;
    },
  });
  const manifestFrame = encodeFqr2Manifest({
    streamId: '0123456789AB', fileSize: 4, symbolBytes: 768,
    name: 'sample.bin', type: 'application/octet-stream',
  });
  await assert.rejects(() => receiver.accept(manifestFrame), /storage temporarily unavailable/);
  assert.equal(receiver.manifest, null, 'failed storage admission must not lock manifest state');
  const retry = await receiver.accept(manifestFrame);
  assert.equal(retry.accepted, true);
  assert.equal(openAttempts, 2);
  assert.equal(receiver.manifest.streamId, '0123456789AB');
});

test('receiver retries finalization from durable complete state on a repeated manifest', async () => {
  let finalizeAttempts = 0;
  const store = {
    completedBlocks: 0,
    hasBlock: index => index === 0 && store.completedBlocks === 1,
    async writeVerifiedBlock() { this.completedBlocks = 1; },
    async finalize() {
      finalizeAttempts += 1;
      if (finalizeAttempts === 1) throw new Error('finalize temporarily unavailable');
      return new File([Uint8Array.from([1,2,3,4])], 'x.bin');
    },
    async abort() {}, async cleanup() {},
  };
  const receiver = createFqr2Receiver({ openStore: async () => store });
  const manifestFrame = encodeFqr2Manifest({
    streamId: '0123456789AB', fileSize: 4, symbolBytes: 768,
    name: 'x.bin', type: 'application/octet-stream',
  });
  await receiver.accept(manifestFrame);
  const part = encodeFqr2Part({
    streamId: '0123456789AB', blockIndex: 0, seqNum: 1, seqLen: 1,
    blockLength: 4,
    blockSha256: '9f64a747e1b97f131fabb6b447296c9b6f0201e79fb3c5356e6c77e89b6a806a',
    payload: Uint8Array.from([1,2,3,4, ...new Array(764).fill(0)]),
  });
  await assert.rejects(() => receiver.accept(part), /finalize temporarily unavailable/);
  assert.equal(receiver.completedBlocks, 1, 'verified durable block progress must survive finalization failure');
  assert.equal(receiver.complete, false);
  const retry = await receiver.accept(manifestFrame);
  assert.equal(finalizeAttempts, 2);
  assert.equal(retry.complete, true);
  assert.equal(retry.file.name, 'x.bin');
  assert.equal(receiver.complete, true);
});

test('receiver durable progress advances only after verified block storage resolves', async () => {
  let resolveWrite;
  let signalWriteStarted;
  const writeStarted = new Promise(resolve => { signalWriteStarted = resolve; });
  const store = {
    completedBlocks: 0,
    hasBlock: () => false,
    async writeVerifiedBlock() {
      signalWriteStarted();
      await new Promise(resolve => { resolveWrite = resolve; });
      this.completedBlocks = 1;
    },
    async finalize() { return new File([Uint8Array.from([1,2,3,4])], 'x.bin'); },
    async abort() {}, async cleanup() {},
  };
  const receiver = createFqr2Receiver({ openStore: async () => store });
  const manifestFrame = encodeFqr2Manifest({
    streamId: '0123456789AB', fileSize: 4, symbolBytes: 768,
    name: 'x.bin', type: 'application/octet-stream',
  });
  await receiver.accept(manifestFrame);
  const part = encodeFqr2Part({
    streamId: '0123456789AB', blockIndex: 0, seqNum: 1, seqLen: 1,
    blockLength: 4,
    blockSha256: '9f64a747e1b97f131fabb6b447296c9b6f0201e79fb3c5356e6c77e89b6a806a',
    payload: Uint8Array.from([1,2,3,4, ...new Array(764).fill(0)]),
  });
  const pending = receiver.accept(part);
  await writeStarted;
  assert.equal(receiver.completedBlocks, 0);
  resolveWrite();
  await pending;
  assert.equal(receiver.completedBlocks, 1);
});
