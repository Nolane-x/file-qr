import { compactReceiveCode } from '../../../packages/core/session.js';

function wsOrigin(origin) {
  const url = new URL(origin);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  return url;
}

function base64Url(bytes) {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
}

export function decodeRelayNoncePrefix(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{11}$/.test(value)) throw new Error('Invalid relay nonce prefix');
  const binary = atob(value.replaceAll('-', '+').replaceAll('_', '/') + '=');
  if (binary.length !== 8) throw new Error('Invalid relay nonce prefix');
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

export function buildSignalWebSocketUrl(origin, code, role, token = '') {
  const url = wsOrigin(origin);
  url.pathname = `/v1/sessions/${compactReceiveCode(code)}/connect`;
  url.search = '';
  url.searchParams.set('role', role);
  if (role === 'sender' && token) url.searchParams.set('token', token);
  return url.toString();
}

export function buildRelayWebSocketUrl(origin, code, { role, attemptId, capability, remaining = null, noncePrefix } = {}) {
  if (role !== 'sender' && role !== 'receiver') throw new Error('Invalid relay role');
  if (!Number.isSafeInteger(attemptId) || attemptId <= 0 || attemptId > 0xffff_ffff) throw new Error('Invalid relay attempt id');
  if (typeof capability !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(capability)) throw new Error('Invalid relay capability');
  if (!(noncePrefix instanceof Uint8Array) || noncePrefix.byteLength !== 8) throw new Error('Invalid relay nonce prefix');
  if (role === 'sender' && (!Number.isSafeInteger(remaining) || remaining < 0)) throw new Error('Invalid relay remaining bytes');
  const url = wsOrigin(origin);
  url.pathname = `/v1/sessions/${compactReceiveCode(code)}/relay`;
  url.search = '';
  url.searchParams.set('role', role);
  url.searchParams.set('attemptId', String(attemptId));
  url.searchParams.set('cap', capability);
  url.searchParams.set('nonce', base64Url(noncePrefix));
  if (role === 'sender') url.searchParams.set('remaining', String(remaining));
  return url.toString();
}

export function connectSignal(origin, code, role, token = '') {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(buildSignalWebSocketUrl(origin, code, role, token));
    let handshakeSettled = false;
    let resolveConnected;
    let rejectConnected;

    socket.fileQrConnected = new Promise((resolveHandshake, rejectHandshake) => {
      resolveConnected = resolveHandshake;
      rejectConnected = rejectHandshake;
    });

    const onMessage = (event) => {
      let message;
      try { message = JSON.parse(event.data); } catch { return; }
      if (message.type === 'connected') {
        handshakeSettled = true;
        socket.removeEventListener('message', onMessage);
        socket.removeEventListener('close', onCloseBeforeHandshake);
        resolveConnected(message);
      }
    };
    const onCloseBeforeHandshake = () => {
      if (handshakeSettled) return;
      handshakeSettled = true;
      socket.removeEventListener('message', onMessage);
      rejectConnected(new Error('Transfer session closed before signaling handshake completed.'));
    };
    const onOpen = () => { cleanupOpen(); resolve(socket); };
    const onError = () => {
      cleanupOpen();
      if (!handshakeSettled) {
        handshakeSettled = true;
        socket.removeEventListener('message', onMessage);
        socket.removeEventListener('close', onCloseBeforeHandshake);
        rejectConnected(new Error('Could not complete the transfer signaling handshake.'));
      }
      reject(new Error('Could not connect to the transfer session.'));
    };
    const cleanupOpen = () => {
      socket.removeEventListener('open', onOpen);
      socket.removeEventListener('error', onError);
    };

    socket.addEventListener('message', onMessage);
    socket.addEventListener('close', onCloseBeforeHandshake, { once: true });
    socket.addEventListener('open', onOpen, { once: true });
    socket.addEventListener('error', onError, { once: true });
  });
}

export function connectRelay(origin, code, options) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(buildRelayWebSocketUrl(origin, code, options));
    socket.binaryType = 'arraybuffer';
    let settled = false;
    let resolveReady;
    let rejectReady;
    socket.fileQrRelayReady = new Promise((resolveHandshake, rejectHandshake) => {
      resolveReady = resolveHandshake;
      rejectReady = rejectHandshake;
    });
    const onMessage = (event) => {
      if (typeof event.data !== 'string') return;
      let message;
      try { message = JSON.parse(event.data); } catch { return; }
      if (message?.type !== 'relay-ready') return;
      try {
        const peerNoncePrefix = decodeRelayNoncePrefix(message.peerNoncePrefix);
        settled = true;
        socket.removeEventListener('message', onMessage);
        socket.removeEventListener('close', onCloseBeforeReady);
        resolveReady({ peerNoncePrefix });
      } catch (error) {
        settled = true;
        rejectReady(error);
        try { socket.close(); } catch { /* no-op */ }
      }
    };
    const onCloseBeforeReady = () => {
      if (settled) return;
      settled = true;
      socket.removeEventListener('message', onMessage);
      rejectReady(new Error('Relay closed before peer handshake completed.'));
    };
    const onOpen = () => { cleanupOpen(); resolve(socket); };
    const onError = () => { cleanupOpen(); reject(new Error('Could not connect to secure relay.')); };
    const cleanupOpen = () => {
      socket.removeEventListener('open', onOpen);
      socket.removeEventListener('error', onError);
    };
    socket.addEventListener('message', onMessage);
    socket.addEventListener('close', onCloseBeforeReady, { once: true });
    socket.addEventListener('open', onOpen, { once: true });
    socket.addEventListener('error', onError, { once: true });
  });
}

export function sendSignal(socket, payload) {
  if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(payload));
}
