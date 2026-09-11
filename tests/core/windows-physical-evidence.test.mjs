import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  collectWindowsDeviceFacts,
  writeWindowsDeviceFacts,
} from '../../scripts/collect-windows-physical-evidence.mjs';

function powershellJson(cameraDeviceCount = 2) {
  return JSON.stringify({ osVersion: '10.0.22631.0', cameraDeviceCount });
}

test('Windows facts return only sanitized OS, architecture and camera count', () => {
  const calls = [];
  const facts = collectWindowsDeviceFacts({
    platform: 'win32',
    arch: 'x64',
    execPowerShell: (script) => {
      calls.push(script);
      return powershellJson(2);
    },
  });

  assert.deepEqual(facts, {
    platform: 'windows',
    osClass: 'Windows 10.0.22631.0',
    architecture: 'x64',
    cameraDevicePresent: true,
    cameraDeviceCount: 2,
  });
  assert.equal(calls.length, 1);
  assert.match(calls[0], /Get-PnpDevice\s+-Class\s+Camera/);
  assert.doesNotMatch(JSON.stringify(facts), /camera-name|hardware-id/i);
});

test('Windows facts represent zero healthy cameras without inventing presence', () => {
  const facts = collectWindowsDeviceFacts({
    platform: 'win32',
    arch: 'arm64',
    execPowerShell: () => powershellJson(0),
  });
  assert.equal(facts.cameraDevicePresent, false);
  assert.equal(facts.cameraDeviceCount, 0);
  assert.equal(facts.architecture, 'arm64');
});

test('Windows facts fail closed on host, command and JSON/count errors', () => {
  assert.throws(
    () => collectWindowsDeviceFacts({ platform: 'linux', arch: 'x64', execPowerShell: () => powershellJson(1) }),
    /FQR_WINDOWS_PLATFORM/,
  );
  assert.throws(
    () => collectWindowsDeviceFacts({ platform: 'win32', arch: 'x64', execPowerShell: () => { throw new Error('boom'); } }),
    /FQR_WINDOWS_COMMAND/,
  );
  for (const output of [
    '{bad',
    JSON.stringify({ osVersion: '10.0', cameraDeviceCount: -1 }),
    JSON.stringify({ osVersion: '10.0', cameraDeviceCount: 1.5 }),
    JSON.stringify({ osVersion: '10.0', cameraDeviceCount: 1, extra: 'camera-name' }),
    JSON.stringify({ osVersion: '', cameraDeviceCount: 1 }),
  ]) {
    assert.throws(
      () => collectWindowsDeviceFacts({ platform: 'win32', arch: 'x64', execPowerShell: () => output }),
      /FQR_WINDOWS_/,
    );
  }
});

test('Windows fact writer publishes sanitized JSON with private file mode', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fileqr-windows-facts-'));
  const outputPath = path.join(dir, 'windows-facts.json');
  const facts = writeWindowsDeviceFacts({
    outputPath,
    platform: 'win32',
    arch: 'x64',
    execPowerShell: () => powershellJson(1),
  });
  assert.deepEqual(JSON.parse(fs.readFileSync(outputPath, 'utf8')), facts);
  assert.equal(fs.statSync(outputPath).mode & 0o777, 0o600);
});
