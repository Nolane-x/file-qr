import { compactReceiveCode } from '../../../packages/core/session.js';

export function buildSignalWebSocketUrl(origin, code, role, token = '') {
  const url = new URL(origin);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  url.pathname = `/v1/sessions/${compactReceiveCode(code)}/connect`;
  url.search = '';
  url.searchParams.set('role', role);
  if (role === 'sender' && token) url.searchParams.set('token', token);
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

export function sendSignal(socket, payload) {
  if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(payload));
}
