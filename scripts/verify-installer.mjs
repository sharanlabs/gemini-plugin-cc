import assert from 'node:assert/strict';
import { access, mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, delimiter, join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { buildArtifacts } from './pack.mjs';

// Deliberately separate from npm test: this downloads pinned public dependencies,
// uses real Claude plugin management in an isolated config, and never signs in.
const scratch = await mkdtemp(join(tmpdir(), 'gemini-installer-verification-'));
try {
  const artifacts = await buildArtifacts({ output: join(scratch, 'artifacts') });
  const sums = await readFile(join(scratch, 'artifacts', 'SHA256SUMS.txt'), 'utf8');
  for (const artifact of artifacts) {
    const digest = createHash('sha256').update(await readFile(artifact)).digest('hex');
    assert.ok(sums.includes(digest));
  }
  const archive = artifacts.find(file => file.includes(process.platform === 'win32' ? '-windows-' : '-macos-'));
  const extracted = join(scratch, 'download with spaces');
  await mkdir(extracted);
  execFileSync('tar', ['-xf', archive, '-C', extracted]);
  const { version } = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  const source = join(extracted, `gemini-companion-v${version}`);
  const { install, discoverTools } = await import(pathToFileURL(join(source, 'installer', 'install.mjs')).href);
  const base = join(scratch, 'installed with spaces');
  const env = { ...process.env, CLAUDE_CONFIG_DIR: join(scratch, 'claude-config'), CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1' };
  const tools = await discoverTools({ env });
  for (let attempt = 0; attempt < 2; attempt++) {
    const result = await install({ source, base, tools, env });
    assert.equal(result.status, 'installed');
  }
  const receipt = JSON.parse(await readFile(join(base, 'install.json'), 'utf8'));
  assert.equal(receipt.installedVersion, version);
  assert.equal(execFileSync(process.execPath, [receipt.geminiEntry, '--version'], { env, encoding: 'utf8' }).trim(), '0.63.0');
  const launch = execFileSync(process.execPath, [join(base, 'launch.mjs'), '--version'], { env, encoding: 'utf8' });
  assert.match(launch, /Claude Code/);
  const installed = JSON.parse(execFileSync(tools.claude, ['plugin', 'list', '--json'], { env, encoding: 'utf8' }));
  assert.ok(installed.some(plugin => plugin.id === 'gemini@gemini-companion' && plugin.version === version && plugin.enabled));
  // Exercise the actual platform bootstrap with Node absent from PATH.
  const bootstrapHome = join(scratch, 'fresh bootstrap user');
  await mkdir(bootstrapHome);
  const bootstrapEnv = { ...env, CI: 'true', CLAUDE_CONFIG_DIR: join(scratch, 'bootstrap-claude-config') };
  for (const key of Object.keys(bootstrapEnv)) if (key.toUpperCase() === 'PATH') delete bootstrapEnv[key];
  const systemRoot = process.env.SystemRoot || process.env.SYSTEMROOT || 'C:\\Windows';
  bootstrapEnv.PATH = [dirname(tools.git), dirname(tools.claude), ...(process.platform === 'win32'
    ? [join(systemRoot, 'System32'), join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0')]
    : ['/usr/bin', '/bin', '/usr/sbin', '/sbin'])].join(delimiter);
  if (process.platform === 'win32') {
    bootstrapEnv.LOCALAPPDATA = bootstrapHome;
    bootstrapEnv.CLAUDE_CODE_GIT_BASH_PATH = tools.gitBash;
    execFileSync(join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
      ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', join(source, 'installer', 'bootstrap.ps1')],
      { env: bootstrapEnv, stdio: 'inherit', timeout: 300000 });
    await access(join(bootstrapHome, 'gemini-plugin-cc', 'runtimes', 'node-v24.22.0-win-x64', 'node.exe'));
  } else {
    bootstrapEnv.HOME = bootstrapHome;
    execFileSync('/bin/sh', [join(source, 'installer', 'bootstrap.sh')], { env: bootstrapEnv, stdio: 'inherit', timeout: 300000 });
  }
  console.log(`PASS: ${process.platform} released ZIP extraction, checksum, real private Gemini startup, Claude registration, enabled version, launch shortcut, and installer rerun. Google sign-in intentionally not performed.`);
} finally {
  await rm(scratch, { recursive: true, force: true });
}
