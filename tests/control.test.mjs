import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, stat, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseArgs, validateRequest } from '../plugins/gemini/scripts/lib/request.mjs';
import { JobStore } from '../plugins/gemini/scripts/lib/store.mjs';

test('request parser preserves shell metacharacters as inert text', () => {
  const request = parseArgs(['adversarial-review', '--focus', '$(touch /tmp/oops) `id`', '--background', '--base', 'main']);
  assert.equal(request.focus, '$(touch /tmp/oops) `id`');
  assert.equal(request.background, true);
  assert.equal(request.base, 'main');
});

test('invalid option combinations fail before any execution', () => {
  for (const args of [
    ['review', '--edit'], ['rescue', '--resume', 'job-123', '--fresh'],
    ['rescue', '--allow-shell'], ['ask', '--timeout-ms', 'NaN'],
    ['ask', '--unknown'], ['review', '--base', '-evil'],
    ['cancel'], ['apply'], ['clean'],
  ]) assert.throws(() => validateRequest(parseArgs(args)));
  assert.throws(() => validateRequest({ command: 'ask', apiKey: 'not-supported' }), /Unknown/);
  assert.throws(() => validateRequest({ command: 'ask', prompt: 'hello', background: 'false' }), /boolean/);
});

test('defaults are bounded and continuation is explicit', () => {
  const r = validateRequest(parseArgs(['rescue', '--edit', '--allow-shell', '--sandbox', '--prompt', 'fix regression']));
  assert.equal(r.timeoutMs, 600000);
  assert.equal(r.edit, true);
  assert.equal(r.allowShell, true);
  assert.equal(r.sandbox, true);
  assert.equal(validateRequest({command:'ask', prompt:'hi'}).background, false);
});

test('private atomic jobs are scoped to canonical workspace and cannot traverse', async () => {
  const home = await mkdtemp(join(tmpdir(), 'gemini-store-'));
  const a = new JobStore('/one', home);
  const b = new JobStore('/two', home);
  const job = await a.create({command:'review', workspace:'/one'});
  await a.update(job.id, {status:'running', progress:'reviewing'});
  assert.equal((await a.get(job.id)).status, 'running');
  assert.equal((await a.list()).length, 1);
  await assert.rejects(b.get(job.id), /not found/);
  await assert.rejects(a.get('../outside'), /Invalid job/);
  if (process.platform !== 'win32') assert.equal((await stat(a.jobPath(job.id))).mode & 0o777, 0o600);
  assert.equal(JSON.parse(await readFile(a.jobPath(job.id), 'utf8')).schema, 1);
});

test('exclusive workspace locks cannot be stolen by a second active writer', async () => {
  const home = await mkdtemp(join(tmpdir(), 'gemini-lock-'));
  const a = new JobStore('/one', home);
  const unlock = await a.lock('apply');
  await assert.rejects(a.lock('apply'), /already active/);
  await unlock();
  const unlock2 = await a.lock('apply');
  await unlock2();
});

test('store refuses symlinked directories', async () => {
  const {symlink} = await import('node:fs/promises');
  const home = await mkdtemp(join(tmpdir(), 'gemini-link-'));
  await mkdir(join(home, 'real'));
  await symlink(join(home,'real'), join(home,'linked'));
  const store = new JobStore('/one', join(home,'linked'));
  await assert.rejects(store.create({command:'review'}), /symlink/i);
});
