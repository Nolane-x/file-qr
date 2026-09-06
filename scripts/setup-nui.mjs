import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

if (existsSync('.nui')) {
  console.log('Nolane UI Intelligence sidecar already exists at .nui');
  process.exit(0);
}
const result = spawnSync('git', ['clone', '--depth', '1', 'https://github.com/Nolane-x/Nolane-UI-Intelligence.git', '.nui'], { stdio: 'inherit' });
if (result.status !== 0) process.exit(result.status ?? 1);
console.log('NUI sidecar ready. Run: python .nui/scripts/nui-agent-export --agent generic-cli --root .nui');
