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
    const onOpen = () => { cleanup(); resolve(socket); };
    const onError = () => { cleanup(); reject(new Error('Could not connect to the transfer session.')); };
    const cleanup = () => {
      socket.removeEventListener('open', onOpen);
      socket.removeEventListener('error', onError);
    };
    socket.addEventListener('open', onOpen, { once: true });
    socket.addEventListener('error', onError, { once: true });
  });
}

export function sendSignal(socket, payload) {
  if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(payload));
}
