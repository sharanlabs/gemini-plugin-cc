import { access, cp, lstat, mkdir, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { spawn } from 'node:child_process';
import { dirname, delimiter, isAbsolute, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { signIn as googleSignIn } from './login.mjs';
import { privateDirectory, atomicJson } from '../plugins/gemini/scripts/lib/store.mjs';

export const GEMINI_VERSION = '0.63.0';
export const PREREQUISITES = Object.freeze({
  node: 'https://nodejs.org/en/download',
  git: 'https://git-scm.com/downloads',
  claude: 'https://code.claude.com/docs/en/setup',
  npm: 'https://nodejs.org/en/download',
});
export function installBase(platform = process.platform, env = process.env) {
  return platform === 'win32'
    ? join(env.LOCALAPPDATA || join(env.USERPROFILE || homedir(), 'AppData', 'Local'), 'gemini-plugin-cc')
    : join(env.HOME || homedir(), '.local', 'share', 'gemini-plugin-cc');
}
async function exists(path) { try { await access(path); return true; } catch { return false; } }
async function findCommand(name, env, platform, preservePath = false) {
  const extra = platform === 'win32' ? ['.exe', '.com', ''] : [''];
  for (const directory of (env.PATH || env.Path || '').split(platform === 'win32' ? ';' : delimiter)) {
    if (!directory) continue;
    for (const extension of extra) {
      const path = join(directory, name + extension);
      try { await access(path, constants.X_OK); const canonical = await realpath(path); return preservePath ? resolve(path) : canonical; } catch {}
    }
  }
  return null;
}
export async function discoverTools({ env = process.env, platform = process.platform } = {}) {
  let node = process.execPath;
  const discoveredNode = await findCommand('node', env, platform, true);
  if (discoveredNode && await realpath(discoveredNode) === await realpath(process.execPath)) node = discoveredNode;
  const git = await findCommand('git', env, platform);
  let claude = await findCommand('claude', env, platform, true);
  if (!claude) {
    const candidate = join(env.USERPROFILE || env.HOME || homedir(), '.local', 'bin', platform === 'win32' ? 'claude.exe' : 'claude');
    if (await exists(candidate)) claude = candidate;
  }
  const npmCandidates = [join(dirname(node), 'node_modules', 'npm', 'bin', 'npm-cli.js'), join(dirname(node), '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js')];
  const npmCommand = await findCommand('npm', env, platform);
  if (npmCommand?.endsWith('.js')) npmCandidates.unshift(npmCommand);
  const npmShim = platform === 'win32' ? (env.PATH || env.Path || '').split(';').map(p => join(p, 'node_modules', 'npm', 'bin', 'npm-cli.js')) : [];
  const npm = (await Promise.all([...npmCandidates, ...npmShim].map(async p => await exists(p) ? p : null))).find(Boolean) || null;
  let gitBash;
  if (platform === 'win32') {
    const candidates = [env.CLAUDE_CODE_GIT_BASH_PATH, git && join(dirname(git), '..', 'bin', 'bash.exe'), git && join(dirname(git), '..', '..', 'bin', 'bash.exe'), env.ProgramFiles && join(env.ProgramFiles, 'Git', 'bin', 'bash.exe'), env.LOCALAPPDATA && join(env.LOCALAPPDATA, 'Programs', 'Git', 'bin', 'bash.exe')].filter(Boolean);
    gitBash = (await Promise.all(candidates.map(async p => await exists(p) ? await realpath(p) : null))).find(Boolean);
  }
  return { node, git, claude, npm, gitBash };
}
export function run(command, args, { env = process.env, cwd, interactive = false } = {}) {
  return new Promise((resolveResult, reject) => {
    const child = spawn(command, args, { env, cwd, shell: false, windowsHide: !interactive, stdio: interactive ? 'inherit' : ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    if (!interactive) {
      child.stdout.on('data', chunk => { if (stdout.length < 1024 * 1024) stdout += chunk; });
      // Never capture authentication or subprocess diagnostics that could contain credentials.
      child.stderr.resume();
    }
    child.on('error', reject);
    child.on('close', code => code === 0 ? resolveResult(stdout.trim()) : reject(new Error(`Setup subprocess ${args[0] === 'plugin' ? args.slice(0, 3).join(' ') : args.at(-1) === '--version' ? 'version check' : 'installation'} exited with code ${code}.`)));
  });
}
function shellQuote(text) { return "'" + text.replaceAll("'", "'\\''") + "'"; }
async function writeLaunchers(base, receipt, platform) {
  const code = `import{readFile}from'node:fs/promises';import{spawn}from'node:child_process';import{dirname,delimiter}from'node:path';\nconst r=JSON.parse(await readFile(new URL('./install.json',import.meta.url),'utf8'));const env={...Object.fromEntries(Object.entries(process.env).filter(([k])=>k.toUpperCase()!=='PATH')), ...(r.gitBashPath?{CLAUDE_CODE_GIT_BASH_PATH:r.gitBashPath}:{}),PATH:[dirname(r.nodePath),dirname(r.gitPath),dirname(r.claudePath),process.env.PATH||process.env.Path||''].join(delimiter)};const login=process.argv.includes('--sign-in');if(login){try{const{signIn}=await import('./marketplace/installer/login.mjs');await signIn({receipt:r,env})}catch{console.error('Google sign-in failed. Re-run the Sign in to Gemini shortcut.');process.exitCode=1}}else{const child=spawn(r.claudePath,process.argv.slice(2),{env,stdio:'inherit',shell:false});child.on('error',()=>{console.error('Launch failed. Run the installer again.');process.exitCode=1});child.on('exit',c=>process.exitCode=c??1);}\n`;
  await writeFile(join(base, 'launch.mjs'), code, { mode: 0o600 });
  if (platform === 'win32') {
    const node = receipt.nodePath.replaceAll('%', '%%');
    await writeFile(join(base, 'Launch Claude.cmd'), `@echo off\r\n"${node}" "%~dp0launch.mjs" %*\r\n`, { mode: 0o700 });
    await writeFile(join(base, 'Sign in to Gemini.cmd'), `@echo off\r\n"${node}" "%~dp0launch.mjs" --sign-in\r\npause\r\n`, { mode: 0o700 });
  } else {
    await writeFile(join(base, 'Launch Claude.command'), `#!/bin/sh\nexec ${shellQuote(receipt.nodePath)} ${shellQuote(join(base, 'launch.mjs'))} "$@"\n`, { mode: 0o700 });
    await writeFile(join(base, 'Sign in to Gemini.command'), `#!/bin/sh\nexec ${shellQuote(receipt.nodePath)} ${shellQuote(join(base, 'launch.mjs'))} --sign-in\n`, { mode: 0o700 });
  }
}
export async function install({ source = resolve(dirname(fileURLToPath(import.meta.url)), '..'), base = installBase(), tools, env = process.env, platform = process.platform, dryRun = false, signIn = false, execute = run, log = console.log } = {}) {
  tools ||= await discoverTools({ env, platform });
  const missing = ['node', 'npm', 'git', 'claude'].filter(name => !tools[name]);
  if (platform === 'win32' && !tools.gitBash && !missing.includes('git')) missing.push('git');
  if (tools.node && Number(process.versions.node.split('.')[0]) < 20) missing.push('node');
  if (missing.length) return { status: 'prerequisites', missing, help: Object.fromEntries(missing.map(name => [name, PREREQUISITES[name]])) };
  const manifest = JSON.parse(await readFile(join(source, 'package.json'), 'utf8'));
  if (!/^\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(manifest.version)) throw new Error('Invalid release version.');
  const normalizedEnv = Object.fromEntries(Object.entries(env).filter(([key]) => key.toUpperCase() !== 'PATH'));
  const childEnv = { ...normalizedEnv, ...(tools.gitBash ? { CLAUDE_CODE_GIT_BASH_PATH: tools.gitBash } : {}), PATH: [dirname(tools.node), dirname(tools.git), dirname(tools.claude), env.PATH || env.Path || ''].join(platform === 'win32' ? ';' : delimiter) };
  const claudeVersion = await execute(tools.claude, ['--version'], { env: childEnv });
  const versionParts = claudeVersion.match(/\b(\d+)\.(\d+)\.(\d+)/)?.slice(1).map(Number);
  if (!versionParts || versionParts[0] < 2 || (versionParts[0] === 2 && (versionParts[1] < 1 || (versionParts[1] === 1 && versionParts[2] < 292)))) throw new Error('Claude Code 2.1.292 or later is required; update it using the official setup guide.');
  const marketplaces = JSON.parse(await execute(tools.claude, ['plugin', 'marketplace', 'list', '--json'], { env: childEnv }));
  if (!Array.isArray(marketplaces)) throw new Error('Claude marketplace response is invalid.');
  const marketplace = marketplaces.find(item => item.name === 'gemini-companion');
  const target = join(base, 'marketplace');
  if (marketplace && !(marketplace.source === 'github' && marketplace.repo === 'sharanlabs/gemini-plugin-cc') && resolve(marketplace.path || marketplace.installLocation || '') !== resolve(target)) throw new Error('A different gemini-companion marketplace is registered. Resolve the name conflict in Claude before installation.');
  const plan = { status: 'planned', base, version: manifest.version, geminiVersion: GEMINI_VERSION, source, marketplace: marketplace ? 'existing' : 'local', signIn };
  if (dryRun) return plan;
  try {
    const gitVersion = await execute(tools.git, ['--version'], { env: childEnv });
    if (!/^git version /i.test(gitVersion)) throw new Error('Git did not report its version');
  } catch {
    return { status: 'prerequisites', missing: ['git'], help: { git: PREREQUISITES.git } };
  }
  await privateDirectory(base);
  const receiptPath = join(base, 'install.json');
  let previousReceipt;
  if (await exists(receiptPath)) {
    if ((await lstat(receiptPath)).isSymbolicLink()) throw new Error('Installation receipt must not be a symbolic link.');
    previousReceipt = await readFile(receiptPath, 'utf8');
  }
  if (await exists(target)) {
    let owned;
    try { owned = JSON.parse(previousReceipt); } catch {}
    if (!owned || owned.schema !== 1 || resolve(owned.pluginRoot || '') !== resolve(target) || (await lstat(target)).isSymbolicLink()) throw new Error('Existing marketplace directory is not owned by this installer.');
  }
  const runtime = join(base, 'runtimes', `gemini-${GEMINI_VERSION}`);
  const packagePath = join(runtime, 'node_modules', '@google', 'gemini-cli');
  const geminiEntry = join(packagePath, 'bundle', 'gemini.js');
  let installed = false;
  try {
    const pkg = JSON.parse(await readFile(join(packagePath, 'package.json'), 'utf8'));
    installed = pkg.name === '@google/gemini-cli' && pkg.version === GEMINI_VERSION && pkg.bin?.gemini === 'bundle/gemini.js';
  } catch {}
  if (!installed) {
    await privateDirectory(runtime);
    log(`Installing private Gemini CLI ${GEMINI_VERSION}; existing global installations are preserved.`);
    await execute(tools.node, [tools.npm, 'install', '--prefix', runtime, '--ignore-scripts', '--no-audit', '--no-fund', '--registry', 'https://registry.npmjs.org', `@google/gemini-cli@${GEMINI_VERSION}`], { env: childEnv });
  }
  const geminiVersion = await execute(tools.node, [geminiEntry, '--version'], { env: childEnv });
  if (geminiVersion.trim() !== GEMINI_VERSION) throw new Error(`Private Gemini did not report required version ${GEMINI_VERSION}. Re-run setup after resolving the installation.`);
  const stage = join(base, `.marketplace-${randomUUID()}`);
  const backup = join(base, `.previous-${randomUUID()}`);
  await mkdir(stage, { mode: 0o700 });
  for (const item of ['.claude-plugin', 'plugins', 'LICENSE', 'NOTICE', 'package.json', 'README.md', 'SECURITY.md']) {
    if (await exists(join(source, item))) await cp(join(source, item), join(stage, item), { recursive: true, dereference: false, errorOnExist: true });
  }
  await mkdir(join(stage, 'installer'), { mode: 0o700 });
  await cp(new URL('./login.mjs', import.meta.url), join(stage, 'installer', 'login.mjs'));
  let moved = false;
  let completed = false;
  try {
    if (await exists(target)) { await rename(target, backup); moved = true; }
    await rename(stage, target);
    const receipt = { schema: 1, geminiEntry, nodePath: tools.node, gitPath: tools.git, gitBashPath: tools.gitBash, claudePath: tools.claude, pluginRoot: target, installedVersion: manifest.version };
    await atomicJson(receiptPath, receipt);
    if (marketplace?.source === 'github') await execute(tools.claude, ['plugin', 'marketplace', 'update', 'gemini-companion'], { env: childEnv });
    if (!marketplace) await execute(tools.claude, ['plugin', 'marketplace', 'add', target], { env: childEnv });
    await execute(tools.claude, ['plugin', 'install', 'gemini@gemini-companion', '--scope', 'user'], { env: childEnv });
    await execute(tools.claude, ['plugin', 'update', 'gemini@gemini-companion', '--scope', 'user'], { env: childEnv });
    const installedPlugins = JSON.parse(await execute(tools.claude, ['plugin', 'list', '--json'], { env: childEnv }));
    const installedPlugin = installedPlugins.find(item => item.id === 'gemini@gemini-companion' && item.scope === 'user');
    if (installedPlugin?.version !== manifest.version) throw new Error(`Claude installed version ${installedPlugin?.version || 'unknown'}; required release ${manifest.version}. Update the marketplace or use the matching release download.`);
    if (installedPlugin.enabled !== true) await execute(tools.claude, ['plugin', 'enable', 'gemini@gemini-companion', '--scope', 'user'], { env: childEnv });
    await writeLaunchers(base, receipt, platform);
    if (moved) await rm(backup, { recursive: true });
    completed = true;
    log(`Installed Gemini Companion ${manifest.version}. Launch shortcuts: ${base}`);
    if (signIn) {
      log('Open the Google link shown in Terminal, sign in, and paste its authorization code into that Terminal only. When the Gemini chat prompt appears, type /quit. Authentication stays with Gemini CLI.');
      await googleSignIn({ receipt, env: childEnv, execute });
    }
    return { ...plan, status: 'installed', receipt: receiptPath };
  } catch (error) {
    if (completed) throw new Error(`${error.message} Plugin installation is complete. Use the Sign in to Gemini shortcut to finish authentication.`, { cause: error });
    await rm(stage, { recursive: true, force: true });
    await rm(target, { recursive: true, force: true });
    if (moved) await rename(backup, target);
    if (previousReceipt !== undefined) await writeFile(receiptPath, previousReceipt, { mode: 0o600 });
    else await rm(receiptPath, { force: true });
    throw new Error(`${error.message} Installation did not complete. Existing runtime files are retained; re-run the installer. Claude may have registered the marketplace; it can be removed with claude plugin marketplace remove gemini-companion.`, { cause: error });
  }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const allowed = new Set(['--dry-run', '--sign-in']);
  if (process.argv.slice(2).some(arg => !allowed.has(arg))) { console.error('Usage: node installer/install.mjs [--dry-run] [--sign-in]'); process.exitCode = 2; }
  else try {
    const result = await install({ dryRun: process.argv.includes('--dry-run'), signIn: process.argv.includes('--sign-in') });
    console.log(JSON.stringify(result, null, 2));
    if (result.status === 'prerequisites') { console.log('Install the missing prerequisites from the official links above, then run this installer again. No account credentials were accessed.'); process.exitCode = 2; }
    else if (result.status === 'installed') console.log('Start a new Claude session using Launch Claude, then run /gemini:setup --check-auth.');
  } catch (error) { console.error(`Setup failed: ${error.message}`); process.exitCode = 1; }
}
