import fs from 'node:fs';

const RUNTIME_FILES = [
  '../../apps/web/src/main.js',
  '../../apps/web/src/runtime-core.js',
  '../../apps/web/src/runtime-transfer.js',
  '../../apps/web/src/runtime-relay.js',
  '../../apps/web/src/runtime-direct.js',
  '../../apps/web/src/runtime-session.js',
  '../../apps/web/src/runtime-ui.js',
];

export function readWebRuntimeSource() {
  return RUNTIME_FILES
    .map((path) => fs.readFileSync(new URL(path, import.meta.url), 'utf8'))
    .join('\n');
}
