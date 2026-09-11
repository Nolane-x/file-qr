import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const defaultRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function normalizeThumbprint(value) {
  const thumbprint = String(value ?? '').replace(/\s+/g, '').toUpperCase();
  if (!/^[A-F0-9]{40}$/.test(thumbprint)) {
    throw new Error('Windows certificate thumbprint is missing or invalid');
  }
  return thumbprint;
}

function normalizeTimestampUrl(value) {
  const timestampUrl = String(value ?? '').trim();
  let url;
  try {
    url = new URL(timestampUrl);
  } catch {
    throw new Error('Windows timestamp URL must be a valid HTTP(S) URL');
  }
  if (!['http:', 'https:'].includes(url.protocol)) {
    throw new Error('Windows timestamp URL must be a valid HTTP(S) URL');
  }
  return timestampUrl;
}

export function applyWindowsSigningConfig(
  input,
  { certificateThumbprint, timestampUrl } = {},
) {
  const config = structuredClone(input ?? {});
  config.bundle ??= {};
  config.bundle.windows ??= {};
  config.bundle.windows.certificateThumbprint = normalizeThumbprint(certificateThumbprint);
  config.bundle.windows.digestAlgorithm = 'sha256';
  config.bundle.windows.timestampUrl = normalizeTimestampUrl(timestampUrl);
  return config;
}

export function configureWindowsSigningFile({ root = defaultRoot, env = process.env } = {}) {
  const configPath = path.join(root, 'apps', 'native', 'src-tauri', 'tauri.conf.json');
  const certificateThumbprint = String(env.FILE_QR_WINDOWS_CERT_THUMBPRINT || '');
  const timestampUrl = String(
    env.FILE_QR_WINDOWS_TIMESTAMP_URL || 'http://timestamp.comodoca.com',
  ).trim();

  const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  const signedConfig = applyWindowsSigningConfig(config, {
    certificateThumbprint,
    timestampUrl,
  });
  fs.writeFileSync(configPath, `${JSON.stringify(signedConfig, null, 2)}\n`);
  console.log('Windows signing configuration ready.');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  configureWindowsSigningFile();
}
