import { mkdtemp, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { SUPPORTED_GEMINI_VERSION } from '../plugins/gemini/scripts/lib/runtime.mjs';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const scratch = await mkdtemp(join(tmpdir(), 'gemini-upstream-verification-'));
try {
  const packed = JSON.parse(
    execFileSync(
      'npm',
      [
        'pack',
        `@google/gemini-cli@${SUPPORTED_GEMINI_VERSION}`,
        '--ignore-scripts',
        '--json',
        '--pack-destination',
        scratch,
      ],
      { encoding: 'utf8', timeout: 120000, stdio: ['ignore', 'pipe', 'inherit'] },
    ),
  );
  const name = packed[0]?.filename;
  if (typeof name !== 'string' || name.includes('/') || name.includes('..'))
    throw new Error('Unexpected npm pack artifact');
  execFileSync('tar', ['-xzf', join(scratch, name), '-C', scratch], { timeout: 30000 });
  // This path is part of the exact version contract; unexpected packaging fails closed.
  const bundle = join(scratch, 'package', 'bundle', 'chunk-2V7FO5QV.js');
  await access(bundle);
  console.log(
    `Checking upstream Gemini CLI ${SUPPORTED_GEMINI_VERSION}; npm integrity ${packed[0].integrity}`,
  );
  execFileSync(process.execPath, ['--test', 'tests/runtime.test.mjs'], {
    cwd: root,
    env: { ...process.env, GEMINI_TEST_BUNDLE: bundle },
    stdio: 'inherit',
    timeout: 120000,
  });
} finally {
  await rm(scratch, { recursive: true, force: true });
}
