import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, readFile, symlink, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import {
  assertWindowsLocalPath,
  resolveGeminiLaunch,
  protectPrivateDirectory,
  verifyPrivateDirectory,
  terminateProcessTree,
  systemConfigurationDirectory,
} from '../plugins/gemini/scripts/lib/platform.mjs';
const exec = promisify(execFile);

test('Windows paths reject alternate namespaces, ADS and filesystem aliases', () => {
  for (const value of [
    'C:relative', '\\relative', '\\\\server\\share\\file', '\\\\?\\C:\\task',
    'C:\\task\\file:stream', 'C:\\task\\NUL', 'C:\\task\\LPT1.txt',
    'C:\\task\\file.', 'C:\\task\\file ', 'C:\\task\\..\\outside', 'C:\\task\\line\n',
  ]) assert.throws(() => assertWindowsLocalPath(value), /Windows path/);
  assert.equal(assertWindowsLocalPath('C:\\Users\\Example Person\\task'), 'C:\\Users\\Example Person\\task');
});

test('Windows system configuration matches the pinned upstream storage path', () => {
  assert.equal(systemConfigurationDirectory('win32'), 'C:\\ProgramData\\gemini-cli');
  assert.equal(systemConfigurationDirectory('darwin'), '/Library/Application Support/GeminiCli');
  assert.equal(systemConfigurationDirectory('linux'), '/etc/gemini-cli');
});

test('JavaScript Gemini launchers run through Node without a command shell', async () => {
  const entry = fileURLToPath(new URL('./fixtures/fake-gemini.mjs', import.meta.url));
  const launch = await resolveGeminiLaunch(entry);
  assert.equal(launch.command, process.execPath);
  assert.deepEqual(launch.argsPrefix, [entry]);
});

test('npm command shim resolves its verified package entry without interpreting shim contents', async () => {
  const root = await mkdtemp(join(tmpdir(), 'gemini-windows-launch-'));
  try {
    const packageRoot = join(root, 'node_modules', '@google', 'gemini-cli');
    const entry = join(packageRoot, 'bundle', 'gemini.js');
    await mkdir(dirname(entry), { recursive: true });
    await writeFile(join(packageRoot, 'package.json'), JSON.stringify({ name: '@google/gemini-cli', bin: { gemini: 'bundle/gemini.js' } }));
    await writeFile(entry, '// fixture');
    await writeFile(join(root, 'gemini.cmd'), '@echo SHOULD_NEVER_EXECUTE');
    const launch = await resolveGeminiLaunch(join(root, 'gemini.cmd'));
    assert.equal(launch.command, process.execPath);
    assert.deepEqual(launch.argsPrefix, [await realpath(entry)]);
    await writeFile(join(packageRoot, 'package.json'), JSON.stringify({ name: 'wrong-package', bin: { gemini: 'bundle/gemini.js' } }));
    await assert.rejects(resolveGeminiLaunch(join(root, 'gemini.cmd')), /Gemini/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('managed installation receipt resolves only the official package entry', async () => {
  const root = await mkdtemp(join(tmpdir(), 'gemini-managed-launch-'));
  try {
    const packageRoot = join(root, 'runtime', 'node_modules', '@google', 'gemini-cli');
    const entry = join(packageRoot, 'bundle', 'gemini.js');
    await mkdir(dirname(entry), { recursive: true });
    await writeFile(join(packageRoot, 'package.json'), JSON.stringify({ name: '@google/gemini-cli', bin: { gemini: 'bundle/gemini.js' } }));
    await writeFile(entry, '// fixture');
    const receipt = process.platform === 'win32'
      ? join(root, 'localappdata', 'gemini-plugin-cc', 'install.json')
      : join(root, '.local', 'share', 'gemini-plugin-cc', 'install.json');
    await mkdir(dirname(receipt), { recursive: true });
    await writeFile(receipt, JSON.stringify({ schema: 1, geminiEntry: entry, nodePath: '/must-not-execute' }));
    const helper = new URL('../plugins/gemini/scripts/lib/platform.mjs', import.meta.url).href;
    const script = join(root, 'probe.mjs');
    await writeFile(script, `import { resolveGeminiLaunch } from ${JSON.stringify(helper)}; console.log(JSON.stringify(await resolveGeminiLaunch()));`);
    const env = { ...process.env, HOME: root, USERPROFILE: root, LOCALAPPDATA: join(root, 'localappdata') };
    const result = JSON.parse((await exec(process.execPath, [script], { env })).stdout);
    assert.equal(result.command, process.execPath);
    assert.deepEqual(result.argsPrefix, [await realpath(entry)]);
    await writeFile(receipt, JSON.stringify({ schema: 1, geminiEntry: join(root, 'untrusted.mjs') }));
    await assert.rejects(exec(process.execPath, [script], { env }));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('private directory protection refuses links and verifies native permissions', async () => {
  const root = await mkdtemp(join(tmpdir(), 'gemini-private-platform-'));
  try {
    const target = join(root, 'private');
    await mkdir(target);
    await protectPrivateDirectory(target);
    await verifyPrivateDirectory(target);
    await symlink(target, join(root, 'link'), process.platform === 'win32' ? 'junction' : 'dir');
    await assert.rejects(protectPrivateDirectory(join(root, 'link')), { code: 'PLATFORM_BOUNDARY_FAILED' });
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('Windows directory verification rejects widened inherited access', { skip: process.platform !== 'win32' }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'gemini-private-acl-'));
  try {
    const target = join(root, "literal $(ignored) 'directory'");
    await mkdir(target);
    await protectPrivateDirectory(target);
    await verifyPrivateDirectory(target);
    const script = String.raw`
      $ErrorActionPreference = 'Stop'
      $acl = [System.IO.Directory]::GetAccessControl($env:GEMINI_PLUGIN_ACL_TEST_PATH)
      $everyone = New-Object System.Security.Principal.SecurityIdentifier('S-1-1-0')
      $rule = New-Object System.Security.AccessControl.FileSystemAccessRule($everyone, [System.Security.AccessControl.FileSystemRights]::Read, [System.Security.AccessControl.AccessControlType]::Allow)
      $acl.AddAccessRule($rule)
      [System.IO.Directory]::SetAccessControl($env:GEMINI_PLUGIN_ACL_TEST_PATH, $acl)
    `;
    const powershell = join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    await exec(powershell, ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')],
      { env: { ...process.env, GEMINI_PLUGIN_ACL_TEST_PATH: target } });
    await assert.rejects(verifyPrivateDirectory(target), { code: 'PLATFORM_BOUNDARY_FAILED' });
    await protectPrivateDirectory(target);
    await verifyPrivateDirectory(target);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('owned process tree termination kills a live descendant', async () => {
  const root = await mkdtemp(join(tmpdir(), 'gemini-tree-platform-'));
  const childFile = join(root, 'descendant.pid');
  const child = spawn(process.execPath, ['-e', `
    const {spawn}=require('node:child_process');
    const fs=require('node:fs');
    const descendant=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});
    fs.writeFileSync(${JSON.stringify(childFile)},String(descendant.pid));
    setInterval(()=>{},1000);
  `], { detached: process.platform !== 'win32', stdio: 'ignore' });
  try {
    let descendant;
    for (let i = 0; i < 100; i++) {
      try { descendant = Number(await readFile(childFile, 'utf8')); break; }
      catch (e) { if (e.code !== 'ENOENT') throw e; }
      await new Promise((accept) => setTimeout(accept, 25));
    }
    assert.ok(Number.isSafeInteger(descendant));
    await terminateProcessTree(child, 'SIGKILL');
    for (let i = 0; i < 100; i++) {
      try { process.kill(descendant, 0); }
      catch (e) { assert.equal(e.code, 'ESRCH'); return; }
      await new Promise((accept) => setTimeout(accept, 25));
    }
    assert.fail('Descendant remained alive');
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await rm(root, { recursive: true, force: true });
  }
});

test('macOS cancellation reaps a zombie group before treating EPERM as a permission failure',
  { skip: process.platform !== 'darwin' }, async () => {
    const child = spawn('/usr/bin/true', [], { detached: true, stdio: 'ignore' });
    // Keep the parent's event loop from reaping its already-exited child. This
    // deterministically reproduces the CI race between a CLI probe and abort.
    let state;
    const deadline = Date.now() + 3000;
    do {
      state = execFileSync('/bin/ps', ['-o', 'stat=', '-p', String(child.pid)], { encoding: 'utf8' }).trim();
      if (state.startsWith('Z')) break;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
    } while (Date.now() < deadline);
    assert.match(state, /^Z/, 'the owned child reached the unreaped zombie state');
    assert.equal(child.exitCode, null);
    assert.throws(() => process.kill(-child.pid, 'SIGTERM'), { code: 'EPERM' });
    await terminateProcessTree(child, 'SIGTERM');
    assert.notEqual(child.exitCode, null);
    assert.throws(() => process.kill(-child.pid, 0), { code: 'ESRCH' });
  });

test('macOS cancellation still rejects a live group permission failure',
  { skip: process.platform !== 'darwin' }, async () => {
    const child = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { detached: true, stdio: 'ignore' });
    const originalKill = process.kill;
    try {
      process.kill = (pid, signal) => {
        if (pid === -child.pid) throw Object.assign(new Error('synthetic permission failure'), { code: 'EPERM' });
        return originalKill(pid, signal);
      };
      await assert.rejects(terminateProcessTree(child, 'SIGTERM'), { code: 'EPERM' });
      assert.equal(child.exitCode, null);
      assert.equal(child.signalCode, null);
    } finally {
      process.kill = originalKill;
      await terminateProcessTree(child, 'SIGKILL');
    }
  });
