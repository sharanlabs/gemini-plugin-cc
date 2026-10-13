import { execFile } from 'node:child_process';
import { lstat, readFile, readlink, mkdtemp, rm } from 'node:fs/promises';
import { join, isAbsolute } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';

export function sensitivePath(path) {
  return /(^|\/)(\.env(?:\..*)?|\.gemini|\.claude|\.codex|\.ssh|\.aws|\.npmrc|\.netrc|credentials(?:\..*)?|secrets?(?:\..*)?|id_(?:rsa|ed25519)|[^/]+\.(?:pem|p12|pfx|key))($|\/)/i.test(
    path,
  );
}
export async function git(cwd, args, { env, input } = {}) {
  // Do not inherit Git execution/config injection from another tool's environment.
  const clean = { ...process.env };
  for (const key of Object.keys(clean)) if (key.startsWith('GIT_')) delete clean[key];
  return new Promise((accept, reject) => {
    const p = execFile(
      'git',
      [
        '-c',
        'core.hooksPath=/dev/null',
        '-c',
        'core.fsmonitor=false',
        '-c',
        'diff.external=',
        ...args,
      ],
      {
        cwd,
        env: { ...clean, ...env },
        encoding: 'utf8',
        maxBuffer: 16 * 1024 * 1024,
        timeout: 30000,
      },
      (error, stdout) => {
        if (error) {
          const e = new Error(`Git operation failed: ${args[0]}`);
          e.code = 'GIT_FAILED';
          reject(e);
        } else accept(stdout);
      },
    );
    if (input !== undefined) {
      p.stdin.on('error', () => {});
      p.stdin.end(input);
    } else p.stdin.end();
  });
}

async function entries(cwd) {
  const listing = await git(cwd, ['ls-files', '-z', '--cached', '--others', '--exclude-standard']);
  const paths = [...new Set(listing.split('\0').filter(Boolean))].sort();
  const assistantSettings = (path) => /(?:^|\/)(?:\.claude|\.codex|\.gemini)(?:\/|$)/.test(path);
  const dirtyPaths = (await git(cwd, ['diff', '--name-only', '-z', 'HEAD', '--'])).split('\0');
  if (dirtyPaths.some(assistantSettings)) {
    throw new Error(
      'Assistant settings changed; preserve them separately before delegated editing',
    );
  }
  const index = new Map();
  for (const record of (await git(cwd, ['ls-files', '--stage', '-z']))
    .split('\0')
    .filter(Boolean)) {
    const boundary = record.indexOf('\t');
    const [mode, oid, stage] = record.slice(0, boundary).split(' ');
    if (stage !== '0') throw new Error('Resolve index conflicts before delegated editing');
    index.set(record.slice(boundary + 1), { mode, oid });
  }
  const result = [];
  let total = 0;
  fileLoop: for (const path of paths) {
    if (isAbsolute(path) || path.split('/').includes('..'))
      throw new Error('Unsafe repository path');
    // Preserve unchanged checked-in assistant settings by object ID without
    // reading their contents or including them in task context or patches.
    if (assistantSettings(path)) {
      if (index.has(path)) result.push({ path, ...index.get(path) });
      continue;
    }
    if (sensitivePath(path))
      throw new Error('Repository contains a sensitive path; exclude it before delegated editing');
    const parts = path.split('/');
    for (let i = 1; i < parts.length; i++) {
      let parent;
      try {
        parent = await lstat(join(cwd, ...parts.slice(0, i)));
      } catch (e) {
        if (e.code === 'ENOENT') {
          result.push({ path, deleted: true });
          continue fileLoop;
        }
        throw e;
      }
      if (parent.isSymbolicLink() || !parent.isDirectory())
        throw new Error('Repository path has a symlink or non-directory ancestor');
    }
    let s;
    try {
      s = await lstat(join(cwd, path));
    } catch (e) {
      if (e.code === 'ENOENT') {
        result.push({ path, deleted: true });
        continue;
      }
      throw e;
    }
    if (s.isDirectory()) throw new Error('Submodule or embedded repository editing is unsupported');
    if (!s.isFile() && !s.isSymbolicLink()) throw new Error('Non-regular file in repository');
    total += s.size;
    if (total > 64 * 1024 * 1024)
      throw new Error('Repository snapshot exceeds 64 MiB; use a smaller checkout');
    const data = s.isSymbolicLink()
      ? Buffer.from(await readlink(join(cwd, path)))
      : await readFile(join(cwd, path));
    result.push({
      path,
      data,
      mode: s.isSymbolicLink() ? '120000' : s.mode & 0o111 ? '100755' : '100644',
    });
  }
  return result;
}

export async function fingerprint(cwd) {
  const hash = createHash('sha256');
  hash.update(await git(cwd, ['rev-parse', 'HEAD']));
  hash.update(await git(cwd, ['diff', '--cached', '--binary', '--no-ext-diff', '--no-textconv']));
  for (const item of await entries(cwd)) {
    hash.update(item.path + '\0' + (item.mode || 'deleted') + '\0');
    if (item.data) hash.update(item.data);
    if (item.oid) hash.update(item.oid);
    hash.update('\0');
  }
  return hash.digest('hex');
}

export async function captureTree(cwd) {
  const scratch = await mkdtemp(join(tmpdir(), 'gemini-tree-'));
  const env = { GIT_INDEX_FILE: join(scratch, 'index') };
  try {
    await git(cwd, ['read-tree', '--empty'], { env });
    let info = '';
    for (const item of await entries(cwd)) {
      if (item.deleted) continue;
      else {
        const oid =
          item.oid ||
          (await git(cwd, ['hash-object', '-w', '--stdin'], { input: item.data })).trim();
        info += `${item.mode} ${oid}\t${item.path}\0`;
      }
    }
    await git(cwd, ['update-index', '-z', '--index-info'], { env, input: info });
    return (await git(cwd, ['write-tree'], { env })).trim();
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

export async function makePatch(cwd, baseTree) {
  if (!/^[a-f0-9]{40,64}$/.test(baseTree)) throw new Error('Invalid baseline tree');
  const finalTree = await captureTree(cwd);
  const raw = await git(cwd, ['diff', '--raw', '-z', baseTree, finalTree]);
  for (const record of raw.split('\0'))
    if (record.startsWith(':') && /120000|160000/.test(record))
      throw new Error('Delegated symlink or submodule changes cannot be applied');
  return git(cwd, [
    'diff',
    '--binary',
    '--no-ext-diff',
    '--no-textconv',
    baseTree,
    finalTree,
    '--',
  ]);
}

export async function applyPatch({ cwd, patch, expectedFingerprint }) {
  if (typeof patch !== 'string' || Buffer.byteLength(patch) > 16 * 1024 * 1024)
    throw new Error('Invalid patch');
  if ((await fingerprint(cwd)) !== expectedFingerprint)
    throw new Error(
      'Source checkout changed since delegation; review the retained worktree and port changes manually',
    );
  if (!patch) return { applied: false };
  await git(cwd, ['apply', '--check', '--whitespace=nowarn', '-'], { input: patch });
  await git(cwd, ['apply', '--whitespace=nowarn', '-'], { input: patch });
  return { applied: true };
}
