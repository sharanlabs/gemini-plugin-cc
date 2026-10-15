import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, mkdir, symlink, rm, lstat, link } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createTaskWorktree } from '../plugins/gemini/scripts/lib/context.mjs';
import { fingerprint } from '../plugins/gemini/scripts/lib/patch.mjs';
import {
  parseProposal,
  applyProposal,
  validateProposalPath,
  PROPOSAL_LIMITS,
} from '../plugins/gemini/scripts/lib/proposal.mjs';

const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
const proposal = (changes, summary = 'Correct the implementation.') =>
  JSON.stringify({ summary, changes });
async function fixture(t) {
  const base = await mkdtemp(join(tmpdir(), 'gemini-proposal-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const sourceRoot = join(base, 'source');
  await mkdir(sourceRoot);
  git(sourceRoot, 'init', '-q');
  git(sourceRoot, 'config', 'user.name', 'Test');
  git(sourceRoot, 'config', 'user.email', 'test@example.invalid');
  await writeFile(join(sourceRoot, 'app.js'), 'export const value = 1;\n');
  await writeFile(join(sourceRoot, 'obsolete.txt'), 'obsolete\n');
  git(sourceRoot, 'add', '.');
  git(sourceRoot, 'commit', '-qm', 'initial');
  const task = await createTaskWorktree({ cwd: sourceRoot, destination: join(base, 'task') });
  return { base, sourceRoot, cwd: task.root, expectedFingerprint: await fingerprint(task.root) };
}

test('strict proposal schema and byte bounds reject malformed responses', () => {
  for (const response of [
    'not JSON', '{}', '[]', proposal([], ''),
    JSON.stringify({ summary: 'x', changes: [], command: 'run' }),
    proposal([{ path: 'app.js', operation: 'write' }]),
    proposal([{ path: 'app.js', operation: 'delete', content: '' }]),
    proposal([{ path: 'app.js', operation: 'write', content: '\0' }]),
    proposal([{ path: 'app.js', operation: 'write', content: '\ud800' }]),
    proposal([{ path: 'app.js', operation: 'write', content: '', mode: '777' }]),
    ' '.repeat(PROPOSAL_LIMITS.responseBytes + 1),
    proposal(Array.from({ length: PROPOSAL_LIMITS.files + 1 }, (_, i) => ({ path: `${i}.js`, operation: 'delete' }))),
  ]) assert.throws(() => parseProposal(response));
  assert.deepEqual(parseProposal(proposal([])), { summary: 'Correct the implementation.', changes: [] });
});

test('portable paths reject traversal, aliases, Windows devices and sensitive configuration', () => {
  for (const path of [
    '', '/root.js', '../root.js', 'a/../root.js', './app.js', 'a//b', 'a/',
    'C:relative', 'C:/root.js', '\\server\\file', 'dir\\file', 'app.js:stream',
    'NUL', 'con.txt', 'AUX/file', 'COM1.js', 'lpt9', 'COM¹.txt', 'CONIN$', 'conout$.txt', 'a./b', 'a /b',
    'a\n.js', 'a?.js', '.GIT/config', '.claude/settings.json', '.gemini/settings.json',
    '.codex/config.toml', '.env.local', 'folder/credentials.json', 'keys/test.pem',
    '.gnupg/config', 'auth.json', 'service-account.json', 'node_modules/a.js',
    'oauth_creds.json', 'nested/google_accounts.json', 'APPLICATION_DEFAULT_CREDENTIALS.JSON',
    '.envsecret', 'nested/.pypirc', '.boto', 'id_dsa', 'id_ecdsa',
  ]) assert.throws(() => validateProposalPath(path), undefined, path);
  for (const path of ['src/app.js', 'src/café.js', 'docs/说明.md', '.gitignore'])
    assert.equal(validateProposalPath(path), path);
  assert.throws(() => parseProposal(proposal([
    { path: 'app.js', operation: 'delete' }, { path: 'APP.js', operation: 'delete' },
  ])), /duplicate|alias/i);
  assert.throws(() => parseProposal(proposal([
    { path: 'new', operation: 'write', content: '' }, { path: 'new/file.js', operation: 'write', content: '' },
  ])), /ancestor|overlap/i);
});

test('validated add, edit and delete change only the owned worktree', async (t) => {
  const fixtureOptions = await fixture(t);
  const { cwd, sourceRoot } = fixtureOptions;
  const sourceBefore = await fingerprint(sourceRoot);
  const result = await applyProposal({ ...fixtureOptions, response: proposal([
    { path: 'app.js', operation: 'write', content: 'export const value = 2;\n' },
    { path: 'src/说明.js', operation: 'write', content: 'export default "new";\n' },
    { path: 'obsolete.txt', operation: 'delete' },
  ]) });
  assert.equal(result.summary, 'Correct the implementation.');
  assert.deepEqual(result.changedFiles, ['app.js', 'src/说明.js', 'obsolete.txt']);
  assert.equal(await readFile(join(cwd, 'app.js'), 'utf8'), 'export const value = 2;\n');
  assert.equal(await readFile(join(cwd, 'src/说明.js'), 'utf8'), 'export default "new";\n');
  await assert.rejects(lstat(join(cwd, 'obsolete.txt')), { code: 'ENOENT' });
  assert.equal(await fingerprint(sourceRoot), sourceBefore);
  assert.equal(await readFile(join(sourceRoot, 'obsolete.txt'), 'utf8'), 'obsolete\n');
});

test('an invalid later change leaves every file and directory untouched', async (t) => {
  const options = await fixture(t);
  await assert.rejects(applyProposal({ ...options, response: proposal([
    { path: 'new/nested.js', operation: 'write', content: 'new\n' },
    { path: 'obsolete.txt', operation: 'delete' },
    { path: 'missing.txt', operation: 'delete' },
  ]) }), /exist|missing/i);
  assert.equal(await fingerprint(options.cwd), options.expectedFingerprint);
  await assert.rejects(lstat(join(options.cwd, 'new')), { code: 'ENOENT' });
});

test('task drift and mismatched or missing ownership refuse proposals', async (t) => {
  const options = await fixture(t);
  const response = proposal([{ path: 'app.js', operation: 'write', content: 'changed\n' }]);
  await writeFile(join(options.cwd, 'app.js'), 'external change\n');
  await assert.rejects(applyProposal({ ...options, response }), /changed|fingerprint/i);
  await assert.rejects(applyProposal({ ...options, cwd: options.sourceRoot, response }), /owned|managed|worktree/i);
  await assert.rejects(applyProposal({ ...options, sourceRoot: options.base, response }), /owned|source|managed/i);
});

test('symlink or junction ancestors and case aliases cannot redirect writes', async (t) => {
  const options = await fixture(t);
  const outside = join(options.base, 'outside');
  await mkdir(outside);
  await writeFile(join(outside, 'target.js'), 'outside\n');
  const expectedFingerprint = await fingerprint(options.cwd);
  await symlink(outside, join(options.cwd, 'escape'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(applyProposal({ ...options, expectedFingerprint, response: proposal([
    { path: 'escape/target.js', operation: 'write', content: 'bad\n' },
  ]) }), /symlink|junction|canonical|directory|changed/i);
  assert.equal(await readFile(join(outside, 'target.js'), 'utf8'), 'outside\n');
  await rm(join(options.cwd, 'escape'));
  await assert.rejects(applyProposal({ ...options, expectedFingerprint, response: proposal([
    { path: 'APP.js', operation: 'write', content: 'bad\n' },
  ]) }), /alias|case/i);
});

test('binary existing files and oversized content cannot be replaced or deleted', async (t) => {
  const options = await fixture(t);
  await writeFile(join(options.cwd, 'binary.dat'), Buffer.from([1, 0, 2]));
  const expectedFingerprint = await fingerprint(options.cwd);
  for (const operation of ['write', 'delete']) {
    const change = { path: 'binary.dat', operation };
    if (operation === 'write') change.content = 'text';
    await assert.rejects(applyProposal({ ...options, expectedFingerprint, response: proposal([change]) }), /text|binary/i);
  }
  assert.throws(() => parseProposal(proposal([
    { path: 'app.js', operation: 'write', content: 'x'.repeat(PROPOSAL_LIMITS.fileBytes + 1) },
  ])), /size|limit|large/i);
});

test('directories and shared hardlinks refuse before any proposal mutation', async (t) => {
  const options = await fixture(t);
  await mkdir(join(options.cwd, 'directory'));
  await link(join(options.cwd, 'app.js'), join(options.cwd, 'alias.js'));
  const expectedFingerprint = await fingerprint(options.cwd);
  for (const path of ['directory', 'alias.js']) {
    await assert.rejects(applyProposal({ ...options, expectedFingerprint, response: proposal([
      { path: 'new.js', operation: 'write', content: 'must not be created\n' },
      { path, operation: 'write', content: 'replacement\n' },
    ]) }), /regular|unshared/i);
    await assert.rejects(lstat(join(options.cwd, 'new.js')), { code: 'ENOENT' });
  }
});
