import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, writeFile, readFile, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { setTimeout as pause } from 'node:timers/promises';
import { JobStore } from '../plugins/gemini/scripts/lib/store.mjs';
import { statusJobs } from '../plugins/gemini/scripts/lib/jobs.mjs';
const exec = promisify(execFile);
const cli = fileURLToPath(new URL('../plugins/gemini/scripts/companion.mjs', import.meta.url));
const fake = fileURLToPath(new URL('./fixtures/fake-gemini.mjs', import.meta.url));
// Windows integration includes multiple native PowerShell DACL checks. Cold
// startup under the parallel suite can exceed 10 seconds; each operation keeps
// its runtime deadline, while the outer harness allows the full request to finish.
const integrationTimeoutMs = process.platform === 'win32' ? 60000 : 10000;
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'gemini-cli-root-'));
  const state = await mkdtemp(join(tmpdir(), 'gemini-cli-state-'));
  return {
    root,
    env: { ...process.env, GEMINI_PLUGIN_STATE_DIR: state, GEMINI_PLUGIN_BINARY: fake },
    state,
  };
}
async function call(f, args) {
  const { stdout } = await exec(process.execPath, [cli, ...args, '--cwd', f.root, '--json'], {
    env: f.env,
    timeout: integrationTimeoutMs,
  });
  return JSON.parse(stdout);
}

test('CLI request files keep shell text inert and return real structured result', async () => {
  const f = await fixture();
  const request = join(f.root, 'request.json');
  const marker = join(f.root, 'INJECTION');
  await writeFile(
    request,
    JSON.stringify({
      command: 'advisor',
      cwd: f.root,
      prompt: `Compare approaches $(touch ${marker})`,
      json: true,
    }),
    { mode: 0o600 },
  );
  const { stdout } = await exec(process.execPath, [cli, '--request', request], {
    env: f.env,
    timeout: integrationTimeoutMs,
  });
  const result = JSON.parse(stdout);
  assert.equal(result.status, 'completed');
  assert.equal(result.response, 'Verified answer.');
  assert.equal(result.runToken, undefined);
  assert.equal(result.resumeCommand, undefined);
  await assert.rejects(readFile(marker));
});

test('eligible continuations use the guarded plugin rather than unrestricted Gemini', async () => {
  const f = await fixture();
  const result = await call(f, ['rescue', 'investigate the synthetic failure']);
  assert.equal(result.status, 'completed');
  assert.equal(result.resumeCommand, `/gemini:rescue --resume ${result.id} <follow-up task>`);
  assert.equal(result.resumeDirectory, await realpath(f.root));
  assert.ok(!result.resumeCommand.startsWith('gemini '));
});

test('detached job survives launcher and cancels its running Gemini process', async () => {
  const f = await fixture();
  f.env.FAKE_CASE = 'hang';
  const job = await call(f, ['review', '--background']);
  assert.equal(job.status, 'queued');
  let status;
  for (let i = 0; i < 60; i++) {
    status = (await call(f, ['status', job.id]))[0];
    if (status.status === 'running') break;
    await pause(50);
  }
  assert.equal(status.status, 'running');
  const cancelled = await call(f, ['cancel', job.id]);
  assert.equal(cancelled.cancellationRequested, true);
  for (let i = 0; i < 60; i++) {
    status = (await call(f, ['status', job.id]))[0];
    if (status.status === 'cancelled') break;
    await pause(50);
  }
  assert.equal(status.status, 'cancelled');
});

test('setup distinguishes installation compatibility from authentication', async () => {
  const f = await fixture();
  const result = await call(f, ['setup']);
  assert.equal(result.supported, true);
  assert.match(result.authentication, /not checked/);
});

test('only a dead worker can be reconciled to an interrupted terminal record', async () => {
  const f = await fixture();
  const store = new JobStore(f.root, f.state);
  const dead = await store.create({ command: 'review' });
  await store.update(dead.id, {
    status: 'running',
    workerPid: 2147483647,
    createdAt: '2000-01-01T00:00:00Z',
  });
  assert.equal((await statusJobs(store, dead.id))[0].status, 'interrupted');
  assert.equal((await store.get(dead.id)).status, 'interrupted');
  const live = await store.create({ command: 'review' });
  await store.update(live.id, {
    status: 'running',
    workerPid: process.pid,
    createdAt: '2000-01-01T00:00:00Z',
  });
  assert.equal((await statusJobs(store, live.id))[0].status, 'unresponsive');
  assert.equal((await store.get(live.id)).status, 'running');
});
