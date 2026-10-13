import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
execFileSync(
  process.platform === 'win32' ? 'npm.cmd' : 'npm',
  ['pack', '--pack-destination', resolve(root, '..')],
  { cwd: root, stdio: 'inherit' },
);
