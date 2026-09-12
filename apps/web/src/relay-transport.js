const encoder = new TextEncoder();
const decoder = new TextDecoder();

function uint32Bytes(value) {
  const out = new Uint8Array(4);
  new DataView(out.buffer).setUint32(0, value, false);
  return out;
}

function readUint32(bytes) {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength !== 4) throw new Error('Invalid relay acknowledgement');
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(0, false);
}

function controlBytes(value) {
  if (value instanceof Uint8Array) return value;
  if (typeof value === 'string') return encoder.encode(value);
  return encoder.encode(JSON.stringify(value));
}

export function createWorkerRelayTransport({
  socket,
  role,
  sendCrypto,
  receiveCrypto,
  maxInFlight = 8,
  ackEvery = 4,
  ackIntervalMs = 250,
  onData = () => {},
  onControl = () => {},
  onError = () => {},
  schedule = (fn, ms) => setTimeout(fn, ms),
  cancel = (id) => clearTimeout(id),
} = {}) {
  if (!socket || typeof socket.send !== 'function') throw new TypeError('Relay socket is required');
  if (role !== 'sender' && role !== 'receiver') throw new Error('Invalid relay role');
  if (!sendCrypto?.encrypt || !receiveCrypto?.decrypt) throw new TypeError('Relay crypto contexts are required');
  if (!Number.isInteger(maxInFlight) || maxInFlight < 1) throw new Error('Invalid relay in-flight window');
  if (!Number.isInteger(ackEvery) || ackEvery < 1) throw new Error('Invalid relay acknowledgement cadence');

  let closed = false;
  let closeError = null;
  let availableSlots = maxInFlight;
  let slotWaiters = [];
  let pendingData = [];
  let highestDataSent = -1;
  let receivedSinceAck = 0;
  let highestDataReceived = -1;
  let ackTimer = null;
  let outboundChain = Promise.resolve();
  let incomingChain = Promise.resolve();
  let releaseRelayMessageHandler = null;

  function ensureOpen() {
    if (closed || socket.readyState !== 1) throw closeError || new Error('Relay transport is closed');
  }

  function queueOutbound(operation) {
    const next = outboundChain.then(async () => {
      ensureOpen();
      return operation();
    });
    outboundChain = next.catch(() => {});
    return next;
  }

  function acquireSlot() {
    if (closed) return Promise.reject(closeError || new Error('Relay transport is closed'));
    if (availableSlots > 0) {
      availableSlots -= 1;
      return Promise.resolve();
    }
    return new Promise((resolve, reject) => slotWaiters.push({ resolve, reject }));
  }

  function releaseSlots(count) {
    for (let index = 0; index < count; index += 1) {
      const waiter = slotWaiters.shift();
      if (waiter) waiter.resolve();
      else availableSlots = Math.min(maxInFlight, availableSlots + 1);
    }
  }

  function rejectWaiters(error) {
    const waiters = slotWaiters;
    slotWaiters = [];
    for (const waiter of waiters) waiter.reject(error);
  }

  function shutdown(error, { closeSocket = true } = {}) {
    if (closed) return;
    closed = true;
    closeError = error instanceof Error ? error : new Error(String(error || 'Relay transport closed'));
    if (ackTimer !== null) cancel(ackTimer);
    ackTimer = null;
    rejectWaiters(closeError);
    if (closeSocket) {
      try { socket.close(4003, 'Relay transport failed'); } catch { /* no-op */ }
    }
  }

  async function sendAck() {
    if (closed || highestDataReceived < 0 || receivedSinceAck === 0) return;
    const acked = highestDataReceived;
    receivedSinceAck = 0;
    if (ackTimer !== null) cancel(ackTimer);
    ackTimer = null;
    await queueOutbound(async () => {
      const frame = await sendCrypto.encrypt('ack', uint32Bytes(acked));
      socket.send(frame);
    });
  }

  function scheduleAck() {
    if (receivedSinceAck >= ackEvery) {
      sendAck().catch((error) => fail(error));
      return;
    }
    if (ackTimer === null) {
      ackTimer = schedule(() => {
        ackTimer = null;
        sendAck().catch((error) => fail(error));
      }, ackIntervalMs);
    }
  }

  function applyAck(acked) {
    if (acked > highestDataSent) throw new Error('Relay acknowledgement exceeds sent data');
    const before = pendingData.length;
    pendingData = pendingData.filter((sequence) => sequence > acked);
    releaseSlots(before - pendingData.length);
  }

  function fail(error) {
    const normalized = error instanceof Error ? error : new Error(String(error || 'Relay transport failed'));
    shutdown(normalized);
    try { onError(normalized); } catch { /* consumer error is non-authoritative */ }
  }

  async function handleMessage(data) {
    if (typeof data === 'string') return;
    const decoded = await receiveCrypto.decrypt(data);
    if (decoded.kind === 'data') {
      if (role !== 'receiver') throw new Error('Relay role received forbidden data');
      await onData(decoded.plaintext);
      highestDataReceived = decoded.sequence;
      receivedSinceAck += 1;
      scheduleAck();
      return;
    }
    if (decoded.kind === 'ack') {
      applyAck(readUint32(decoded.plaintext));
      return;
    }
    if (decoded.kind === 'control') {
      const text = decoder.decode(decoded.plaintext);
      let value = text;
      try { value = JSON.parse(text); } catch { /* preserve raw text */ }
      await onControl(value);
      return;
    }
    if (decoded.kind === 'abort') throw new Error('Relay peer aborted the transfer');
    throw new Error('Unsupported relay frame kind');
  }

  const onMessage = (event) => {
    incomingChain = incomingChain.then(() => handleMessage(event.data)).catch((error) => fail(error));
  };
  const onClose = () => shutdown(new Error('Relay socket closed'), { closeSocket: false });
  const onSocketError = () => fail(new Error('Relay socket failed'));

  if (typeof socket.fileQrAdoptRelayMessageHandler === 'function') {
    releaseRelayMessageHandler = socket.fileQrAdoptRelayMessageHandler(onMessage);
  } else {
    socket.addEventListener?.('message', onMessage);
  }
  socket.addEventListener?.('close', onClose);
  socket.addEventListener?.('error', onSocketError);

  return {
    get inFlight() { return pendingData.length; },
    get readyState() { return closed ? 'closed' : 'open'; },
    async declareRemaining(remaining) {
      if (role !== 'sender') throw new Error('Only sender relay transport may declare remaining bytes');
      if (!Number.isSafeInteger(remaining) || remaining < 0) throw new Error('Invalid relay remaining bytes');
      if (highestDataSent >= 0) throw new Error('Relay data already started');
      return queueOutbound(async () => {
        socket.send(JSON.stringify({ type: 'relay-budget', remaining }));
      });
    },
    async send(input) {
      if (role !== 'sender') throw new Error('Only sender relay transport may send file data');
      await acquireSlot();
      try {
        return await queueOutbound(async () => {
          const sequence = sendCrypto.nextSequence;
          const frame = await sendCrypto.encrypt('data', input);
          socket.send(frame);
          pendingData.push(sequence);
          highestDataSent = sequence;
          return sequence;
        });
      } catch (error) {
        releaseSlots(1);
        throw error;
      }
    },
    async sendControl(value) {
      return queueOutbound(async () => {
        const frame = await sendCrypto.encrypt('control', controlBytes(value));
        socket.send(frame);
      });
    },
    async abort(reason = 'aborted') {
      try {
        await queueOutbound(async () => {
          const frame = await sendCrypto.encrypt('abort', encoder.encode(String(reason)));
          socket.send(frame);
        });
      } finally {
        shutdown(new Error('Relay transfer aborted'));
      }
    },
    close() {
      shutdown(new Error('Relay transport closed'));
      if (releaseRelayMessageHandler) releaseRelayMessageHandler();
      else socket.removeEventListener?.('message', onMessage);
      socket.removeEventListener?.('close', onClose);
      socket.removeEventListener?.('error', onSocketError);
    },
  };
}