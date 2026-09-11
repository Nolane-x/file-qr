const STATES = new Set([
  'idle',
  'connecting-direct',
  'direct',
  'direct-exhausted',
  'connecting-relay',
  'relay',
  'completed',
  'failed',
]);

function transition(state, action) {
  return { state, action };
}

export function createTransportPolicy({ hasRelaySecret = false, forceRelay = false } = {}) {
  let state = 'idle';

  function set(next, action) {
    if (!STATES.has(next)) throw new Error('Invalid transport state');
    state = next;
    return transition(state, action);
  }

  return {
    get state() { return state; },
    start() {
      if (state !== 'idle') throw new Error('Transport policy already started');
      if (forceRelay) {
        return hasRelaySecret
          ? set('connecting-relay', 'connect-relay')
          : set('failed', 'require-qr-relay-secret');
      }
      return set('connecting-direct', 'connect-direct');
    },
    directConnected() {
      if (state !== 'connecting-direct') throw new Error('Direct transport is not connecting');
      return set('direct', 'use-direct');
    },
    directDisconnected() {
      if (state !== 'direct' && state !== 'connecting-direct') throw new Error('Direct transport is not active');
      return transition(state, 'wait-direct-recovery');
    },
    directExhausted({ committedBytes = 0 } = {}) {
      if (state !== 'connecting-direct' && state !== 'direct') throw new Error('Direct transport is not active');
      if (!Number.isSafeInteger(committedBytes) || committedBytes < 0) throw new Error('Invalid committed byte count');
      state = 'direct-exhausted';
      if (committedBytes > 0) return set('failed', 'retry-new-attempt');
      if (!hasRelaySecret) return set('failed', 'require-qr-relay-secret');
      return set('connecting-relay', 'connect-relay');
    },
    relayConnected() {
      if (state !== 'connecting-relay') throw new Error('Relay transport is not connecting');
      return set('relay', 'use-relay');
    },
    complete() {
      if (state !== 'direct' && state !== 'relay') throw new Error('No active transport can complete');
      return set('completed', 'complete');
    },
    fail() {
      return set('failed', 'fail');
    },
  };
}
