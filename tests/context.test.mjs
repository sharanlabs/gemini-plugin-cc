import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink, lstat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
  resolveWorkspace,
  collectContext,
  createTaskWorktree,
  inspectTaskChanges,
  removeTaskWorktree,
} from '../plugins/gemini/scripts/lib/context.mjs';

const exec = promisify(execFile);
async function git(cwd, ...args) {
  return (await exec('git', ['-C', cwd, ...args], { encoding: 'utf8' })).stdout.trimEnd();
}
async function fixture(t, files = { 'app.js': 'export const value = 1;\n' }) {
  const outer = await mkdtemp(join(tmpdir(), 'gemini-context-test-'));
  t.after(() => rm(outer, { recursive: true, force: true }));
  const root = join(outer, 'repo');
  await mkdir(root);
  await git(root, 'init', '-b', 'main');
  await git(root, 'config', 'user.email', 'test@example.invalid');
  await git(root, 'config', 'user.name', 'Context Test');
  for (const [file, content] of Object.entries(files)) {
    await mkdir(join(root, file, '..'), { recursive: true });
    await writeFile(join(root, file), content);
  }
  await git(root, 'add', '.');
  await git(root, 'commit', '-m', 'initial');
  return { root, outer, destination: join(outer, 'task-worktree') };
}

test('resolveWorkspace resolves repository root from a nested directory', async (t) => {
  const { root } = await fixture(t);
  const nested = join(root, 'nested');
  await mkdir(nested);
  const result = await resolveWorkspace(nested);
  assert.equal(result.git, true);
  assert.equal(
    await git(result.root, 'rev-parse', '--show-toplevel'),
    await git(root, 'rev-parse', '--show-toplevel'),
  );
});

test('non-repository context is bounded and identifies its limitation', async (t) => {
  const { outer } = await fixture(t);
  const result = await collectContext({ cwd: outer, mode: 'ask', maxBytes: 180 });
  assert.equal(result.git, false);
  assert.match(result.text, /not a Git repository/i);
  assert.ok(Buffer.byteLength(result.text) <= 180);
});

test('review includes staged, unstaged and safe untracked source changes', async (t) => {
  const { root } = await fixture(t);
  await writeFile(join(root, 'app.js'), 'export const value = 2;\n');
  await git(root, 'add', 'app.js');
  await writeFile(join(root, 'app.js'), 'export const value = 3;\n');
  await writeFile(join(root, 'new.js'), 'export const added = true;\n');
  const result = await collectContext({ cwd: root, mode: 'review', focus: 'find regressions' });
  assert.equal(result.target, 'working-tree');
  assert.match(result.head, /^[a-f0-9]{40,64}$/);
  assert.match(result.text, /Staged changes/);
  assert.match(result.text, /Unstaged changes/);
  assert.match(result.text, /value = 2/);
  assert.match(result.text, /value = 3/);
  assert.match(result.text, /new\.js/);
  assert.match(result.text, /added = true/);
  assert.match(result.text, /find regressions/);
});

test('review filters credential files, symlinks and binary data and redacts recognizable secrets', async (t) => {
  const { root } = await fixture(t, {
    'app.js': 'export const value = 1;\n',
    '.env.production': 'PRIVATE=old\n',
  });
  await writeFile(join(root, '.env.production'), 'PRIVATE=do-not-send-env\n');
  await writeFile(join(root, 'private.pem'), 'do-not-send-private-key\n');
  await writeFile(join(root, 'payload.js'), Buffer.from([0, 1, 2, 3]));
  await symlink(join(root, '.env.production'), join(root, 'link.js'));
  await writeFile(
    join(root, 'app.js'),
    'const API_KEY = "do-not-send-token";\nconst header = "Bearer fake-bearer-credential";\n',
  );
  const result = await collectContext({ cwd: root, mode: 'review' });
  assert.doesNotMatch(result.text, /do-not-send|fake-bearer-credential/);
  assert.doesNotMatch(result.text, /PRIVATE=|PRIVATE KEY|\u0000/);
  assert.match(result.text, /REDACTED/);
  assert.match(result.text, /excluded|omitted/i);
});

test('branch reviews compare the merge base and include working changes', async (t) => {
  const { root } = await fixture(t);
  const common = await git(root, 'rev-parse', 'HEAD');
  await git(root, 'checkout', '-b', 'feature');
  await writeFile(join(root, 'feature.js'), 'export const feature = true;\n');
  await git(root, 'add', '.');
  await git(root, 'commit', '-m', 'feature');
  await git(root, 'checkout', 'main');
  await writeFile(join(root, 'base-only.js'), 'export const baseOnly = true;\n');
  await git(root, 'add', '.');
  await git(root, 'commit', '-m', 'base advances');
  await git(root, 'checkout', 'feature');
  await writeFile(join(root, 'app.js'), 'export const value = 9;\n');
  const result = await collectContext({ cwd: root, base: 'main', mode: 'review' });
  assert.match(result.target, /^branch:/);
  assert.match(result.text, new RegExp(common));
  assert.match(result.text, /feature = true/);
  assert.match(result.text, /value = 9/);
  assert.doesNotMatch(result.text, /baseOnly/);
});

test('review rejects invalid or option-like base refs', async (t) => {
  const { root } = await fixture(t);
  for (const base of ['--output=stolen', '--all', 'missing-ref', 'HEAD\0evil']) {
    await assert.rejects(collectContext({ cwd: root, base, mode: 'review' }), /base|reference/i);
  }
});

test('context enforces a byte cap even with multibyte content', async (t) => {
  const { root } = await fixture(t);
  await writeFile(join(root, 'app.js'), `const many = '${'🦊'.repeat(5000)}';\n`);
  const result = await collectContext({ cwd: root, mode: 'review', maxBytes: 300 });
  assert.equal(result.truncated, true);
  assert.ok(Buffer.byteLength(result.text) <= 300);
  assert.match(result.text, /truncated/i);
});

test('isolated task worktree preserves staged and unstaged source changes and safe untracked files', async (t) => {
  const { root, destination } = await fixture(t);
  await writeFile(join(root, 'app.js'), 'export const value = 2;\n');
  await git(root, 'add', 'app.js');
  await writeFile(join(root, 'app.js'), 'export const value = 3;\n');
  await writeFile(join(root, 'new.js'), 'export const added = true;\n');
  await writeFile(join(root, '.env.local'), 'SECRET=must-stay-in-source\n');
  const before = await git(root, 'status', '--porcelain=v1', '--untracked-files=all');
  const result = await createTaskWorktree({ cwd: root, destination });
  assert.equal(result.dirtyIncluded, true);
  assert.equal(await git(result.root, 'rev-parse', 'HEAD'), result.head);
  assert.equal(await git(result.root, 'show', ':app.js'), 'export const value = 2;');
  assert.equal(await readFile(join(result.root, 'app.js'), 'utf8'), 'export const value = 3;\n');
  assert.equal(await readFile(join(result.root, 'new.js'), 'utf8'), 'export const added = true;\n');
  await assert.rejects(lstat(join(result.root, '.env.local')), { code: 'ENOENT' });
  assert.equal(await git(root, 'status', '--porcelain=v1', '--untracked-files=all'), before);
  assert.equal(await readFile(join(root, 'app.js'), 'utf8'), 'export const value = 3;\n');
  await assert.rejects(
    removeTaskWorktree({ sourceRoot: root, root: result.root }),
    /dirty|changes/i,
  );
  assert.equal((await lstat(result.root)).isDirectory(), true);
});

test('worktree creation refuses credential changes, symlinks, occupied or nested destinations', async (t) => {
  const { root, outer, destination } = await fixture(t, {
    'app.js': 'one\n',
    '.env': 'SECRET=old\n',
  });
  await writeFile(join(root, '.env'), 'SECRET=new\n');
  await assert.rejects(createTaskWorktree({ cwd: root, destination }), /credential|sensitive/i);
  await git(root, 'checkout', '--', '.env');
  await symlink(join(root, '.env'), join(root, 'linked.js'));
  await git(root, 'add', 'linked.js');
  await assert.rejects(createTaskWorktree({ cwd: root, destination }), /symlink/i);
  await git(root, 'reset', '--', 'linked.js');
  await rm(join(root, 'linked.js'));
  await assert.rejects(createTaskWorktree({ cwd: root, destination: root }), /destination|source/i);
  await assert.rejects(
    createTaskWorktree({ cwd: root, destination: join(root, 'task') }),
    /destination|source/i,
  );
  await mkdir(join(outer, 'occupied'));
  await assert.rejects(
    createTaskWorktree({ cwd: root, destination: join(outer, 'occupied') }),
    /exist|occupied/i,
  );
});

test('inspection reports tracked and safe untracked task changes', async (t) => {
  const { root, destination } = await fixture(t);
  const task = await createTaskWorktree({ cwd: root, destination });
  await writeFile(join(task.root, 'app.js'), 'export const value = 7;\n');
  await writeFile(join(task.root, 'new.ts'), 'export const extra = 8;\n');
  const result = await inspectTaskChanges({ cwd: task.root });
  assert.deepEqual(result.changedFiles.sort(), ['app.js', 'new.ts']);
  assert.match(result.text, /value = 7/);
  assert.match(result.text, /extra = 8/);
});

test('removal only removes a clean worktree created by this module', async (t) => {
  const { root, outer, destination } = await fixture(t);
  await assert.rejects(removeTaskWorktree({ sourceRoot: root, root }), /source|managed|primary/i);
  const unmanaged = join(outer, 'unmanaged');
  await git(root, 'worktree', 'add', '--detach', unmanaged, 'HEAD');
  await assert.rejects(removeTaskWorktree({ sourceRoot: root, root: unmanaged }), /managed|owner/i);
  const task = await createTaskWorktree({ cwd: root, destination });
  await removeTaskWorktree({ sourceRoot: root, root: task.root });
  await assert.rejects(lstat(task.root), { code: 'ENOENT' });
});

test('ignored files block automatic task worktree removal', async (t) => {
  const { root, destination } = await fixture(t, { 'app.js': 'one\n', '.gitignore': '*.cache\n' });
  const task = await createTaskWorktree({ cwd: root, destination });
  await writeFile(join(task.root, 'result.cache'), 'valuable-result\n');
  await assert.rejects(removeTaskWorktree({ sourceRoot: root, root: task.root }), /dirty|changes/i);
  assert.equal(await readFile(join(task.root, 'result.cache'), 'utf8'), 'valuable-result\n');
});

test('task inspection includes commits made after the snapshot and removal preserves them', async (t) => {
  const { root, destination } = await fixture(t);
  const task = await createTaskWorktree({ cwd: root, destination });
  await writeFile(join(task.root, 'app.js'), 'export const value = 22;\n');
  await git(task.root, 'add', 'app.js');
  await git(task.root, 'commit', '-m', 'task implementation');
  const changes = await inspectTaskChanges({ cwd: task.root });
  assert.deepEqual(changes.changedFiles, ['app.js']);
  assert.match(changes.text, /value = 22/);
  await assert.rejects(removeTaskWorktree({ sourceRoot: root, root: task.root }), /commits|HEAD/i);
});

test('dirty snapshots preserve tracked binary modifications, deletions and new staged files exactly', async (t) => {
  const { root, destination } = await fixture(t, {
    'app.js': 'one\n',
    'remove.js': 'remove\n',
    'asset.bin': Buffer.from([0, 1, 2, 3]),
  });
  await writeFile(join(root, 'asset.bin'), Buffer.from([0, 4, 5, 6]));
  await rm(join(root, 'remove.js'));
  await writeFile(join(root, 'staged.js'), 'staged\n');
  await git(root, 'add', '-A');
  await writeFile(join(root, 'asset.bin'), Buffer.from([0, 7, 8, 9]));
  await writeFile(join(root, 'staged.js'), 'unstaged\n');
  const task = await createTaskWorktree({ cwd: root, destination });
  assert.equal(
    await git(task.root, 'diff', '--cached', '--binary', '--full-index'),
    await git(root, 'diff', '--cached', '--binary', '--full-index'),
  );
  assert.equal(
    await git(task.root, 'diff', '--binary', '--full-index'),
    await git(root, 'diff', '--binary', '--full-index'),
  );
  assert.deepEqual(await readFile(join(task.root, 'asset.bin')), Buffer.from([0, 7, 8, 9]));
});

test('context preserves changes even when the tracked filename inventory is large', async (t) => {
  const files = { 'app.js': 'one\n' };
  for (let i = 0; i < 300; i += 1) files[`file-with-longish-name-${i}.js`] = 'unchanged\n';
  const { root } = await fixture(t, files);
  await writeFile(join(root, 'app.js'), 'const regression = true;\n');
  const result = await collectContext({ cwd: root, mode: 'review', maxBytes: 2000 });
  assert.match(result.text, /regression = true/);
  assert.ok(Buffer.byteLength(result.text) <= 2000);
});
