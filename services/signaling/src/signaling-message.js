export const MAX_SIGNALING_MESSAGE_CHARS = 128 * 1024;
const MAX_SDP_CHARS = 64 * 1024;
const MAX_CANDIDATE_CHARS = 8 * 1024;
const MAX_SMALL_FIELD_CHARS = 256;

function positiveSafeInteger(value) {
  return Number.isSafeInteger(value) && value > 0;
}

function optionalBoundedString(value, maxChars) {
  return value === undefined || value === null
    || (typeof value === 'string' && value.length <= maxChars);
}

function validDescription(description) {
  return Boolean(
    description
    && typeof description === 'object'
    && !Array.isArray(description)
    && (description.type === 'offer' || description.type === 'answer')
    && typeof description.sdp === 'string'
    && description.sdp.length <= MAX_SDP_CHARS,
  );
}

function validCandidate(candidate) {
  if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return false;
  if (typeof candidate.candidate !== 'string' || candidate.candidate.length > MAX_CANDIDATE_CHARS) return false;
  if (!optionalBoundedString(candidate.sdpMid, MAX_SMALL_FIELD_CHARS)) return false;
  if (
    candidate.sdpMLineIndex !== undefined
    && candidate.sdpMLineIndex !== null
    && (!Number.isSafeInteger(candidate.sdpMLineIndex) || candidate.sdpMLineIndex < 0 || candidate.sdpMLineIndex > 65_535)
  ) return false;
  if (!optionalBoundedString(candidate.usernameFragment, MAX_SMALL_FIELD_CHARS)) return false;
  return true;
}

export function parseClientSignalingMessage(raw) {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > MAX_SIGNALING_MESSAGE_CHARS) return null;

  let payload;
  try {
    payload = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;
  if (!positiveSafeInteger(payload.attemptId)) return null;

  if (payload.type === 'attempt-ready') return payload;
  if (payload.type === 'description') return validDescription(payload.description) ? payload : null;
  if (payload.type === 'candidate') return validCandidate(payload.candidate) ? payload : null;
  return null;
}
