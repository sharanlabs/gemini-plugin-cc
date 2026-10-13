import { spawn } from 'node:child_process';
import { constants } from 'node:fs';
import { lstat, realpath, mkdir, open, readFile, writeFile, chmod } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

const SNAPSHOT_LIMIT = 64 * 1024 * 1024;
const PATH_LIMIT = 8 * 1024 * 1024;
const OWNER_FILE = 'gemini-plugin-worktree-owner.json';
const SOURCE_EXTENSIONS = /\.(?:[cm]?[jt]sx?|py|rs|go|java|kt|kts|cs|[ch]|cpp|hpp|cc|css|scss|sass|less|html?|md|mdx|json|jsonc|toml|ya?ml|xml|sh|bash|zsh|fish|txt|sql|graphql|gql|proto|svelte|vue|astro|rb|php|swift|ex|exs|erl|hs|lua|r|dart|gradle|properties)$/i;
const SOURCE_NAMES = /^(?:Dockerfile(?:\..*)?|Makefile|CMakeLists\.txt|LICENSE(?:\..*)?|README(?:\..*)?|\.gitignore|\.gitattributes|\.editorconfig)$/i;

// These filters reduce accidental exposure. They cannot identify arbitrary secrets
// embedded in source, nor restrict what a CLI with repository access can read.
function sensitivePath(path) {
  return /(?:^|\/)(?:\.env[^/]*|\.ssh|\.aws|\.gnupg|\.gemini|\.claude|node_modules|\.git)(?:\/|$)/i.test(path)
    || /(?:^|\/)(?:secrets?|credentials?)(?:\/|$)/i.test(path)
    || /(?:^|\/)(?:credentials?|secrets?|tokens?|auth)(?:[._-][^/]*)?\.(?:json|ya?ml|toml|ini|txt)$/i.test(path)
    || /(?:^|\/)(?:service[-_]account[^/]*|[^/]*firebase-adminsdk[^/]*)\.json$/i.test(path)
    || /(?:^|\/)(?:id_(?:rsa|dsa|ecdsa|ed25519)(?:\.pub)?|\.npmrc|\.netrc|\.pypirc)$/i.test(path)
    || /\.(?:pem|key|p12|pfx|keystore|jks|kdbx)$/i.test(path);
}

function redact(text) {
  return text
    .replace(/-----BEGIN (?:[A-Z ]*PRIVATE KEY|OPENSSH PRIVATE KEY)-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g, '[REDACTED PRIVATE KEY]')
    .replace(/\b(?:AIza[\w-]{20,}|sk-(?:proj-)?[\w-]{12,}|gh[pousr]_[\w]{12,}|github_pat_[\w_]{12,}|(?:AKIA|ASIA)[A-Z0-9]{16}|eyJ[\w-]+\.[\w-]+\.[\w-]+)\b/g, '[REDACTED]')
    .replace(/\b((?:Bearer|Basic)\s+)[^\s"'`;,]+/gi, '$1[REDACTED]')
    .replace(/(\b(?:[A-Z0-9_]*(?:API[_-]?KEY|ACCESS[_-]?TOKEN|AUTH[_-]?TOKEN|CLIENT[_-]?SECRET|PASSWORD|PASSWD|PRIVATE[_-]?KEY)[A-Z0-9_]*|secret|token)\b\s*["']?\s*[:=]\s*)[^\r\n]+/gi, '$1[REDACTED]')
    .replace(/(https?:\/\/)[^\s/@:]+:[^\s/@]+@/gi, '$1[REDACTED]@');
}

function utf8Prefix(value, bytes) {
  if (bytes <= 0) return '';
  const buffer = Buffer.from(value);
  if (buffer.length <= bytes) return value;
  return buffer.subarray(0, bytes).toString('utf8').replace(/\uFFFD$/u, '');
}

function boundedText(maxBytes) {
  let text = '';
  let truncated = false;
  return {
    append(value) {
      const safe = redact(String(value));
      const remaining = maxBytes - Buffer.byteLength(text);
      if (Buffer.byteLength(safe) > remaining) truncated = true;
      text += utf8Prefix(safe, remaining);
    },
    markTruncated() { truncated = true; },
    full() { return Buffer.byteLength(text) >= maxBytes; },
    result() {
      if (truncated) {
        const marker = '\n[Context truncated to byte limit]\n';
        text = utf8Prefix(text, Math.max(0, maxBytes - Buffer.byteLength(marker))) + utf8Prefix(marker, maxBytes);
      }
      return { text, truncated };
    },
  };
}

function gitEnvironment() {
  const env = { ...process.env, GIT_TERMINAL_PROMPT: '0' };
  for (const key of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES']) delete env[key];
  return env;
}

function git(cwd, args, { input, maxBytes = PATH_LIMIT, truncate = false } = {}) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn('git', ['-C', cwd, '-c', 'core.fsmonitor=false', ...args], {
      env: gitEnvironment(), stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
    });
    const output = [];
    let bytes = 0;
    let overflow = false;
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      const remaining = maxBytes - bytes;
      if (chunk.length > remaining) overflow = true;
      if (remaining > 0) { output.push(chunk.subarray(0, remaining)); bytes += Math.min(chunk.length, remaining); }
    });
    child.stderr.on('data', (chunk) => { stderr = utf8Prefix(stderr + chunk.toString(), 2000); });
    child.once('error', reject);
    child.once('close', (code) => {
      if (code !== 0) {
        const error = new Error(`Git ${args[0]} failed (${code}): ${redact(stderr.trim())}`);
        error.code = 'GIT_FAILED';
        reject(error);
      } else if (overflow && !truncate) reject(new Error('Git output exceeded the safe snapshot limit. Narrow the task or commit changes first.'));
      else resolvePromise({ buffer: Buffer.concat(output), truncated: overflow });
    });
    child.stdin.on('error', () => {});
    child.stdin.end(input);
  });
}

async function gitText(cwd, args, options) { return (await git(cwd, args, options)).buffer.toString('utf8').trimEnd(); }
async function gitPaths(cwd, args) { return (await git(cwd, args)).buffer.toString('utf8').split('\0').filter(Boolean); }
function validPath(path) { return typeof path === 'string' && path.length > 0 && !isAbsolute(path) && !path.includes('\0') && !path.split(/[\\/]/).some((part) => part === '..' || part === '.git'); }
function literalPaths(paths) { return paths.map((path) => `:(literal)${path}`); }
function isWithin(parent, child) { const path = relative(parent, child); return path === '' || (!path.startsWith(`..${sep}`) && path !== '..' && !isAbsolute(path)); }

async function safeRegularFile(root, path, maxBytes = SNAPSHOT_LIMIT) {
  if (!validPath(path) || sensitivePath(path)) return null;
  let current = root;
  const pieces = path.split('/');
  for (let i = 0; i < pieces.length; i += 1) {
    current = join(current, pieces[i]);
    let stat;
    try { stat = await lstat(current); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
    if (stat.isSymbolicLink() || (i < pieces.length - 1 && !stat.isDirectory())) return null;
    if (i === pieces.length - 1 && (!stat.isFile() || stat.size > maxBytes)) return null;
  }
  const handle = await open(current, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > maxBytes) return null;
    const buffer = Buffer.alloc(Math.min(stat.size + 1, maxBytes + 1));
    let total = 0;
    while (total < buffer.length) {
      const { bytesRead } = await handle.read(buffer, total, buffer.length - total, total);
      if (!bytesRead) break;
      total += bytesRead;
    }
    if (total > maxBytes) return null;
    const data = buffer.subarray(0, total);
    if (data.includes(0)) return null;
    try { new TextDecoder('utf-8', { fatal: true }).decode(data); } catch { return null; }
    return { data, mode: stat.mode & 0o777 };
  } finally { await handle.close(); }
}

async function specialTrackedPaths(root, head) {
  const entries = await gitPaths(root, ['ls-files', '--stage', '-z']);
  if (head) entries.push(...await gitPaths(root, ['ls-tree', '-r', '-z', head]));
  return new Set(entries.filter((entry) => /^(?:120000|160000) /.test(entry)).map((entry) => entry.slice(entry.indexOf('\t') + 1)));
}

/** Resolve cwd without assuming every task belongs to a Git repository. */
export async function resolveWorkspace(cwd) {
  const directory = await realpath(resolve(cwd));
  if (!(await lstat(directory)).isDirectory()) throw new Error('Workspace cwd must be a directory.');
  try { return { root: await realpath(await gitText(directory, ['rev-parse', '--show-toplevel'])), git: true }; }
  catch (error) { if (error.code !== 'GIT_FAILED') throw error; return { root: directory, git: false }; }
}

async function headOf(root) {
  try { return await gitText(root, ['rev-parse', '--verify', '--end-of-options', 'HEAD^{commit}']); }
  catch (error) { if (error.code !== 'GIT_FAILED') throw error; return null; }
}

/**
 * Collect bounded text for a delegated task. Credential paths, symlinks and binary
 * content are omitted; common credentials are redacted. This is not a complete
 * secret detector. Untracked content is limited to recognizable source/text files.
 */
export async function collectContext({ cwd, base, mode = 'review', focus = '', maxBytes = 250000 }) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > SNAPSHOT_LIMIT) throw new Error('maxBytes must be a positive integer no larger than 64 MiB.');
  const workspace = await resolveWorkspace(cwd);
  const out = boundedText(maxBytes);
  const { root } = workspace;
  const head = workspace.git ? await headOf(root) : null;
  let target = 'working-tree';
  const changedFiles = new Set();
  if (!workspace.git) out.append('Not a Git repository. No Git change context is available.\n');
  out.append(`Workspace: ${root}\nTask mode: ${mode}\n`);
  if (focus) out.append(`Requested focus: ${focus}\n`);
  if (!workspace.git) {
    if (base) throw new Error('A base reference requires a Git repository.');
    return { ...workspace, ...out.result(), target: 'directory', head, changedFiles: [] };
  }
  out.append(`HEAD: ${head || '(unborn repository)'}\n`);
  out.append('Credential paths, symlinks and binary content are excluded. Secret redaction is best effort.\n');
  const special = await specialTrackedPaths(root, head);
  const safe = (path) => validPath(path) && !sensitivePath(path) && !special.has(path);
  const tracked = (await gitPaths(root, ['ls-files', '-z'])).filter(safe);
  out.append(`Tracked files (${tracked.length}; names only):\n`);
  let listedBytes = 0;
  let listedFiles = 0;
  for (const path of tracked.slice(0, 100)) {
    const line = `${JSON.stringify(path)}\n`;
    if (listedBytes + Buffer.byteLength(line) > Math.min(16000, Math.floor(maxBytes / 5))) break;
    out.append(line);
    listedBytes += Buffer.byteLength(line);
    listedFiles += 1;
  }
  if (listedFiles < tracked.length) out.append(`[${tracked.length - listedFiles} additional tracked filenames omitted]\n`);
  const groups = [];
  if (base !== undefined && base !== '') {
    if (typeof base !== 'string' || base.startsWith('-') || /[\0\r\n]/.test(base) || !head) throw new Error('Invalid base reference.');
    let resolvedBase;
    try { resolvedBase = await gitText(root, ['rev-parse', '--verify', '--end-of-options', `${base}^{commit}`]); }
    catch { throw new Error('Base reference does not resolve to a commit.'); }
    const mergeBase = await gitText(root, ['merge-base', head, resolvedBase]);
    target = `branch:${resolvedBase}`;
    out.append(`Review base: ${resolvedBase}\nMerge base: ${mergeBase}\n`);
    groups.push({ title: 'Branch and working changes', args: [mergeBase] });
  } else {
    groups.push({ title: 'Staged changes', args: ['--cached', ...(head ? [head] : [])] });
    groups.push({ title: 'Unstaged changes', args: [] });
  }
  for (const group of groups) {
    const paths = await gitPaths(root, ['diff', '--no-ext-diff', '--no-textconv', '--no-renames', '--name-only', '-z', ...group.args, '--']);
    const eligible = [];
    for (const path of paths.filter(safe)) {
      try { if ((await lstat(join(root, path))).isSymbolicLink()) continue; } catch (error) { if (error.code !== 'ENOENT') throw error; }
      eligible.push(path);
      changedFiles.add(path);
    }
    out.append(`\n${group.title}:\n`);
    if (!eligible.length) out.append('(none eligible)\n');
    for (const path of eligible) {
      if (out.full()) { out.markTruncated(); break; }
      const diff = await git(root, ['diff', '--no-ext-diff', '--no-textconv', '--no-renames', '--no-color', '--unified=3', ...group.args, '--', ...literalPaths([path])], { maxBytes, truncate: true });
      out.append(diff.buffer.toString('utf8'));
      if (diff.truncated) out.markTruncated();
    }
    if (paths.length > eligible.length) out.append(`[${paths.length - eligible.length} sensitive or nonregular changes omitted]\n`);
  }
  out.append('\nUntracked source files:\n');
  const untracked = await gitPaths(root, ['ls-files', '--others', '--exclude-standard', '-z']);
  let omitted = 0;
  for (const path of untracked) {
    if (!safe(path) || (!SOURCE_EXTENSIONS.test(path) && !SOURCE_NAMES.test(basename(path)))) { omitted += 1; continue; }
    const file = await safeRegularFile(root, path, Math.min(maxBytes, 1024 * 1024));
    if (!file) { omitted += 1; continue; }
    changedFiles.add(path);
    if (out.full()) { out.markTruncated(); continue; }
    out.append(`\n--- untracked ${JSON.stringify(path)} ---\n${file.data.toString('utf8')}\n`);
  }
  if (omitted) out.append(`[${omitted} untracked files omitted: credential, binary, symlink, oversized or non-source files]\n`);
  return { ...workspace, ...out.result(), target, head, changedFiles: [...changedFiles] };
}

async function canonicalDestination(destination) {
  let ancestor = resolve(destination);
  const missing = [];
  while (true) {
    try {
      const stat = await lstat(ancestor);
      if (!stat.isDirectory() && !stat.isSymbolicLink()) throw new Error('Worktree destination ancestor is not a directory.');
      const canonical = await realpath(ancestor);
      return resolve(canonical, ...missing.reverse());
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      missing.push(basename(ancestor));
      const next = dirname(ancestor);
      if (next === ancestor) throw error;
      ancestor = next;
    }
  }
}

/**
 * Create an isolated detached worktree. Exact tracked staged/unstaged patches are
 * kept in memory and copied without changing the source checkout. Sensitive dirty
 * paths, tracked symlinks, submodules and unresolved merges fail closed. Safe
 * untracked UTF-8 source files are copied; ignored/credential/binary files are not.
 * Existing committed source remains available to the delegated CLI.
 */
export async function createTaskWorktree({ cwd, destination }) {
  const source = await resolveWorkspace(cwd);
  if (!source.git) throw new Error('An isolated task worktree requires a Git repository.');
  const head = await headOf(source.root);
  if (!head) throw new Error('An isolated task worktree requires an initial commit.');
  if (typeof destination !== 'string' || !destination || destination.includes('\0')) throw new Error('A valid worktree destination is required.');
  const root = await canonicalDestination(destination);
  if (isWithin(source.root, root)) throw new Error('Worktree destination must be outside the source checkout.');
  try { await lstat(root); throw new Error('Worktree destination already exists.'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  if ((await gitPaths(source.root, ['ls-files', '--unmerged', '-z'])).length) throw new Error('Resolve unmerged index changes before creating a task worktree.');
  if ((await specialTrackedPaths(source.root, head)).size) throw new Error('Tracked symlinks or submodules cannot be safely copied into an isolated task worktree.');
  const dirty = [...new Set([
    ...await gitPaths(source.root, ['diff', '--cached', '--no-renames', '--name-only', '-z', head, '--']),
    ...await gitPaths(source.root, ['diff', '--no-renames', '--name-only', '-z', '--']),
  ])];
  for (const path of dirty) {
    if (!validPath(path) || sensitivePath(path)) throw new Error('Sensitive credential or unsafe tracked changes cannot be copied into an isolated task worktree.');
    try { if ((await lstat(join(source.root, path))).isSymbolicLink()) throw new Error('Symlink changes cannot be copied into an isolated task worktree.'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  const patchArgs = ['diff', '--binary', '--full-index', '--no-ext-diff', '--no-textconv', '--no-renames'];
  const staged = (await git(source.root, [...patchArgs, '--cached', head, '--'], { maxBytes: SNAPSHOT_LIMIT })).buffer;
  const unstaged = (await git(source.root, [...patchArgs, '--'], { maxBytes: SNAPSHOT_LIMIT })).buffer;
  const untracked = [];
  let totalBytes = staged.length + unstaged.length;
  if (totalBytes > SNAPSHOT_LIMIT) throw new Error('Dirty snapshot exceeds 64 MiB. Commit or narrow changes first.');
  for (const path of await gitPaths(source.root, ['ls-files', '--others', '--exclude-standard', '-z'])) {
    if (!SOURCE_EXTENSIONS.test(path) && !SOURCE_NAMES.test(basename(path))) continue;
    const file = await safeRegularFile(source.root, path);
    if (!file) continue;
    totalBytes += file.data.length;
    if (totalBytes > SNAPSHOT_LIMIT) throw new Error('Dirty snapshot exceeds 64 MiB. Commit or narrow changes first.');
    untracked.push({ path, ...file });
  }
  // Detect source edits while taking the snapshot rather than silently mix versions.
  const stagedAgain = (await git(source.root, [...patchArgs, '--cached', head, '--'], { maxBytes: SNAPSHOT_LIMIT })).buffer;
  const unstagedAgain = (await git(source.root, [...patchArgs, '--'], { maxBytes: SNAPSHOT_LIMIT })).buffer;
  if (await headOf(source.root) !== head || !staged.equals(stagedAgain) || !unstaged.equals(unstagedAgain)) throw new Error('Source changed while preparing the task snapshot. Retry when edits settle.');
  for (const file of untracked) {
    const current = await safeRegularFile(source.root, file.path);
    if (!current || current.mode !== file.mode || !current.data.equals(file.data)) throw new Error('Source changed while preparing the task snapshot. Retry when edits settle.');
  }
  await mkdir(dirname(root), { recursive: true, mode: 0o700 });
  await git(source.root, ['-c', 'core.hooksPath=/dev/null', 'worktree', 'add', '--detach', '--', root, head], { maxBytes: 16000 });
  try {
    const gitDir = await gitText(root, ['rev-parse', '--absolute-git-dir']);
    await writeFile(join(gitDir, OWNER_FILE), JSON.stringify({ sourceRoot: source.root, root, head }), { mode: 0o600, flag: 'wx' });
    if (staged.length) await git(root, ['apply', '--index', '--whitespace=nowarn', '-'], { input: staged });
    if (unstaged.length) await git(root, ['apply', '--whitespace=nowarn', '-'], { input: unstaged });
    for (const file of untracked) {
      const target = join(root, file.path);
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, file.data, { mode: file.mode, flag: 'wx' });
      await chmod(target, file.mode);
    }
  } catch (error) {
    throw new Error(`Task worktree preparation failed; retained for recovery at ${root}. ${error.message}`);
  }
  return { root, sourceRoot: source.root, head, dirtyIncluded: Boolean(staged.length || unstaged.length || untracked.length) };
}

/** Inspect changes without staging or applying them to the user's checkout. */
export async function inspectTaskChanges({ cwd, maxBytes = 250000 }) {
  const workspace = await resolveWorkspace(cwd);
  let base;
  if (workspace.git) {
    const gitDir = await gitText(workspace.root, ['rev-parse', '--absolute-git-dir']);
    try {
      const owner = JSON.parse(await readFile(join(gitDir, OWNER_FILE), 'utf8'));
      if (owner.root === workspace.root && /^[a-f0-9]{40,64}$/.test(owner.head)) base = owner.head;
    } catch (error) {
      if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error;
    }
  }
  return collectContext({ cwd: workspace.root, base, mode: 'task-result', maxBytes });
}

/** Remove only a registered, module-owned worktree containing no changes at all. */
export async function removeTaskWorktree({ sourceRoot, root }) {
  const source = await resolveWorkspace(sourceRoot);
  if (!source.git) throw new Error('Source is not a Git repository.');
  const taskRoot = await realpath(resolve(root));
  if (taskRoot === source.root) throw new Error('Refusing to remove the source checkout.');
  const registered = (await gitPaths(source.root, ['worktree', 'list', '--porcelain', '-z'])).filter((entry) => entry.startsWith('worktree ')).map((entry) => entry.slice(9));
  if (!registered.includes(taskRoot)) throw new Error('Task worktree is not registered with the source repository.');
  const gitDir = await gitText(taskRoot, ['rev-parse', '--absolute-git-dir']);
  let owner;
  try { owner = JSON.parse(await readFile(join(gitDir, OWNER_FILE), 'utf8')); } catch { throw new Error('Refusing to remove a worktree without a managed owner marker.'); }
  if (owner.sourceRoot !== source.root || owner.root !== taskRoot) throw new Error('Managed worktree owner does not match the requested source and root.');
  if (await headOf(taskRoot) !== owner.head) throw new Error('Task worktree HEAD has new commits; preserve them on a branch before removing the worktree.');
  const status = await gitText(taskRoot, ['status', '--porcelain=v1', '--untracked-files=all', '--ignored']);
  if (status) throw new Error('Task worktree is dirty; preserve or transfer all changes before removing it.');
  await git(source.root, ['worktree', 'remove', '--', taskRoot]);
  return { removed: true, root: taskRoot };
}
