import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { JobStore } from '../plugins/gemini/scripts/lib/store.mjs';
import { startJob, applyJob } from '../plugins/gemini/scripts/lib/jobs.mjs';
import { fingerprint } from '../plugins/gemini/scripts/lib/patch.mjs';

const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
async function fixture(t) {
  const base = await mkdtemp(join(tmpdir(), 'gemini-proposal-job-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const root = join(base, 'source with spaces');
  await mkdir(root);
  git(root, 'init', '-q');
  git(root, 'config', 'user.name', 'Test');
  git(root, 'config', 'user.email', 'test@example.invalid');
  await writeFile(join(root, 'app.js'), 'export const value = 1;\n');
  git(root, 'add', '.');
  git(root, 'commit', '-qm', 'initial');
  return { root, store: new JobStore(root, join(base, 'state')) };
}
const reply = (value, summary = 'Fixed value. Tests require caller verification.') => ({
  response: JSON.stringify({ summary, changes: [
    { path: 'app.js', operation: 'write', content: `export const value = ${value};\n` },
  ] }),
  sessionId: 'session-proposal', model: 'gemini-test', stats: { total_tokens: 13 }, exitCode: 0,
});

test('Windows proposal lifecycle retains source staging and persists the provider metadata', async (t) => {
  const { root, store } = await fixture(t);
  await writeFile(join(root, 'app.js'), 'export const value = 2;\n');
  git(root, 'add', '.');
  const staged = git(root, 'diff', '--cached');
  const before = await fingerprint(root);
  const job = await startJob({ command: 'rescue', cwd: root, edit: true, prompt: 'fix value' }, {
    store, platform: 'win32', runner: async (options) => {
      assert.equal(options.mode, 'edit-proposal');
      assert.notEqual(options.cwd, root);
      assert.match(options.prompt, /exactly one JSON object/);
      assert.match(options.prompt, /read-only tools/);
      return reply(3);
    },
  });
  assert.equal(job.status, 'completed', job.error);
  assert.equal(job.editBackend, 'proposal');
  assert.equal(job.sessionId, 'session-proposal');
  assert.equal(job.model, 'gemini-test');
  assert.equal(job.stats.total_tokens, 13);
  assert.equal(job.response, 'Fixed value. Tests require caller verification.');
  assert.equal(await fingerprint(root), before);
  assert.equal(await readFile(join(job.worktree, 'app.js'), 'utf8'), 'export const value = 3;\n');
  await applyJob(store, job.id);
  assert.equal(await readFile(join(root, 'app.js'), 'utf8'), 'export const value = 3;\n');
  assert.equal(git(root, 'diff', '--cached'), staged);
});

test('proposal continuation uses the same backend, control directory and worktree baseline', async (t) => {
  const { root, store } = await fixture(t);
  const prior = await startJob({ command: 'rescue', cwd: root, edit: true, prompt: 'fix value' }, {
    store, platform: 'win32', runner: async () => reply(2),
  });
  assert.equal(prior.status, 'completed', prior.error);
  const next = await startJob({ command: 'rescue', cwd: root, edit: true, resume: prior.id, prompt: 'refine value' }, {
    store, platform: 'win32', runner: async (options) => {
      assert.equal(options.resume, prior.sessionId);
      assert.equal(options.executionDirectory, prior.executionDirectory);
      assert.equal(options.cwd, prior.worktree);
      assert.equal(options.mode, 'edit-proposal');
      return reply(3, 'Refined correction.');
    },
  });
  assert.equal(next.status, 'completed', next.error);
  assert.equal(next.baselineTree, prior.baselineTree);
  assert.equal(next.worktreeOwner, prior.worktreeOwner);
  assert.equal(next.editBackend, 'proposal');
  await assert.rejects(startJob({ command: 'rescue', cwd: root, edit: true, resume: next.id, prompt: 'continue' }, {
    store, platform: 'darwin', runner: async () => { throw new Error('must not run'); },
  }), /same implementation backend/);
  await applyJob(store, next.id);
  assert.equal(await readFile(join(root, 'app.js'), 'utf8'), 'export const value = 3;\n');
});

test('malformed provider batches and unapproved task mutations fail without touching source', async (t) => {
  const { root, store } = await fixture(t);
  const before = await fingerprint(root);
  for (const malicious of [false, true]) {
    const job = await startJob({ command: 'rescue', cwd: root, edit: true, prompt: 'fix' }, {
      store, platform: 'win32', runner: async (options) => {
        if (malicious) await writeFile(join(options.cwd, 'app.js'), 'unexpected provider mutation\n');
        return malicious ? reply(3) : { ...reply(3), response: 'not a JSON proposal' };
      },
    });
    assert.equal(job.status, 'failed');
    assert.equal(job.errorCode, 'INVALID_EDIT_PROPOSAL');
    assert.ok(job.worktree);
    assert.equal(await fingerprint(root), before);
    await assert.rejects(applyJob(store, job.id), /completed retained/);
    if (!malicious) assert.equal(await fingerprint(job.worktree), before);
  }
});
