import test from 'node:test';
import { execFileSync } from 'node:child_process';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, mkdir, writeFile, access, rm, symlink, cp, chmod, unlink, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

const moduleUrl = new URL('../installer/install.mjs', import.meta.url);
test('download installer provides a side-effect-free plan and blocks missing prerequisites', async () => {
  let module;
  try { module = await import(moduleUrl); } catch {}
  assert.ok(module?.install, 'shared installer must expose install');
  const root = await mkdtemp(join(tmpdir(), 'companion-install-plan-'));
  try {
    const base = join(root, 'not created');
    const output = await module.install({ source: resolve('.'), base, tools: {}, dryRun: true });
    assert.equal(output.status, 'prerequisites');
    assert.ok(output.missing.includes('git'));
    await assert.rejects(access(base));
  } finally { await rm(root, { recursive: true, force: true }); }
});

async function fixture(t) {
  const module = await import(moduleUrl);
  const temporary = await mkdtemp(join(tmpdir(), 'gemini installer spaces-'));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const source = join(temporary, 'download');
  await mkdir(join(source, '.claude-plugin'), { recursive: true });
  await mkdir(join(source, 'plugins', 'gemini'), { recursive: true });
  await writeFile(join(source, 'package.json'), JSON.stringify({ version: '0.2.0' }));
  await writeFile(join(source, '.claude-plugin', 'marketplace.json'), '{}');
  await writeFile(join(source, 'plugins', 'gemini', 'plugin.txt'), 'release payload');
  const base = join(temporary, 'private install');
  const tools = { node: process.execPath, npm: join(temporary, 'npm-cli.js'), git: join(temporary, 'git'), claude: join(temporary, 'claude'), ...(process.platform === 'win32' ? { gitBash: join(temporary, 'bash.exe') } : {}) };
  const calls = [];
  const execute = async (command, args, options) => {
    calls.push({ command, args, options });
    if (command === tools.git && args.join(' ') === '--version') return 'git version 2.50.0';
    if (args.join(' ') === '--version') return '2.1.296 (Claude Code)';
    if (args[1] === 'list') return JSON.stringify([{ id: 'gemini@gemini-companion', scope: 'user', version: '0.2.0', enabled: true }]);
    if (args.includes('list')) return '[]';
    if (args.includes('install') && args.includes('--prefix')) {
      const packagePath = join(args[args.indexOf('--prefix') + 1], 'node_modules', '@google', 'gemini-cli');
      await mkdir(join(packagePath, 'bundle'), { recursive: true });
      await writeFile(join(packagePath, 'package.json'), JSON.stringify({ name: '@google/gemini-cli', version: '0.63.0', bin: { gemini: 'bundle/gemini.js' } }));
      await writeFile(join(packagePath, 'bundle', 'gemini.js'), '');
    }
    if (args.at(-1) === '--version') return '0.63.0';
    return '';
  };
  return { module, source, base, tools, calls, execute, log: () => {} };
}
test('dry-run performs readonly discovery without installing or creating files', async t => {
  const f = await fixture(t);
  const result = await f.module.install({ ...f, dryRun: true });
  assert.equal(result.status, 'planned');
  assert.deepEqual(f.calls.map(c => c.args), [['--version'], ['plugin', 'marketplace', 'list', '--json']]);
  await assert.rejects(access(f.base));
});
test('installer keeps paths as argv, pins Gemini privately and reruns without reinstalling runtime', async t => {
  const f = await fixture(t);
  assert.equal((await f.module.install(f)).status, 'installed');
  const receipt = JSON.parse(await readFile(join(f.base, 'install.json'), 'utf8'));
  assert.equal(receipt.schema, 1);
  assert.equal(receipt.installedVersion, '0.2.0');
  assert.ok(receipt.geminiEntry.startsWith(f.base));
  const npm = f.calls.find(c => c.args.includes('--prefix'));
  assert.equal(npm.command, process.execPath);
  assert.ok(npm.args.includes('@google/gemini-cli@0.63.0'));
  assert.ok(npm.args.includes('--ignore-scripts'));
  assert.ok(!npm.args.includes('--global'));
  assert.ok(f.calls.some(c => c.args.includes(join(f.base, 'marketplace'))));
  const callsBefore = f.calls.length;
  await f.module.install(f);
  assert.equal(f.calls.slice(callsBefore).some(c => c.args.includes('--prefix')), false);
});
test('registration failure restores prior receipt and owned payload', async t => {
  const f = await fixture(t);
  await f.module.install(f);
  await writeFile(join(f.base, 'marketplace', 'keep.txt'), 'previous release');
  const before = await readFile(join(f.base, 'install.json'), 'utf8');
  const execute = async (...args) => {
    if (args[1][0] === 'plugin' && args[1][1] === 'install') throw new Error('synthetic registration failure');
    return f.execute(...args);
  };
  await assert.rejects(f.module.install({ ...f, execute }), /synthetic registration failure/);
  assert.equal(await readFile(join(f.base, 'marketplace', 'keep.txt'), 'utf8'), 'previous release');
  assert.equal(await readFile(join(f.base, 'install.json'), 'utf8'), before);
});
test('sign-in uses inherited terminal without logging credentials and a cancelled login keeps installation', async t => {
  const f = await fixture(t);
  const messages = [];
  const execute = async (...args) => {
    if (args[2]?.interactive) throw new Error('synthetic login cancellation');
    return f.execute(...args);
  };
  await assert.rejects(f.module.install({ ...f, execute, signIn: true, log: message => messages.push(message) }), /login cancellation/);
  await access(join(f.base, 'install.json'));
  assert.ok(messages.every(message => !message.includes('token')));
});
test('installer rejects foreign marketplace before filesystem mutation', async t => {
  const f = await fixture(t);
  const execute = async (...args) => args[1].includes('list') ? JSON.stringify([{ name: 'gemini-companion', source: 'github', repo: 'someone/else' }]) : f.execute(...args);
  await assert.rejects(f.module.install({ ...f, execute }), /different gemini-companion marketplace/);
  await assert.rejects(access(f.base));
});
test('installer refuses symbolic-link state ancestry', { skip: process.platform === 'win32' }, async t => {
  const f = await fixture(t);
  const link = join(dirname(f.base), 'redirect');
  await symlink(dirname(f.base), link);
  await assert.rejects(f.module.install({ ...f, base: join(link, 'elsewhere') }), /symlink|symbolic-link/);
});

test('download archives include launchers and license without repository state', async t => {
  const f = await fixture(t);
  const pack = await import('../scripts/pack.mjs');
  assert.equal(typeof pack.buildArtifacts, 'function', 'packaging exposes downloadable artifacts');
  await writeFile(join(f.source, 'LICENSE'), 'Apache-2.0');
  await mkdir(join(f.source, '.github', 'workflows'), { recursive: true });
  await writeFile(join(f.source, '.github', 'workflows', 'ci.yml'), 'name: CI\n');
  await mkdir(join(f.source, 'installer'), { recursive: true });
  await writeFile(join(f.source, 'installer', 'Install.command'), '#!/bin/sh\n');
  await writeFile(join(f.source, 'installer', 'Install.cmd'), '@echo off\r\n');
  execFileSync('git', ['init', '-q', f.source]);
  execFileSync('git', ['-C', f.source, 'add', '.']);
  execFileSync('git', ['-C', f.source, '-c', 'user.name=Installer test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'Synthetic release']);
  await writeFile(join(f.source, '.git', 'do-not-package'), 'private');
  await writeFile(join(f.source, '.env'), 'do not include');
  const out = join(dirname(f.base), 'artifacts');
  const artifacts = await pack.buildArtifacts({ root: f.source, output: out });
  assert.equal(artifacts.length, 2);
  const content = await readFile(artifacts[0]);
  assert.ok(content.includes(Buffer.from('gemini-companion-v0.2.0/Install.command')));
  assert.ok(content.includes(Buffer.from('/LICENSE')));
  assert.ok(content.includes(Buffer.from('/.github/workflows/ci.yml')), 'source downloads include files required by the test suite');
  assert.ok(content.includes(Buffer.from('@echo off\r\n')), 'Windows launchers retain CRLF in the ZIP');
  assert.ok(!content.includes(Buffer.from('do-not-package')));
  assert.ok(!content.includes(Buffer.from('/.env')));
  const checksums = await readFile(join(out, 'SHA256SUMS.txt'), 'utf8');
  assert.match(checksums, /^[a-f0-9]{64}  gemini-companion-macos-v0.2.0.zip\n[a-f0-9]{64}  gemini-companion-windows-v0.2.0.zip\n$/);
});

test('bootstrap hashes match the reviewed pinned release manifest for every CPU', async () => {
  const root = resolve('.');
  const manifest = JSON.parse(await readFile(join(root, 'installer', 'node-releases.json'), 'utf8'));
  const shell = await readFile(join(root, 'installer', 'bootstrap.sh'), 'utf8');
  const powershell = await readFile(join(root, 'installer', 'bootstrap.ps1'), 'utf8');
  assert.equal(manifest.version, '24.22.0');
  for (const [platform, archive] of Object.entries(manifest.archives)) {
    assert.match(archive.sha256, /^[a-f0-9]{64}$/);
    assert.ok((platform.startsWith('win') ? powershell : shell).includes(archive.sha256));
    assert.ok(archive.filename.includes(manifest.version));
  }
  assert.ok(shell.includes('https://nodejs.org/download/release/v24.22.0/'));
  assert.ok(powershell.includes('https://nodejs.org/download/release/v24.22.0/'));
});
test('installer refuses an unowned pre-existing payload directory', async t => {
  const f = await fixture(t);
  await mkdir(join(f.base, 'marketplace'), { recursive: true });
  await writeFile(join(f.base, 'marketplace', 'user.txt'), 'preserve');
  await assert.rejects(f.module.install(f), /not owned/);
  assert.equal(await readFile(join(f.base, 'marketplace', 'user.txt'), 'utf8'), 'preserve');
});
test('installer refuses stale installed plugin versions and leaves no successful receipt', async t => {
  const f = await fixture(t);
  const execute = async (...args) => args[1][0] === 'plugin' && args[1][1] === 'list' ? JSON.stringify([{ id: 'gemini@gemini-companion', scope: 'user', version: '0.1.1' }]) : f.execute(...args);
  await assert.rejects(f.module.install({ ...f, execute }), /Claude installed version 0.1.1/);
  await assert.rejects(access(join(f.base, 'install.json')));
});

test('Windows setup requires Git Bash and preserves its explicit launcher path', async t => {
  const f = await fixture(t);
  const missing = await f.module.install({ ...f, tools: { ...f.tools, gitBash: undefined }, platform: 'win32', dryRun: true });
  assert.equal(missing.status, 'prerequisites');
  assert.ok(missing.missing.includes('git'));
  const tools = { ...f.tools, gitBash: join(dirname(f.base), 'Git for Windows', 'bin', 'bash.exe') };
  await f.module.install({ ...f, tools, platform: 'win32', env: { Path: 'original Windows PATH' } });
  const receipt = JSON.parse(await readFile(join(f.base, 'install.json'), 'utf8'));
  assert.equal(receipt.gitBashPath, tools.gitBash);
  assert.ok(f.calls.filter(c => c.options?.env).every(c => !('Path' in c.options.env)));
  assert.ok(f.calls.some(c => c.options?.env.CLAUDE_CODE_GIT_BASH_PATH === tools.gitBash));
  await access(join(f.base, 'Launch Claude.cmd'));
});

test('release packaging ignores untracked secrets and refuses tracked secret-like paths and dirty source', async t => {
  const f = await fixture(t);
  const { buildArtifacts } = await import('../scripts/pack.mjs');
  await mkdir(join(f.source, 'installer'), { recursive: true });
  await writeFile(join(f.source, 'installer', 'Install.command'), '#!/bin/sh\n');
  await writeFile(join(f.source, 'installer', 'Install.cmd'), '@echo off\r\n');
  execFileSync('git', ['init', '-q', f.source]);
  execFileSync('git', ['-C', f.source, 'add', '.']);
  execFileSync('git', ['-C', f.source, '-c', 'user.name=Installer test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'Synthetic release']);
  for (const filename of ['.env.production', 'credentials.json', 'private.key']) await writeFile(join(f.source, 'installer', filename), 'synthetic-secret-sentinel');
  const out = join(dirname(f.base), 'release output');
  const artifacts = await buildArtifacts({ root: f.source, output: out });
  for (const path of artifacts) assert.ok(!(await readFile(path)).includes(Buffer.from('synthetic-secret-sentinel')));
  execFileSync('git', ['-C', f.source, 'add', 'installer/.env.production']);
  await assert.rejects(buildArtifacts({ root: f.source, output: out }), /clean committed|sensitive/);
  execFileSync('git', ['-C', f.source, '-c', 'user.name=Installer test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'Synthetic sensitive fixture']);
  await assert.rejects(buildArtifacts({ root: f.source, output: out }), /sensitive/);
});

test('Claude version floor accepts future minor and major versions', async t => {
  for (const version of ['2.2.0', '3.0.0']) {
    const f = await fixture(t);
    const execute = async (...args) => args[1][0] === '--version' ? `${version} (Claude Code)` : f.execute(...args);
    assert.equal((await f.module.install({ ...f, execute, dryRun: true })).status, 'planned');
  }
});

test('explicit installer login strips alternate auth selectors and uses a private Google-only workspace', async t => {
  const f = await fixture(t);
  let capture;
  const env = { ...process.env, GEMINI_API_KEY: 'synthetic-key', GOOGLE_GENAI_USE_VERTEXAI: 'true', GEMINI_CLI_HOME: '/synthetic-home', NODE_OPTIONS: '--inspect', GEMINI_CLI_SYSTEM_SETTINGS_PATH: '/synthetic-settings', NO_BROWSER: 'false' };
  await f.module.install({ ...f, signIn: true, env, execute: async (...args) => {
    if (args[2]?.interactive) { capture = args; return ''; }
    return f.execute(...args);
  } });
  for (const key of ['GEMINI_API_KEY', 'GOOGLE_GENAI_USE_VERTEXAI', 'GEMINI_CLI_HOME', 'NODE_OPTIONS', 'GEMINI_CLI_SYSTEM_SETTINGS_PATH']) assert.equal(capture[2].env[key], undefined);
  assert.equal(capture[2].env.HOME, process.env.HOME);
  assert.equal(capture[2].env.USERPROFILE, process.env.USERPROFILE);
  assert.equal(capture[2].env.NO_BROWSER, 'true');
  assert.equal(capture[2].cwd, join(f.base, 'login'));
  assert.ok(capture[1].includes('--extensions'));
  assert.ok(capture[1].includes('none'));
  const settings = JSON.parse(await readFile(join(capture[2].cwd, '.gemini', 'settings.json'), 'utf8'));
  assert.equal(settings.security.auth.selectedType, 'oauth-personal');
  assert.equal(settings.security.auth.enforcedType, 'oauth-personal');
  assert.equal(settings.hooksConfig.enabled, false);
  assert.equal(settings.skills.enabled, false);
  assert.equal(settings.general.enableAutoUpdateNotification, false);
  assert.deepEqual(settings.tools.core, []);
  assert.equal(await readFile(join(capture[2].cwd, '.gemini', '.env'), 'utf8'), '');
});

test('installed sign-in shortcut uses the same sanitized Google login boundary', async t => {
  const f = await fixture(t);
  const lib = join(f.source, 'plugins', 'gemini', 'scripts', 'lib');
  await mkdir(lib, { recursive: true });
  for (const file of ['store.mjs', 'platform.mjs']) await cp(resolve('plugins/gemini/scripts/lib', file), join(lib, file));
  await f.module.install(f);
  const receipt = JSON.parse(await readFile(join(f.base, 'install.json'), 'utf8'));
  const capture = join(f.base, 'synthetic-login-capture.json');
  await writeFile(receipt.geminiEntry, `const fs=require('node:fs');fs.writeFileSync(${JSON.stringify(capture)},JSON.stringify({cwd:process.cwd(),env:Object.fromEntries(['GEMINI_API_KEY','GOOGLE_GENAI_USE_VERTEXAI','GEMINI_CLI_HOME','NODE_OPTIONS','HOME','USERPROFILE','NO_BROWSER'].map(k=>[k,process.env[k]]))}));`);
  execFileSync(process.execPath, [join(f.base, 'launch.mjs'), '--sign-in'], { env: { ...process.env, GEMINI_API_KEY: 'synthetic-key', GOOGLE_GENAI_USE_VERTEXAI: 'true', GEMINI_CLI_HOME: '/synthetic-home', NODE_OPTIONS: '--no-warnings', NO_BROWSER: 'false' } });
  const details = JSON.parse(await readFile(capture, 'utf8'));
  for (const key of ['GEMINI_API_KEY', 'GOOGLE_GENAI_USE_VERTEXAI', 'GEMINI_CLI_HOME', 'NODE_OPTIONS']) assert.equal(details.env[key], undefined);
  assert.equal(details.env.HOME, process.env.HOME);
  assert.equal(details.env.USERPROFILE, process.env.USERPROFILE);
  assert.equal(details.env.NO_BROWSER, 'true');
  assert.equal(await realpath(details.cwd), await realpath(join(f.base, 'login')));
  assert.equal(JSON.parse(await readFile(join(details.cwd, '.gemini', 'settings.json'), 'utf8')).security.auth.enforcedType, 'oauth-personal');
});

test('tool discovery and installed launcher retain stable Node and Claude symlinks across updates', { skip: process.platform === 'win32' }, async t => {
  const f = await fixture(t);
  const bin = join(dirname(f.base), 'stable bin');
  await mkdir(bin);
  const node = join(bin, 'node');
  await symlink(process.execPath, node);
  const v1 = join(bin, 'claude-v1');
  const v2 = join(bin, 'claude-v2');
  const claude = join(bin, 'claude');
  const capture = join(f.base, 'launch-version.txt');
  await writeFile(v1, '#!/bin/sh\nexit 0\n', { mode: 0o700 });
  await writeFile(v2, `#!/bin/sh\nprintf v2 > '${capture.replaceAll("'", "'\\''")}'\n`, { mode: 0o700 });
  await symlink(v1, claude);
  const discovered = await f.module.discoverTools({ env: { ...process.env, PATH: bin + ':' + process.env.PATH } });
  assert.equal(discovered.node, node);
  assert.equal(discovered.claude, claude);
  await f.module.install({ ...f, tools: { ...f.tools, node, claude } });
  await unlink(claude); await symlink(v2, claude); await unlink(v1);
  execFileSync(node, [join(f.base, 'launch.mjs')]);
  assert.equal(await readFile(capture, 'utf8'), 'v2');
});


test('an installed Git launcher without working Git returns setup guidance before mutation', async t => {
  const f = await fixture(t);
  const execute = async (...args) => {
    if (args[0] === f.tools.git) throw new Error('Git tools have not been installed');
    return f.execute(...args);
  };
  const result = await f.module.install({ ...f, execute });
  assert.equal(result.status, 'prerequisites');
  assert.deepEqual(result.missing, ['git']);
  await assert.rejects(access(f.base));
});
