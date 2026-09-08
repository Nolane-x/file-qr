import { isReceiveCode, normalizeReceiveCode } from '../../../packages/core/session.js';

function normalizeIfValid(value) {
  return isReceiveCode(value) ? normalizeReceiveCode(value) : null;
}

export function parseReceivePayload(input) {
  const raw = String(input ?? '').trim();
  if (!raw) return null;

  if (/^[0-9A-Za-z\s-]+$/.test(raw)) {
    const compact = raw.replace(/[^0-9A-Za-z]/g, '');
    if (compact.length === 10) return normalizeIfValid(raw);
  }

  try {
    const url = new URL(raw);
    const receive = url.searchParams.get('receive');
    return receive ? normalizeIfValid(receive) : null;
  } catch {
    return null;
  }
}
