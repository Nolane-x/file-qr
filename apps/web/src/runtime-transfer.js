import { DEFAULT_CHUNK_SIZE, decodeControlMessage, encodeControlMessage, validateResumeOffset } from '../../../packages/core/transfer.js';
import { createReceiveSink, downloadReceivedFile } from './storage.js';
import { parseDataChannelMessage, streamFileOverChannel, waitForBufferedAmountLow } from './webrtc.js';
import {
  cleanupAttempt,
  cleanupLease,
  current,
  failTransfer,
  formatBytes,
  leaseOpen,
  resetProgress,
  runtimeHooks,
  setState,
  stopConnectionTimer,
  ui,
  updateProgress,
} from './runtime-core.js';

export function controlEnvelope(type, payload) {
  return JSON.parse(encodeControlMessage(type, payload));
}

export function decodeRelayControl(value) {
  if (typeof value === 'string') return decodeControlMessage(value);
  return decodeControlMessage(JSON.stringify(value));
}

export async function completeSender(payload, attemptId) {
  const active = current();
  if (active.attempt.id !== attemptId) return;
  if (payload.fileId !== active.fileId || payload.size !== active.file.size) return;
  active.attempt.acknowledged = true;
  active.attempt.transferred = active.file.size;
  updateProgress(active.file.size, active.file.size, 'Sent');
  try { active.attempt.transportPolicy?.complete(); } catch { /* completion is already final */ }
  active.attemptsCompleted += 1;
  const completedCount = active.attemptsCompleted;
  const fileName = active.file.name;
  await cleanupAttempt();
  resetProgress();
  if (leaseOpen() && !current().leaseExpired) {
    setState('ready', `${fileName} sent successfully (${completedCount}). Code remains available for another receiver until 00:00.`);
  } else {
    await cleanupLease({ keepView: true });
    setState('done', `${fileName} sent successfully. The 10-minute receive window is now closed.`);
  }
}

export async function handleSenderControlMessage(message, attemptId, streamFromOffset, options = {}) {
  const active = current();
  if (active.role !== 'sender' || active.attempt.id !== attemptId) return;
  const { type, payload } = message;

  if (type === 'resume-request') {
    if (payload.fileId !== active.fileId || active.attempt.streaming) return;
    const offset = validateResumeOffset(payload.offset, active.file.size);
    active.attempt.streaming = true;
    active.attempt.resumeOffset = offset;
    active.attempt.transferred = offset;
    active.attempt.committedBytes = 0;
    active.attempt.startedAt = performance.now();
    const relayed = active.attempt.transportType === 'worker-relay';
    setState('sending', offset > 0
      ? `Resuming ${active.file.name} from ${formatBytes(offset)}${relayed ? ' through the secure relay' : ''}.`
      : `${relayed ? 'Relayed securely. Sending' : 'Sending'} ${active.file.name} to the receiver.`);
    updateProgress(offset, active.file.size, offset > 0 ? 'Resuming' : 'Sending');

    const runStream = async () => {
      try {
        if (relayed) {
          const transport = current().attempt.id === attemptId ? current().attempt.relayTransport : null;
          if (!transport) throw new Error('Secure relay transport is unavailable');
          await transport.declareRemaining(active.file.size - offset);
        }
        await streamFromOffset(offset);
        if (current().attempt.id === attemptId) {
          setState('verifying', 'All bytes sent. Waiting for the receiver to confirm the completed file.');
        }
      } catch (error) {
        if (current().attempt.id === attemptId) {
          await failTransfer(error?.message || 'The send stream failed.');
        }
      }
    };

    if (options.detachStream === true) {
      void runStream();
      return;
    }
    await runStream();
    return;
  }

  if (type === 'complete-ack') await completeSender(payload, attemptId);
}

export async function handleSenderChannelMessage(event, attemptId) {
  const parsed = parseDataChannelMessage(event.data);
  if (parsed.kind !== 'control') return;
  await handleSenderControlMessage(parsed.message, attemptId, async (offset) => {
    const active = current();
    await streamFileOverChannel(active.file, active.attempt.channel, {
      fileId: active.fileId,
      offset,
      onProgress(done, total) {
        const latest = current();
        if (latest.attempt.id !== attemptId) return;
        latest.attempt.transferred = done;
        latest.attempt.committedBytes = Math.max(0, done - offset);
        updateProgress(done, total, 'Sending');
      },
    });
  });
}

export async function handleSenderRelayControl(value, attemptId) {
  const message = decodeRelayControl(value);
  await handleSenderControlMessage(message, attemptId, async (offset) => {
    const active = current();
    const transport = active.attempt.relayTransport;
    if (!transport) throw new Error('Secure relay transport is unavailable');
    for (let start = offset; start < active.file.size; start += DEFAULT_CHUNK_SIZE) {
      const end = Math.min(active.file.size, start + DEFAULT_CHUNK_SIZE);
      const bytes = new Uint8Array(await active.file.slice(start, end).arrayBuffer());
      await transport.send(bytes);
      const latest = current();
      if (latest.attempt.id !== attemptId) return;
      latest.attempt.transferred = end;
      latest.attempt.committedBytes = Math.max(0, end - offset);
      updateProgress(end, latest.file.size, 'Sending');
    }
    const latest = current();
    if (latest.attempt.id !== attemptId) return;
    await transport.sendControl(controlEnvelope('transfer-complete', { fileId: latest.fileId, size: latest.file.size }));
  }, { detachStream: true });
}

export function validateFileOffer(payload) {
  if (!payload || typeof payload.fileId !== 'string' || !payload.fileId) throw new Error('Invalid file offer identity');
  if (typeof payload.name !== 'string' || !payload.name) throw new Error('Invalid file offer name');
  if (!Number.isSafeInteger(payload.size) || payload.size < 0) throw new Error('Invalid file offer size');
  return {
    fileId: payload.fileId,
    name: payload.name,
    size: payload.size,
    type: payload.type || 'application/octet-stream',
    chunkSize: payload.chunkSize || DEFAULT_CHUNK_SIZE,
  };
}

export async function receiveFileOffer(payload, attemptId, sendControl) {
  const active = current();
  if (active.role !== 'receiver' || active.attempt.id !== attemptId) return;
  const meta = validateFileOffer(payload);
  active.attempt.meta = meta;
  ui.fileName.textContent = meta.name;
  ui.fileSize.textContent = formatBytes(meta.size);
  const sink = await createReceiveSink(meta, { leaseCode: active.code, fileId: meta.fileId });
  if (current().attempt.id !== attemptId) {
    await sink.abort?.({ discard: false });
    return;
  }
  const latest = current();
  latest.attempt.sink = sink;
  latest.attempt.resumeOffset = sink.offset;
  latest.attempt.transferred = sink.offset;
  latest.attempt.committedBytes = 0;
  latest.attempt.startedAt = performance.now();
  const relayed = latest.attempt.transportType === 'worker-relay';
  setState('receiving', sink.offset > 0
    ? `Resuming ${meta.name} from ${formatBytes(sink.offset)}${relayed ? ' through the secure relay' : ''}.`
    : `${relayed ? 'Relayed securely. Receiving' : 'Receiving'} ${meta.name} from the sender.`);
  updateProgress(sink.offset, meta.size, sink.offset > 0 ? 'Resuming' : 'Receiving');
  await sendControl('resume-request', { fileId: meta.fileId, offset: sink.offset });
}

export async function receiveTransferBytes(bytes, attemptId) {
  const active = current();
  if (active.role !== 'receiver' || active.attempt.id !== attemptId) return;
  const { sink, meta } = active.attempt;
  if (!sink || !meta) throw new Error('Received file bytes before file offer.');
  await sink.write(bytes);
  const latest = current();
  if (latest.attempt.id !== attemptId) return;
  latest.attempt.transferred = sink.offset;
  latest.attempt.committedBytes += bytes.byteLength;
  updateProgress(sink.offset, meta.size, 'Receiving');
}

export async function finishReceivedTransfer(payload, attemptId, sendControl) {
  const active = current();
  if (active.role !== 'receiver' || active.attempt.id !== attemptId) return;
  const { sink, meta } = active.attempt;
  if (!sink || !meta) throw new Error('Transfer completed before file offer.');
  if (payload.fileId !== meta.fileId || payload.size !== meta.size) throw new Error('Transfer completion identity mismatch.');
  if (sink.offset !== meta.size) throw new Error('Transfer ended before all bytes arrived.');
  setState('verifying', 'Finalizing the received file…');
  const file = await sink.close();
  await sendControl('complete-ack', { fileId: meta.fileId, size: meta.size });
  downloadReceivedFile(file, meta.name);
  await sink.cleanup?.();
  if (current().attempt.id === attemptId) current().attempt.sink = null;
  updateProgress(meta.size, meta.size, 'Received');
  try { current().attempt.transportPolicy?.complete(); } catch { /* completion is already final */ }
  const detail = `${meta.name} is ready on this device.`;
  await cleanupLease({ keepView: true });
  setState('done', detail);
}

export async function handleReceiverRelayControl(value, attemptId) {
  const message = decodeRelayControl(value);
  const sendControl = async (type, payload) => {
    const transport = current().attempt.relayTransport;
    if (!transport) throw new Error('Secure relay transport is unavailable');
    await transport.sendControl(controlEnvelope(type, payload));
  };
  if (message.type === 'file-offer') {
    await receiveFileOffer(message.payload, attemptId, sendControl);
    return;
  }
  if (message.type === 'transfer-complete') {
    await finishReceivedTransfer(message.payload, attemptId, sendControl);
  }
}

export function bindReceiverChannel(channel, attemptId) {
  const active = current();
  if (active.attempt.id !== attemptId) return;
  active.attempt.channel = channel;
  channel.binaryType = 'arraybuffer';
  let chain = Promise.resolve();
  const sendControl = async (type, payload) => {
    channel.send(encodeControlMessage(type, payload));
    if (type === 'complete-ack') {
      try { await waitForBufferedAmountLow(channel, 1); } catch { /* ack was already queued */ }
    }
  };

  channel.addEventListener('open', () => {
    const latest = current();
    if (latest.attempt.id !== attemptId) return;
    const policy = latest.attempt.transportPolicy;
    if (policy?.state === 'connecting-direct') {
      try { policy.directConnected(); } catch { /* stale transition */ }
    }
    stopConnectionTimer();
    latest.attempt.startedAt = performance.now();
    ui.status.textContent = 'Direct channel open. Waiting for file offer…';
  });

  channel.addEventListener('message', (event) => {
    chain = chain.then(async () => {
      if (current().attempt.id !== attemptId) return;
      const parsed = parseDataChannelMessage(event.data);
      if (parsed.kind === 'control' && parsed.message.type === 'file-offer') {
        await receiveFileOffer(parsed.message.payload, attemptId, sendControl);
        return;
      }
      if (parsed.kind === 'binary') {
        await receiveTransferBytes(parsed.bytes, attemptId);
        return;
      }
      if (parsed.kind === 'control' && parsed.message.type === 'transfer-complete') {
        await finishReceivedTransfer(parsed.message.payload, attemptId, sendControl);
      }
    }).catch((error) => failTransfer(error?.message || 'The receive stream failed.'));
  });

  channel.addEventListener('error', () => {
    const latest = current();
    if (latest.attempt.id === attemptId && !latest.attempt.switchingTransport) {
      runtimeHooks.handleDirectExhausted?.('The receive data channel failed before the file completed.', attemptId).catch(() => {});
    }
  });
  channel.addEventListener('close', () => {
    const latest = current();
    if (latest.attempt.id !== attemptId || latest.attempt.switchingTransport || !['connecting', 'sending', 'receiving', 'verifying'].includes(latest.state)) return;
    runtimeHooks.handleDirectExhausted?.('The sender connection closed before the file completed.', attemptId).catch(() => {});
  });
}
