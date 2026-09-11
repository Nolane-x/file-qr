import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createXoshiro256ss,
  fountainIndexes,
  splitSourceSymbols,
  encodeFountainPart,
} from '../../packages/core/fountain.js';

const HASH = '00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff';
const SEED = Uint8Array.from(Buffer.from('8dd21af39630ff5042c387a01e76136c6bcd202586e8f1f65a798a7879cd0fdf', 'hex'));

test('xoshiro256** matches independently fixed vector', () => {
  const next = createXoshiro256ss(SEED);
  assert.deepEqual(
    [next(), next(), next(), next(), next()].map(v => `0x${v.toString(16).padStart(16, '0')}`),
    ['0x2f6b92ad60b4ff56','0x66a6e04a4d9e41fc','0xb6a71f2dd5a4928e','0x9e42fc45ff03454e','0xd507e460c144c74d'],
  );
});

test('systematic FQR2 parts map one-to-one', async () => {
  assert.deepEqual(await fountainIndexes({ seqNum: 1, k: 4, blockSha256: HASH }), [0]);
  assert.deepEqual(await fountainIndexes({ seqNum: 4, k: 4, blockSha256: HASH }), [3]);
});

test('mixed FQR2 index selection matches independently fixed vectors', async () => {
  const expected = new Map([
    [5,[0]], [6,[0]], [7,[3,0,1]], [8,[0]], [9,[0]],
    [10,[3]], [11,[1,3]], [12,[1]], [13,[1,0]],
  ]);
  for (const [seqNum, indexes] of expected) {
    assert.deepEqual(await fountainIndexes({ seqNum, k: 4, blockSha256: HASH }), indexes, `seq ${seqNum}`);
  }
});

test('mixed payload matches independently fixed XOR vector', async () => {
  const sourceSymbols = [
    Uint8Array.from([0x00,0x01,0x02,0x03]),
    Uint8Array.from([0x10,0x11,0x12,0x13]),
    Uint8Array.from([0x20,0x21,0x22,0x23]),
    Uint8Array.from([0x30,0x31,0x32,0x33]),
  ];
  const encoded = await encodeFountainPart({ sourceSymbols, seqNum: 7, blockSha256: HASH });
  assert.deepEqual(encoded.indexes, [3,0,1]);
  assert.equal(Buffer.from(encoded.payload).toString('hex'), '20212223');
});

test('source splitting pads only the final symbol and handles empty logical blocks', () => {
  const symbols = splitSourceSymbols(Uint8Array.from([1,2,3,4,5]), 4);
  assert.equal(symbols.length, 2);
  assert.deepEqual(symbols[0], Uint8Array.from([1,2,3,4]));
  assert.deepEqual(symbols[1], Uint8Array.from([5,0,0,0]));
  const empty = splitSourceSymbols(new Uint8Array(0), 4);
  assert.deepEqual(empty, [new Uint8Array(4)]);
});

test('selector rejects invalid k, sequence identity and hash syntax', async () => {
  await assert.rejects(() => fountainIndexes({ seqNum: 0, k: 4, blockSha256: HASH }), /sequence/i);
  await assert.rejects(() => fountainIndexes({ seqNum: 5, k: 0, blockSha256: HASH }), /source|k/i);
  await assert.rejects(() => fountainIndexes({ seqNum: 5, k: 4, blockSha256: 'AA'.repeat(32) }), /SHA|hash/i);
});
