const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

export function encodeFileEnvelope(meta, input) {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  const header = textEncoder.encode(JSON.stringify({
    name: String(meta?.name || 'file.bin'),
    type: String(meta?.type || 'application/octet-stream'),
    size: bytes.byteLength,
  }));
  if (header.byteLength > 1024 * 1024) throw new Error('File metadata is too large');
  const out = new Uint8Array(4 + header.byteLength + bytes.byteLength);
  new DataView(out.buffer).setUint32(0, header.byteLength, false);
  out.set(header, 4);
  out.set(bytes, 4 + header.byteLength);
  return out;
}

export function decodeFileEnvelope(input) {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  if (bytes.byteLength < 4) throw new Error('File envelope is truncated');
  const headerLength = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(0, false);
  if (headerLength < 2 || headerLength > 1024 * 1024 || 4 + headerLength > bytes.byteLength) throw new Error('File envelope header is invalid');
  let meta;
  try { meta = JSON.parse(textDecoder.decode(bytes.subarray(4, 4 + headerLength))); }
  catch { throw new Error('File envelope metadata is invalid'); }
  const payload = bytes.slice(4 + headerLength);
  if (!Number.isInteger(meta?.size) || meta.size !== payload.byteLength) throw new Error('File envelope size does not match payload');
  return {
    name: String(meta.name || 'file.bin'),
    type: String(meta.type || 'application/octet-stream'),
    size: meta.size,
    bytes: payload,
  };
}
