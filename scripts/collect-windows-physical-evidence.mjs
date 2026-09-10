import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const WINDOWS_FACT_SCRIPT = `$cams = @(Get-PnpDevice -Class Camera -ErrorAction Stop | Where-Object Status -eq 'OK')
[pscustomobject]@{ osVersion=[Environment]::OSVersion.Version.ToString(); cameraDeviceCount=$cams.Count } | ConvertTo-Json -Compress`;

function fail(code, message) {
  const error = new Error(`${code}: ${message}`);
  error.code = code;
  throw error;
}

function defaultExecPowerShell(script) {
  const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(String(result.stderr || result.stdout || `exit ${result.status}`).trim());
  }
  return String(result.stdout || '').trim();
}

function parsePowerShellFacts(output) {
  let value;
  try {
    value = JSON.parse(String(output));
  } catch {
    fail('FQR_WINDOWS_OUTPUT', 'PowerShell output must be valid JSON');
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    fail('FQR_WINDOWS_OUTPUT', 'PowerShell output must be an object');
  }
  const actualKeys = Object.keys(value).sort();
  const expectedKeys = ['cameraDeviceCount', 'osVersion'];
  if (JSON.stringify(actualKeys) !== JSON.stringify(expectedKeys)) {
    fail('FQR_WINDOWS_OUTPUT', 'PowerShell output keys are invalid');
  }
  if (typeof value.osVersion !== 'string' || value.osVersion.trim().length === 0) {
    fail('FQR_WINDOWS_OUTPUT', 'osVersion must be a non-empty string');
  }
  if (!Number.isSafeInteger(value.cameraDeviceCount) || value.cameraDeviceCount < 0) {
    fail('FQR_WINDOWS_OUTPUT', 'cameraDeviceCount must be a non-negative integer');
  }
  return {
    osVersion: value.osVersion.trim(),
    cameraDeviceCount: value.cameraDeviceCount,
  };
}

export function collectWindowsDeviceFacts({
  execPowerShell = defaultExecPowerShell,
  platform = process.platform,
  arch = process.arch,
} = {}) {
  if (platform !== 'win32') {
    fail('FQR_WINDOWS_PLATFORM', 'Windows physical facts require a Windows host');
  }
  if (typeof arch !== 'string' || arch.length === 0) {
    fail('FQR_WINDOWS_PLATFORM', 'architecture must be a non-empty string');
  }

  let output;
  try {
    output = execPowerShell(WINDOWS_FACT_SCRIPT);
  } catch (error) {
    if (error?.code?.startsWith?.('FQR_WINDOWS_')) throw error;
    fail('FQR_WINDOWS_COMMAND', error?.message || 'PowerShell command failed');
  }

  const parsed = parsePowerShellFacts(output);
  return {
    platform: 'windows',
    osClass: `Windows ${parsed.osVersion}`,
    architecture: arch,
    cameraDevicePresent: parsed.cameraDeviceCount > 0,
    cameraDeviceCount: parsed.cameraDeviceCount,
  };
}

function atomicWriteJson(outputPath, value) {
  if (typeof outputPath !== 'string' || outputPath.length === 0) {
    fail('FQR_WINDOWS_OUTPUT_PATH', 'output path must be a non-empty string');
  }
  const tmp = `${outputPath}.tmp`;
  fs.mkdirSync(path.dirname(outputPath), { recursive: true, mode: 0o700 });
  let fd;
  try {
    try { fs.rmSync(tmp, { force: true }); } catch {}
    fd = fs.openSync(tmp, 'wx', 0o600);
    fs.writeFileSync(fd, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    fs.renameSync(tmp, outputPath);
  } catch (error) {
    if (fd !== undefined) {
      try { fs.closeSync(fd); } catch {}
    }
    try { fs.rmSync(tmp, { force: true }); } catch {}
    fail('FQR_WINDOWS_OUTPUT_PATH', error?.message || 'could not publish Windows facts');
  }
}

export function writeWindowsDeviceFacts({ outputPath, ...options } = {}) {
  const facts = collectWindowsDeviceFacts(options);
  atomicWriteJson(outputPath, facts);
  return facts;
}

function parseArgs(argv) {
  if (argv.length !== 2 || argv[0] !== '--output' || !argv[1]) {
    fail('FQR_WINDOWS_CLI', 'usage: node scripts/collect-windows-physical-evidence.mjs --output <facts.json>');
  }
  return { outputPath: argv[1] };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const facts = writeWindowsDeviceFacts(parseArgs(process.argv.slice(2)));
    console.log(`Windows physical facts: ${facts.cameraDeviceCount} camera device(s)`);
  } catch (error) {
    console.error(error?.message || String(error));
    process.exitCode = 1;
  }
}
