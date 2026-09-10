import test from 'node:test';
import assert from 'node:assert/strict';
import { Fqr2BlockDecoder } from '../../packages/core/fountain-decoder.js';
import { encodeFountainPart, fountainIndexes } from '../../packages/core/fountain.js';

const BLOCK = Uint8Array.from({ length: 16 }, (_, i) => i);
const BLOCK_SHA = 'be45cb2605bf36bebde684841a28f0fd43c69850a3dce5fedba69928ee3a8991';

test('bounded decoder recovers omitted systematic symbols from later repair parts', async () => {
  const decoder = new Fqr2BlockDecoder({ blockLength: 16, symbolBytes: 4, blockSha256: BLOCK_SHA });
  await decoder.accept({ seqNum: 1, payload: Uint8Array.from([0,1,2,3]) });
  await decoder.accept({ seqNum: 3, payload: Uint8Array.from([8,9,10,11]) });
  await decoder.accept({ seqNum: 15, payload: Uint8Array.from([4,4,4,4]) });
  await decoder.accept({ seqNum: 9, payload: Uint8Array.from([8,8,8,8]) });
  assert.equal(decoder.complete, true);
  assert.deepEqual(decoder.bytes(), BLOCK);
});

test('decoder deduplicates sequence identities without growing state', async () => {
  const decoder = new Fqr2BlockDecoder({ blockLength: 16, symbolBytes: 4, blockSha256: BLOCK_SHA });
  const first = await decoder.accept({ seqNum: 1, payload: Uint8Array.from([0,1,2,3]) });
  const duplicate = await decoder.accept({ seqNum: 1, payload: Uint8Array.from([0,1,2,3]) });
  assert.equal(first.accepted, true);
  assert.equal(duplicate.duplicate, true);
  assert.equal(decoder.solvedCount, 1);
});

test('inconsistent degree-zero equation is rejected', async () => {
  const decoder = new Fqr2BlockDecoder({ blockLength: 16, symbolBytes: 4, blockSha256: BLOCK_SHA });
  await decoder.accept({ seqNum: 1, payload: Uint8Array.from([0,1,2,3]) });
  await assert.rejects(
    () => decoder.accept({ seqNum: 5, payload: Uint8Array.from([9,9,9,9]) }),
    /inconsistent|equation/i,
  );
  assert.equal(decoder.solvedCount, 1);
});

test('decoder sequence cache and unresolved equations stay bounded under thousands-scale repair pressure', async () => {
  const symbolBytes = 256;
  const sourceSymbols = Array.from({ length: 256 }, () => new Uint8Array(symbolBytes));
  const zeroHash = 'de2f256064a0af797747c2b97505dc0b9f3df0de4f489eac731c23ae9ca9cc31';
  const decoder = new Fqr2BlockDecoder({ blockLength: 65536, symbolBytes, blockSha256: zeroHash });
  let accepted = 0;
  for (let seqNum = 257; seqNum < 5000 && accepted < 1600; seqNum++) {
    const indexes = await fountainIndexes({ seqNum, k: 256, blockSha256: zeroHash });
    if (indexes.length <= 1) continue;
    const part = await encodeFountainPart({ sourceSymbols, seqNum, blockSha256: zeroHash });
    await decoder.accept({ seqNum, payload: part.payload });
    accepted += 1;
    assert.ok(decoder.unresolvedEquationCount <= 3 * decoder.k);
    assert.ok(decoder.recentSequenceCount <= 4 * decoder.k);
  }
  assert.ok(accepted >= 1000, 'test must apply thousands-scale unique repair pressure');
});

test('SHA mismatch never exposes completed bytes and resets block state', async () => {
  const decoder = new Fqr2BlockDecoder({ blockLength: 4, symbolBytes: 4, blockSha256: '00'.repeat(32) });
  await assert.rejects(
    () => decoder.accept({ seqNum: 1, payload: Uint8Array.from([1,2,3,4]) }),
    /SHA-256|hash/i,
  );
  assert.equal(decoder.complete, false);
  assert.equal(decoder.solvedCount, 0);
  assert.throws(() => decoder.bytes(), /incomplete/i);
});

test('zero-byte logical block completes only against SHA-256 of empty bytes', async () => {
  const decoder = new Fqr2BlockDecoder({
    blockLength: 0, symbolBytes: 4,
    blockSha256: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
  });
  await decoder.accept({ seqNum: 1, payload: new Uint8Array(4) });
  assert.equal(decoder.complete, true);
  assert.equal(decoder.bytes().byteLength, 0);
});
