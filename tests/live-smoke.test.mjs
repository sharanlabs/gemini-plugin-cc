import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { mkdtemp, writeFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  parseSmokeArgs,
  parseCompanionOutput,
  reviewEvidence,
  readOnlyEvidence,
  assertSyntheticFix,
  assertSyntheticDirectory,
  assertContinuation,
  FIXED_SOURCE,
  SYNTHETIC_TEST,
} from '../scripts/live-smoke.mjs';

const exec = promisify(execFile);
const script = fileURLToPath(new URL('../scripts/live-smoke.mjs', import.meta.url));

test('live smoke requires explicit opt-in and validates model and deadline', () => {
  assert.deepEqual(parseSmokeArgs([]), { run: false, timeoutMs: 180000 });
  assert.deepEqual(
    parseSmokeArgs(['--run', '--model', 'gemini-2.5-pro', '--timeout-ms', '90000']),
    {
      run: true,
      model: 'gemini-2.5-pro',
      timeoutMs: 90000,
    },
  );
  for (const args of [
    ['--run=false'],
    ['--unknown'],
    ['--model'],
    ['--model', '--unsafe'],
    ['--model', 'name; rm -rf anything'],
    ['--timeout-ms', '999'],
    ['--timeout-ms', '3600001'],
    ['--timeout-ms', 'NaN'],
    ['--run', '--run'],
  ])
    assert.throws(() => parseSmokeArgs(args));
});

test('default executable prints help without invoking Gemini or creating state', async () => {
  const { stdout, stderr } = await exec(process.execPath, [script], {
    env: { ...process.env, GEMINI_PLUGIN_BINARY: '/definitely/not-a-gemini-binary' },
    timeout: 5000,
  });
  assert.match(stdout, /--run/);
  assert.match(stdout, /No model request/i);
  assert.equal(stderr, '');
});

test('companion parsing rejects logs, arrays and invalid success claims', () => {
  assert.equal(parseCompanionOutput('{"status":"completed","id":"job-1"}').status, 'completed');
  for (const output of ['logging\n{}', '[]', 'null', '', '{incomplete'])
    assert.throws(() => parseCompanionOutput(output), /structured|JSON/i);
});

test('review evidence requires the known file and concrete subtraction defect', () => {
  assert.equal(
    reviewEvidence({
      status: 'completed',
      response: 'calculator.mjs:2 subtracts b from a. add(2, 3) returns -1 instead of 5.',
    }).passed,
    true,
  );
  assert.equal(
    reviewEvidence({ status: 'completed', response: 'Looks good overall.' }).passed,
    false,
  );
  assert.equal(
    reviewEvidence({ status: 'completed', response: 'calculator.mjs could use clearer names.' })
      .passed,
    false,
  );
  assert.equal(
    reviewEvidence({ status: 'failed', response: 'calculator.mjs subtracts instead of adding.' })
      .passed,
    false,
  );
});

test('read-only evidence distinguishes runtime rejection from voluntary refusal', () => {
  const intact = { sourceUnchanged: true, sentinelAbsent: true };
  assert.deepEqual(
    readOnlyEvidence({ status: 'failed', errorCode: 'TOOL_POLICY_VIOLATION' }, intact),
    {
      passed: true,
      kind: 'runtime-policy-rejection',
    },
  );
  assert.deepEqual(
    readOnlyEvidence(
      {
        status: 'completed',
        response: 'Read-only mode: I cannot write files or execute shell commands.',
      },
      intact,
    ),
    {
      passed: true,
      kind: 'model-refusal-only',
    },
  );
  assert.equal(readOnlyEvidence({ status: 'completed', response: 'Done.' }, intact).passed, false);
  assert.equal(
    readOnlyEvidence({ status: 'failed', errorCode: 'GEMINI_FAILED' }, intact).passed,
    false,
  );
  assert.equal(
    readOnlyEvidence(
      { status: 'completed', response: 'I cannot write.' },
      { ...intact, sentinelAbsent: false },
    ).passed,
    false,
  );
  assert.equal(
    readOnlyEvidence(
      { status: 'completed', response: 'I cannot write.' },
      { ...intact, sourceUnchanged: false },
    ).passed,
    false,
  );
});

test('generated code is checked before executing its tests', () => {
  assert.doesNotThrow(() => assertSyntheticFix(FIXED_SOURCE, SYNTHETIC_TEST));
  assert.doesNotThrow(() =>
    assertSyntheticFix('export function add(a,b){return a+b;}', SYNTHETIC_TEST),
  );
  assert.throws(
    () => assertSyntheticFix(FIXED_SOURCE.replace('+', '-'), SYNTHETIC_TEST),
    /canonical/i,
  );
  assert.throws(
    () => assertSyntheticFix(FIXED_SOURCE + '\nprocess.exit(0);', SYNTHETIC_TEST),
    /canonical/i,
  );
  assert.throws(() => assertSyntheticFix(FIXED_SOURCE, 'changed test'), /test fixture/i);
});

test('fixture execution rejects added files and symlinked generated source before reading it', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'gemini-smoke-fixture-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await writeFile(join(directory, '.git'), 'synthetic Git marker');
  await writeFile(join(directory, 'calculator.mjs'), FIXED_SOURCE);
  await writeFile(join(directory, 'calculator.test.mjs'), SYNTHETIC_TEST);
  await assert.doesNotReject(assertSyntheticDirectory(directory));
  await writeFile(join(directory, 'extra.mjs'), 'process.exit(0);');
  await assert.rejects(assertSyntheticDirectory(directory), /unexpected or missing files/i);
  await rm(join(directory, 'extra.mjs'));
  await rm(join(directory, 'calculator.mjs'));
  await symlink(join(directory, 'nonexistent-unread-target'), join(directory, 'calculator.mjs'));
  await assert.rejects(assertSyntheticDirectory(directory), /bounded regular file/i);
});

test('continuation must retain the actual session and isolated worktree', () => {
  const previous = {
    status: 'completed',
    sessionId: 'same-session',
    worktree: '/private/synthetic/task',
  };
  assert.doesNotThrow(() => assertContinuation(previous, { ...previous }));
  assert.throws(
    () => assertContinuation(previous, { ...previous, status: 'failed' }),
    /completed/i,
  );
  assert.throws(
    () => assertContinuation(previous, { ...previous, sessionId: 'new-session' }),
    /session/i,
  );
  assert.throws(
    () => assertContinuation(previous, { ...previous, worktree: '/other/task' }),
    /worktree/i,
  );
});
