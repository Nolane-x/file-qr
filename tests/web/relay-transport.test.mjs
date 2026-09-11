import test from 'node:test';
import assert from 'node:assert/strict';

const moduleUrl = new URL('../../apps/web/src/relay-transport.js', import.meta.url);

async function load() {
  try { return await import(moduleUrl); }
  catch (error) { assert.fail(`relay-transport.js must exist: ${error?.message || error}`); }
}

class FakeSocket {
  constructor() { this.readyState = 1; this.sent = []; this.listeners = new Map(); this.closed = false; }
  addEventListener(type, fn) { const list = this.listeners.get(type) || []; list.push(fn); this.listeners.set(type, list); }
  removeEventListener(type, fn) { this.listeners.set(type, (this.listeners.get(type) || []).filter((entry) => entry !== fn)); }
  send(value) { this.sent.push(value); }
  close() { this.closed = true; this.readyState = 3; this.emit('close', {}); }
  emit(type, event) { for (const fn of this.listeners.get(type) || []) fn(event); }
}

function u32(value) {
  const out = new Uint8Array(4);
  new DataView(out.buffer).setUint32(0, value, false);
  return out;
}

function fakeCrypto() {
  let sequence = 0;
  return {
    get nextSequence() { return sequence; },
    async encrypt(kind, plaintext) {
      const frame = { kind, sequence, plaintext: new Uint8Array(plaintext) };
      sequence += 1;
      return frame;
    },
    async decrypt(value) {
      if (value?.throw) throw new Error('auth failure');
      return value;
    },
  };
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

test('relay transport blocks a ninth unacknowledged data frame until cumulative ack advances window', async () => {
  const { createWorkerRelayTransport } = await load();
  const socket = new FakeSocket();
  const transport = createWorkerRelayTransport({ socket, role: 'sender', sendCrypto: fakeCrypto(), receiveCrypto: fakeCrypto(), ackIntervalMs: 10_000 });
  for (let index = 0; index < 8; index += 1) await transport.send(new Uint8Array([index]));
  let ninthDone = false;
  const ninth = transport.send(new Uint8Array([9])).then(() => { ninthDone = true; });
  await tick();
  assert.equal(ninthDone, false);
  socket.emit('message', { data: { kind: 'ack', sequence: 0, plaintext: u32(3) } });
  await ninth;
  assert.equal(ninthDone, true);
  assert.equal(transport.inFlight, 5);
  transport.close();
});

test('receiver emits cumulative encrypted ack every four data frames', async () => {
  const { createWorkerRelayTransport } = await load();
  const socket = new FakeSocket();
  const received = [];
  const transport = createWorkerRelayTransport({
    socket,
    role: 'receiver',
    sendCrypto: fakeCrypto(),
    receiveCrypto: fakeCrypto(),
    ackIntervalMs: 10_000,
    onData: (bytes) => received.push(bytes[0]),
  });
  for (let index = 0; index < 4; index += 1) {
    socket.emit('message', { data: { kind: 'data', sequence: index, plaintext: new Uint8Array([index]) } });
    await tick();
  }
  const ack = socket.sent.find((value) => value?.kind === 'ack');
  assert.ok(ack);
  assert.equal(new DataView(ack.plaintext.buffer, ack.plaintext.byteOffset, ack.plaintext.byteLength).getUint32(0, false), 3);
  assert.deepEqual(received, [0, 1, 2, 3]);
  transport.close();
});

test('relay transport fails closed on decrypt failure and rejects pending senders on close', async () => {
  const { createWorkerRelayTransport } = await load();
  const socket = new FakeSocket();
  const transport = createWorkerRelayTransport({ socket, role: 'sender', sendCrypto: fakeCrypto(), receiveCrypto: fakeCrypto(), ackIntervalMs: 10_000 });
  for (let index = 0; index < 8; index += 1) await transport.send(new Uint8Array([index]));
  const pending = assert.rejects(transport.send(new Uint8Array([9])), /closed|failed|relay|auth/i);
  socket.emit('message', { data: { throw: true } });
  await tick();
  assert.equal(socket.closed, true);
  await pending;
});
