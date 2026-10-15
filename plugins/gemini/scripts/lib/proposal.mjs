import { constants } from 'node:fs';
import {
  lstat, realpath, readdir, readFile, open, mkdir, rename, unlink, chmod,
} from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { randomBytes } from 'node:crypto';
import { fingerprint, git, sensitivePath } from './patch.mjs';

export const PROPOSAL_LIMITS = Object.freeze({
  responseBytes: 4 * 1024 * 1024,
  fileBytes: 2 * 1024 * 1024,
  files: 100,
  summaryBytes: 16000,
  pathBytes: 1024,
});
const OWNER_FILE = 'gemini-plugin-worktree-owner.json';
const fail = (message) => {
  throw Object.assign(new Error(message), { code: 'INVALID_EDIT_PROPOSAL' });
};
const folded = (value) => value.normalize('NFC').toLowerCase();
const within = (root, path) => {
  const rest = relative(root, path);
  return rest === '' || (!isAbsolute(rest) && rest !== '..' && !rest.startsWith(`..${sep}`));
};
function exactKeys(value, keys) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) &&
    Object.keys(value).every((key) => keys.includes(key));
}
function validText(text) {
  // JSON permits unpaired surrogates; UTF-8 file encoding would silently replace them.
  return typeof text === 'string' && !text.includes('\0') &&
    Buffer.from(text, 'utf8').toString('utf8') === text;
}

/** One portable path interpretation, including on case-sensitive test hosts. */
export function validateProposalPath(path) {
  if (typeof path !== 'string' || !path || Buffer.byteLength(path) > PROPOSAL_LIMITS.pathBytes ||
      /[\\:\x00-\x1f\x7f<>"|?*]/.test(path) || isAbsolute(path))
    fail('Proposal contains an unsafe relative path.');
  const parts = path.split('/');
  if (parts.some((part) => !part || part === '.' || part === '..' || /[. ]$/.test(part) ||
      Buffer.byteLength(part) > 255 ||
      /^(?:con|prn|aux|nul|conin\$|conout\$|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/i.test(part) ||
      /^(?:\.git|\.hg|\.svn|\.gnupg|\.claude|\.codex|\.gemini|node_modules)$/i.test(part)) ||
      sensitivePath(path) ||
      /(?:^|\/)(?:tokens?|auth)(?:[._-][^/]*)?\.(?:json|ya?ml|toml|ini|txt)$/i.test(path) ||
      /(?:^|\/)(?:oauth_creds|google_accounts|application_default_credentials)\.json$/i.test(path) ||
      /(?:^|\/)(?:service[-_]account[^/]*|[^/]*firebase-adminsdk[^/]*)\.json$/i.test(path) ||
      /\.(?:keystore|jks|kdbx)$/i.test(path))
    fail('Proposal path is reserved, sensitive, or unsafe.');
  return path;
}

/** Parse untrusted model text without executing commands or accepting extra fields. */
export function parseProposal(response) {
  if (typeof response !== 'string' || Buffer.byteLength(response) > PROPOSAL_LIMITS.responseBytes)
    fail('Proposal response exceeds the size limit.');
  let proposal;
  try { proposal = JSON.parse(response); } catch { fail('Expected one strict JSON edit proposal.'); }
  if (!exactKeys(proposal, ['summary', 'changes']) || !validText(proposal.summary) ||
      !proposal.summary.trim() || Buffer.byteLength(proposal.summary) > PROPOSAL_LIMITS.summaryBytes ||
      !Array.isArray(proposal.changes) || proposal.changes.length > PROPOSAL_LIMITS.files)
    fail('Proposal must contain a bounded summary and changes array.');
  const seen = new Set();
  for (const change of proposal.changes) {
    if (!exactKeys(change, ['path', 'operation', 'content']) ||
        !['write', 'delete'].includes(change.operation)) fail('Invalid proposal change schema.');
    validateProposalPath(change.path);
    if (change.operation === 'write') {
      if (!validText(change.content) || Buffer.byteLength(change.content) > PROPOSAL_LIMITS.fileBytes)
        fail('Proposal file content is invalid text or exceeds the size limit.');
    } else if (Object.hasOwn(change, 'content')) fail('A deletion cannot contain file content.');
    const key = folded(change.path);
    if (seen.has(key)) fail('Proposal contains duplicate or case-aliased paths.');
    for (const prior of seen) {
      if (key.startsWith(`${prior}/`) || prior.startsWith(`${key}/`))
        fail('Proposal contains overlapping ancestor paths.');
    }
    seen.add(key);
  }
  return proposal;
}

async function ownedRoot(cwd, sourceRoot) {
  const supplied = resolve(cwd);
  const rootStat = await lstat(supplied);
  const root = await realpath(supplied);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink() || root !== supplied)
    fail('Editing requires a canonical managed worktree directory.');
  const source = await realpath(resolve(sourceRoot));
  if (root === source || within(source, root)) fail('Editing requires an isolated owned worktree.');
  const dotGit = await lstat(join(root, '.git')).catch(() => null);
  if (!dotGit?.isFile() || dotGit.isSymbolicLink()) fail('Editing requires an owned linked worktree.');
  const gitDir = (await git(root, ['rev-parse', '--absolute-git-dir'])).trim();
  let owner;
  try { owner = JSON.parse(await readFile(join(gitDir, OWNER_FILE), 'utf8')); }
  catch { fail('Missing managed worktree owner marker.'); }
  if (owner.root !== root || owner.sourceRoot !== source)
    fail('Managed worktree owner does not match its source and root.');
  const commonDir = async (directory) =>
    realpath(resolve(directory, (await git(directory, ['rev-parse', '--git-common-dir'])).trim()));
  if (await commonDir(root) !== await commonDir(source)) fail('Managed worktree source mismatch.');
  return root;
}

async function inspectPath(root, change) {
  let current = root;
  const parts = change.path.split('/');
  let existing;
  for (let i = 0; i < parts.length; i++) {
    const names = await readdir(current).catch((error) => {
      if (error.code === 'ENOENT') return [];
      throw error;
    });
    if (names.some((name) => folded(name) === folded(parts[i]) && name !== parts[i]))
      fail('Proposal path aliases an existing name with different case or Unicode spelling.');
    current = join(current, parts[i]);
    const stat = await lstat(current).catch((error) => {
      if (error.code === 'ENOENT') return null;
      throw error;
    });
    if (!stat) {
      if (change.operation === 'delete') fail('Proposal deletion requires an existing regular file.');
      return { target: join(root, ...parts), existing: null };
    }
    if (stat.isSymbolicLink()) fail('Proposal path contains a symlink or junction.');
    const canonical = await realpath(current);
    if (!within(root, canonical) || canonical !== current)
      fail('Proposal path failed canonical worktree containment.');
    if (i < parts.length - 1) {
      if (!stat.isDirectory()) fail('Proposal path has a non-directory ancestor.');
    } else {
      if (!stat.isFile() || stat.nlink > 1) fail('Proposal target must be a regular unshared file.');
      if (stat.size > PROPOSAL_LIMITS.fileBytes) fail('Existing proposal target exceeds the size limit.');
      const handle = await open(current, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
      try {
        const opened = await handle.stat();
        if (!opened.isFile() || opened.dev !== stat.dev || opened.ino !== stat.ino ||
            opened.size > PROPOSAL_LIMITS.fileBytes) fail('Proposal target changed while validating.');
        const data = Buffer.alloc(Math.min(opened.size + 1, PROPOSAL_LIMITS.fileBytes + 1));
        let length = 0;
        while (length < data.length) {
          const { bytesRead } = await handle.read(data, length, data.length - length, length);
          if (!bytesRead) break;
          length += bytesRead;
        }
        if (length > PROPOSAL_LIMITS.fileBytes || data.subarray(0, length).includes(0))
          fail('Existing proposal target is binary or exceeds the size limit.');
        try { new TextDecoder('utf-8', { fatal: true }).decode(data.subarray(0, length)); }
        catch { fail('Existing proposal target must be UTF-8 text.'); }
        existing = { data: data.subarray(0, length), mode: stat.mode & 0o777 };
      } finally { await handle.close(); }
    }
  }
  return { target: current, existing };
}

/**
 * The provider has read tools only. Apply its fully validated text proposal to the
 * retained owned task, never to the source. Local same-user filesystem races remain
 * outside this application boundary; every parent is checked again before writes.
 */
export async function applyProposal({ cwd, sourceRoot, expectedFingerprint, response }) {
  const proposal = parseProposal(response);
  const root = await ownedRoot(cwd, sourceRoot);
  if (await fingerprint(root) !== expectedFingerprint)
    fail('Task worktree changed during proposal generation; start a fresh task.');
  const plan = [];
  for (const change of proposal.changes) plan.push({ change, ...await inspectPath(root, change) });
  if (await fingerprint(root) !== expectedFingerprint)
    fail('Task worktree changed during proposal validation; start a fresh task.');
  const staged = [];
  try {
    for (const item of plan) {
      if (item.change.operation !== 'write') continue;
      await mkdir(dirname(item.target), { recursive: true, mode: 0o700 });
      // Reinspect after mkdir so no parent symlink/junction is followed by open.
      await inspectPath(root, item.change);
      const temporary = join(dirname(item.target), `.gemini-proposal-${randomBytes(16).toString('hex')}.tmp`);
      const handle = await open(temporary, 'wx', 0o600);
      item.temporary = temporary;
      staged.push(temporary);
      try {
        await handle.writeFile(item.change.content, 'utf8');
        await handle.sync();
      } finally { await handle.close(); }
      if (item.existing) await chmod(temporary, item.existing.mode);
    }
    // Check all original targets again before committing any prepared change.
    for (const item of plan) {
      const current = await inspectPath(root, item.change);
      if (Boolean(current.existing) !== Boolean(item.existing) ||
          (item.existing && (!current.existing.data.equals(item.existing.data) ||
            current.existing.mode !== item.existing.mode)))
        fail('Proposal target changed before writing; retained task requires inspection.');
    }
    for (const item of plan) {
      await inspectPath(root, item.change);
      if (item.change.operation === 'write') await rename(item.temporary, item.target);
      else await unlink(item.target);
    }
  } finally {
    await Promise.all(staged.map((path) => unlink(path).catch((error) => {
      if (error.code !== 'ENOENT') throw error;
    })));
  }
  return { summary: proposal.summary, changedFiles: proposal.changes.map((change) => change.path) };
}
