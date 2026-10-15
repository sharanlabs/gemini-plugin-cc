import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { JobStore } from '../plugins/gemini/scripts/lib/store.mjs';
import {
  startJob,
  executeJob,
  applyJob,
  cancelJob,
  buildPrompt,
} from '../plugins/gemini/scripts/lib/jobs.mjs';
const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'gemini-job-repo-'));
  git(root, 'init', '-q');
  git(root, 'config', 'user.name', 'Test');
  git(root, 'config', 'user.email', 'test@example.invalid');
  await writeFile(join(root, 'app.js'), 'export const value = 1;\n');
  git(root, 'add', '.');
  git(root, 'commit', '-qm', 'initial');
  return { root, state: await mkdtemp(join(tmpdir(), 'gemini-job-state-')) };
}
const reply = {
  response: 'Independent findings',
  sessionId: 'session-123',
  model: 'gemini-test',
  stats: { total_tokens: 12 },
  exitCode: 0,
};
test('review persists separate Gemini session and bounded outcome', async () => {
  const { root, state } = await fixture();
  const store = new JobStore(root, state);
  const job = await startJob(
    { command: 'adversarial-review', cwd: root, focus: 'race conditions' },
    {
      store,
      runner: async (args) => {
        assert.match(args.prompt, /counterexample/i);
        assert.match(args.prompt, /race conditions/);
        return reply;
      },
    },
  );
  assert.equal(job.status, 'completed');
  assert.equal(job.sessionId, 'session-123');
  assert.equal(job.model, 'gemini-test');
  assert.equal((await store.get(job.id)).response, 'Independent findings');
  assert.equal(git(root, 'status', '--porcelain'), '');
});
test('implementation runs in a worktree, then applies only incremental changes', async () => {
  const { root, state } = await fixture();
  const store = new JobStore(root, state);
  await writeFile(join(root, 'app.js'), 'export const value = 2;\n');
  git(root, 'add', '.');
  const staged = git(root, 'diff', '--cached');
  const job = await startJob(
    { command: 'rescue', cwd: root, prompt: 'fix value', edit: true },
    {
      store,
      runner: async (args) => {
        assert.notEqual(args.cwd, root);
        if (process.platform === 'win32') {
          assert.equal(args.mode, 'edit-proposal');
          return {
            ...reply,
            response: JSON.stringify({ summary: reply.response, changes: [
              { path: 'app.js', operation: 'write', content: 'export const value = 3;\n' },
            ] }),
          };
        }
        assert.equal(args.mode, 'edit');
        await writeFile(join(args.cwd, 'app.js'), 'export const value = 3;\n');
        return reply;
      },
    },
  );
  assert.equal(job.status, 'completed');
  assert.equal(await readFile(join(root, 'app.js'), 'utf8'), 'export const value = 2;\n');
  await applyJob(store, job.id);
  assert.equal(await readFile(join(root, 'app.js'), 'utf8'), 'export const value = 3;\n');
  assert.equal(git(root, 'diff', '--cached'), staged);
  await assert.rejects(applyJob(store, job.id), /already applied/);
});
test('failed and cancelled work retain honest states', async () => {
  const { root, state } = await fixture();
  const store = new JobStore(root, state);
  const failed = await startJob(
    { command: 'ask', cwd: root, prompt: 'analyze' },
    {
      store,
      runner: async () => {
        throw new Error('upstream failed');
      },
    },
  );
  assert.equal(failed.status, 'failed');
  const queued = await store.create({
    request: { command: 'ask', cwd: root, prompt: 'analyze' },
    command: 'ask',
  });
  await cancelJob(store, queued.id);
  const cancelled = await executeJob(store, queued.id, {
    runner: async () => {
      throw new Error('must not run');
    },
  });
  assert.equal(cancelled.status, 'cancelled');
});
test('resume requires prior completed session in same mode', async () => {
  const { root, state } = await fixture();
  const store = new JobStore(root, state);
  const prior = await startJob(
    { command: 'rescue', cwd: root, prompt: 'investigate' },
    { store, runner: async () => reply },
  );
  const next = await startJob(
    { command: 'rescue', cwd: root, prompt: 'dig deeper', resume: prior.id },
    {
      store,
      runner: async (args) => {
        assert.equal(args.resume, 'session-123');
        assert.equal(args.executionDirectory, prior.executionDirectory);
        return reply;
      },
    },
  );
  assert.equal(next.status, 'completed');
  assert.equal(next.executionDirectory, prior.executionDirectory);
  await assert.rejects(
    startJob(
      { command: 'rescue', cwd: root, prompt: 'edit', edit: true, resume: prior.id },
      { store, runner: async () => reply },
    ),
    /mode/,
  );
});
test('a transfer continues through the confined plugin rescue session', async () => {
  const { root, state } = await fixture();
  const store = new JobStore(root, state);
  const prior = await startJob(
    { command: 'transfer', cwd: root, prompt: 'Investigate this handoff' },
    { store, runner: async () => reply },
  );
  assert.ok(prior.executionDirectory);
  const continued = await startJob(
    { command: 'rescue', cwd: root, prompt: 'Continue investigation', resume: prior.id },
    {
      store,
      runner: async (options) => {
        assert.equal(options.resume, prior.sessionId);
        assert.equal(options.executionDirectory, prior.executionDirectory);
        return reply;
      },
    },
  );
  assert.equal(continued.status, 'completed');
});
test('a legacy session without a retained execution directory refuses continuation', async () => {
  const { root, state } = await fixture();
  const store = new JobStore(root, state);
  const prior = await store.create({
    command: 'rescue',
    request: { edit: false },
    status: 'completed',
    sessionId: 'legacy',
  });
  await store.update(prior.id, { status: 'completed' });
  const continued = await startJob(
    { command: 'rescue', cwd: root, prompt: 'Continue investigation', resume: prior.id },
    {
      store,
      runner: async () => {
        throw new Error('Legacy session must never run');
      },
    },
  );
  assert.equal(continued.status, 'failed');
  assert.match(continued.error, /older session/);
});
test('specialists require evidence and distinguish uncertainty', () => {
  const prompt = buildPrompt({ command: 'adversarial-review', focus: 'auth' }, 'diff context');
  assert.match(prompt, /independent/i);
  assert.match(prompt, /evidence/i);
  assert.match(prompt, /uncertainty/i);
  assert.match(prompt, /diff context/);
});

test('concurrent continuations cannot mutate the same Gemini session', async () => {
  const { root, state } = await fixture();
  const store = new JobStore(root, state);
  const prior = await startJob(
    { command: 'rescue', cwd: root, prompt: 'investigate' },
    { store, runner: async () => reply },
  );
  let announce;
  const started = new Promise((accept) => {
    announce = accept;
  });
  let release;
  const held = new Promise((accept) => {
    release = accept;
  });
  const first = startJob(
    { command: 'rescue', cwd: root, prompt: 'continue', resume: prior.id },
    {
      store,
      runner: async () => {
        announce();
        await held;
        return reply;
      },
    },
  );
  await started;
  try {
    const second = await startJob(
      { command: 'rescue', cwd: root, prompt: 'also continue', resume: prior.id },
      {
        store,
        runner: async () => {
          throw new Error('second runner must not start');
        },
      },
    );
    assert.equal(second.status, 'failed');
    assert.match(second.error, /already active/);
  } finally {
    release();
  }
  assert.equal((await first).status, 'completed');
});

test('failed implementation retains its recorded worktree for inspection', async () => {
  const { root, state } = await fixture();
  const store = new JobStore(root, state);
  const job = await startJob(
    { command: 'rescue', cwd: root, prompt: 'fix', edit: true },
    {
      store,
      runner: async (options) => {
        await writeFile(join(options.cwd, '.env'), 'FIXTURE=not-a-real-secret\n');
        return reply;
      },
    },
  );
  assert.equal(job.status, 'failed');
  assert.ok(job.worktree);
  assert.equal(await readFile(join(job.worktree, '.env'), 'utf8'), 'FIXTURE=not-a-real-secret\n');
  await assert.rejects(readFile(join(root, '.env')));
});
