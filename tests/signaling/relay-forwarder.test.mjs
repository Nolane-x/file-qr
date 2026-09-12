import test from 'node:test';
import assert from 'node:assert/strict';
import { encodeRelayFrame } from '../../packages/core/relay-frame.js';

const moduleUrl = new URL('../../services/signaling/src/relay-forwarder.js', import.meta.url);

async function load() {
  try { return await import(moduleUrl); }
  catch (error) { assert.fail(`relay-forwarder.js must exist: ${error?.message || error}`); }
}

function frame({ attemptId = 3, sequence = 0, kind = 'data', plaintextLength = 1 } = {}) {
  return encodeRelayFrame({
    attemptId,
    sequence,
    kind,
    plaintextLength,
    ciphertext: new Uint8Array(plaintextLength + 16),
  });
}

test('relay budget is bounded by declared remaining bytes and fixed protocol overhead', async () => {
  const { createRelayBudget, RELAY_MAX_SESSION_DECLARED_BYTES } = await load();
  assert.equal(RELAY_MAX_SESSION_DECLARED_BYTES, 512 * 1024 * 1024);
  assert.deepEqual(createRelayBudget(0), { remainingBytes: 0, dataLimit: 1024 * 1024, controlLimit: 4 * 1024 * 1024 });
  assert.equal(createRelayBudget(100 * 1024 * 1024).dataLimit, 102 * 1024 * 1024);
  assert.throws(() => createRelayBudget(RELAY_MAX_SESSION_DECLARED_BYTES + 1), /remaining|limit/i);
});

test('sender may tighten remaining-byte budget before first data frame only', async () => {
  const { createRelayForwardState, tightenRelayBudget } = await load();
  let state = createRelayForwardState({ attemptId: 3, role: 'sender', remainingBytes: 1_000, now: 100 });
  state = tightenRelayBudget(state, 250, 200);
  assert.equal(state.budget.remainingBytes, 250);
  assert.equal(state.lastProgressAt, 200);
  assert.throws(() => tightenRelayBudget(state, 251, 201), /increase|remaining/i);
  assert.throws(() => tightenRelayBudget({ ...state, dataForwarded: 1 }, 100, 202), /data|started/i);
  const receiver = createRelayForwardState({ attemptId: 3, role: 'receiver', remainingBytes: 0, now: 100 });
  assert.throws(() => tightenRelayBudget(receiver, 0, 200), /sender|role/i);
});

test('valid relay frames advance exact sequence and bounded byte counters', async () => {
  const { createRelayForwardState, processRelayFrame } = await load();
  let state = createRelayForwardState({ attemptId: 3, role: 'sender', remainingBytes: 100, now: 1_000 });
  let result = processRelayFrame(state, frame({ sequence: 0, plaintextLength: 40 }), 1_100);
  assert.equal(result.ok, true);
  state = result.state;
  assert.equal(state.lastSequence, 0);
  assert.equal(state.dataForwarded, 40);
  assert.equal(state.lastProgressAt, 1_100);
  result = processRelayFrame(state, frame({ sequence: 1, kind: 'control', plaintextLength: 5 }), 1_200);
  assert.equal(result.ok, true);
  assert.equal(result.state.controlForwarded, 35);
});

test('replay, wrong attempt, receiver data and budget overflow are immediate fatal violations', async () => {
  const { createRelayForwardState, processRelayFrame } = await load();
  const state = createRelayForwardState({ attemptId: 3, role: 'sender', remainingBytes: 1, now: 0 });
  const first = processRelayFrame(state, frame({ sequence: 0, plaintextLength: 1 }), 1);
  assert.equal(first.ok, true);
  assert.equal(processRelayFrame(first.state, frame({ sequence: 0, plaintextLength: 1 }), 2).fatal, true);
  assert.equal(processRelayFrame(state, frame({ attemptId: 4, sequence: 0 }), 2).fatal, true);
  const receiver = createRelayForwardState({ attemptId: 3, role: 'receiver', remainingBytes: 0, now: 0 });
  assert.equal(processRelayFrame(receiver, frame({ sequence: 0 }), 1).fatal, true);
  const tinyBudget = createRelayForwardState({ attemptId: 3, role: 'sender', remainingBytes: 64 * 1024, now: 0 });
  const allowed = processRelayFrame(tinyBudget, frame({ sequence: 0, plaintextLength: 64 * 1024 }), 1);
  assert.equal(allowed.ok, true);
  const overflow = processRelayFrame(allowed.state, frame({ sequence: 1, plaintextLength: 1 }), 2);
  assert.equal(overflow.fatal, true);
});

test('structural malformed frames abort only on the third violation', async () => {
  const { createRelayForwardState, processRelayFrame } = await load();
  let state = createRelayForwardState({ attemptId: 3, role: 'sender', remainingBytes: 10, now: 0 });
  const malformed = new Uint8Array([1, 2, 3]);
  let result = processRelayFrame(state, malformed, 1);
  assert.equal(result.ok, false);
  assert.equal(result.fatal, false);
  state = result.state;
  result = processRelayFrame(state, malformed, 2);
  assert.equal(result.fatal, false);
  state = result.state;
  result = processRelayFrame(state, malformed, 3);
  assert.equal(result.fatal, true);
  assert.equal(result.state.malformedCount, 3);
});

test('idle detection is based on valid protocol progress and fixed 30 second ceiling', async () => {
  const { createRelayForwardState, isRelayForwardIdle, RELAY_IDLE_TIMEOUT_MS } = await load();
  assert.equal(RELAY_IDLE_TIMEOUT_MS, 30_000);
  const state = createRelayForwardState({ attemptId: 3, role: 'sender', remainingBytes: 10, now: 100 });
  assert.equal(isRelayForwardIdle(state, 30_099), false);
  assert.equal(isRelayForwardIdle(state, 30_100), true);
});
