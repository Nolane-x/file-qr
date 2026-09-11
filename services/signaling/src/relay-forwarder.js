import { parseRelayFrame } from '../../../packages/core/relay-frame.js';

export const RELAY_CONTROL_BUDGET_BYTES = 4 * 1024 * 1024;
export const RELAY_IDLE_TIMEOUT_MS = 30_000;
export const RELAY_MAX_STRUCTURAL_VIOLATIONS = 3;
export const RELAY_MAX_SESSION_DECLARED_BYTES = 512 * 1024 * 1024;

export function createRelayBudget(remainingBytes) {
  if (!Number.isSafeInteger(remainingBytes) || remainingBytes < 0 || remainingBytes > RELAY_MAX_SESSION_DECLARED_BYTES) {
    throw new RangeError('Relay remaining byte declaration exceeds limit');
  }
  return {
    remainingBytes,
    dataLimit: remainingBytes + Math.max(1024 * 1024, Math.ceil(remainingBytes * 0.02)),
    controlLimit: RELAY_CONTROL_BUDGET_BYTES,
  };
}

export function createRelayForwardState({ attemptId, role, remainingBytes = 0, now = Date.now() }) {
  if (!Number.isSafeInteger(attemptId) || attemptId <= 0 || attemptId > 0xffff_ffff) throw new Error('Invalid relay attempt id');
  if (role !== 'sender' && role !== 'receiver') throw new Error('Invalid relay role');
  return {
    attemptId,
    role,
    budget: createRelayBudget(remainingBytes),
    lastSequence: -1,
    dataForwarded: 0,
    encodedDataForwarded: 0,
    controlForwarded: 0,
    malformedCount: 0,
    lastProgressAt: now,
  };
}

function failure(state, code, { fatal = true, malformed = false } = {}) {
  const next = malformed ? { ...state, malformedCount: state.malformedCount + 1 } : state;
  return {
    ok: false,
    fatal: fatal || next.malformedCount >= RELAY_MAX_STRUCTURAL_VIOLATIONS,
    error: code,
    state: next,
  };
}

export function processRelayFrame(state, input, now = Date.now()) {
  let parsed;
  try {
    parsed = parseRelayFrame(input, state.attemptId);
  } catch (error) {
    if (/attempt mismatch/i.test(String(error?.message || ''))) return failure(state, 'relay-attempt-violation');
    return failure(state, 'malformed-relay-frame', { fatal: false, malformed: true });
  }

  if (parsed.sequence !== state.lastSequence + 1) return failure(state, 'relay-sequence-violation');
  if (state.role === 'receiver' && parsed.kind === 'data') return failure(state, 'relay-role-data-violation');

  let dataForwarded = state.dataForwarded;
  let encodedDataForwarded = state.encodedDataForwarded;
  let controlForwarded = state.controlForwarded;
  if (parsed.kind === 'data') {
    dataForwarded += parsed.plaintextLength;
    encodedDataForwarded += input.byteLength;
    if (dataForwarded > state.budget.remainingBytes || encodedDataForwarded > state.budget.dataLimit) {
      return failure(state, 'relay-data-budget-exceeded');
    }
  } else {
    controlForwarded += input.byteLength;
    if (controlForwarded > state.budget.controlLimit) return failure(state, 'relay-control-budget-exceeded');
  }

  return {
    ok: true,
    fatal: false,
    frame: parsed,
    state: {
      ...state,
      lastSequence: parsed.sequence,
      dataForwarded,
      encodedDataForwarded,
      controlForwarded,
      lastProgressAt: now,
    },
  };
}

export function isRelayForwardIdle(state, now = Date.now()) {
  return now - state.lastProgressAt >= RELAY_IDLE_TIMEOUT_MS;
}
