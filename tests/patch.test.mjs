import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  captureTree,
  fingerprint,
  makePatch,
  applyPatch,
} from '../plugins/gemini/scripts/lib/patch.mjs';
const git = (cwd, ...args) =>
  execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
async function repo() {
  const root = await mkdtemp(join(tmpdir(), 'gemini-patch-'));
  git(root, 'init', '-q');
  git(root, 'config', 'user.name', 'Test');
  git(root, 'config', 'user.email', 'test@example.invalid');
  await writeFile(join(root, 'a.txt'), 'original\n');
  git(root, 'add', '.');
  git(root, 'commit', '-qm', 'init');
  return root;
}
test('incremental apply preserves existing staged and unstaged source changes', async () => {
  const root = await repo();
  await writeFile(join(root, 'a.txt'), 'user staged\n');
  git(root, 'add', '.');
  await writeFile(join(root, 'a.txt'), 'user staged\nuser unstaged\n');
  const before = await fingerprint(root);
  const base = await captureTree(root);
  const staged = git(root, 'diff', '--cached');
  await writeFile(join(root, 'a.txt'), 'user staged\nuser unstaged\ngemini fix\n');
  await writeFile(join(root, 'new.txt'), 'new file\n');
  const patch = await makePatch(root, base);
  await writeFile(join(root, 'a.txt'), 'user staged\nuser unstaged\n');
  const { unlink } = await import('node:fs/promises');
  await unlink(join(root, 'new.txt'));
  await applyPatch({ cwd: root, patch, expectedFingerprint: before });
  assert.equal(await readFile(join(root, 'new.txt'), 'utf8'), 'new file\n');
  assert.equal(git(root, 'diff', '--cached'), staged);
  assert.match(await readFile(join(root, 'a.txt'), 'utf8'), /gemini fix/);
});
test('apply rejects checkout drift and credential or symlink changes', async () => {
  const root = await repo();
  const before = await fingerprint(root);
  const base = await captureTree(root);
  await writeFile(join(root, 'a.txt'), 'gemini\n');
  const patch = await makePatch(root, base);
  await writeFile(join(root, 'a.txt'), 'other developer\n');
  await assert.rejects(applyPatch({ cwd: root, patch, expectedFingerprint: before }), /changed/);
  await writeFile(join(root, '.env'), 'SECRET=bad\n');
  await assert.rejects(captureTree(root), /sensitive/i);
});
test('empty patch is represented accurately', async () => {
  const root = await repo();
  const base = await captureTree(root);
  assert.equal(await makePatch(root, base), '');
});

test('staged deletions remain part of the implementation patch', async () => {
  const root = await repo();
  const base = await captureTree(root);
  git(root, 'rm', 'a.txt');
  assert.match(await makePatch(root, base), /deleted file mode/);
});

test('symlinked ancestors cannot read outside repository', async () => {
  const { rm, symlink } = await import('node:fs/promises');
  const root = await repo();
  await mkdir(join(root, 'nested'));
  await writeFile(join(root, 'nested', 'inside.txt'), 'safe\n');
  git(root, 'add', '.');
  git(root, 'commit', '-qm', 'nested');
  const base = await captureTree(root);
  const outside = await mkdtemp(join(tmpdir(), 'gemini-outside-'));
  await writeFile(join(outside, 'inside.txt'), 'outside private content\n');
  await rm(join(root, 'nested'), { recursive: true });
  await symlink(outside, join(root, 'nested'));
  await assert.rejects(makePatch(root, base), /symlink/i);
});

test('unstaged directory deletion produces a deletion patch', async () => {
  const { rm } = await import('node:fs/promises');
  const root = await repo();
  await mkdir(join(root, 'nested'));
  await writeFile(join(root, 'nested', 'inside.txt'), 'file\n');
  git(root, 'add', '.');
  git(root, 'commit', '-qm', 'nested');
  const base = await captureTree(root);
  await rm(join(root, 'nested'), { recursive: true });
  assert.match(await makePatch(root, base), /deleted file mode/);
});

test('unchanged tracked assistant settings are preserved as opaque Git objects', async () => {
  const root = await repo();
  await mkdir(join(root, '.claude'));
  await writeFile(join(root, '.claude', 'settings.json'), '{}\n');
  git(root, 'add', '.');
  git(root, 'commit', '-qm', 'assistant settings');
  const base = await captureTree(root);
  await writeFile(join(root, 'a.txt'), 'implementation\n');
  const patch = await makePatch(root, base);
  assert.match(patch, /implementation/);
  assert.doesNotMatch(patch, /\.claude/);
  await writeFile(join(root, '.claude', 'settings.json'), '{"changed":true}\n');
  await assert.rejects(captureTree(root), /settings.*changed/i);
});
