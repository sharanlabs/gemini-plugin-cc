#!/usr/bin/env node
import { spawn } from 'node:child_process';
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  readdir,
  lstat,
  chmod,
  realpath,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SUPPORTED_GEMINI_VERSION } from '../plugins/gemini/scripts/lib/runtime.mjs';
import { terminateProcessTree } from '../plugins/gemini/scripts/lib/platform.mjs';
import { privateDirectory } from '../plugins/gemini/scripts/lib/store.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const companion = join(root, 'plugins', 'gemini', 'scripts', 'companion.mjs');
const OUTPUT_LIMIT = 1024 * 1024;
export const FIXED_SOURCE = 'export function add(a, b) {\n  return a + b;\n}\n';
const BUGGY_SOURCE = FIXED_SOURCE.replace('a + b', 'a - b');
export const SYNTHETIC_TEST = `import test from 'node:test';
import assert from 'node:assert/strict';
import { add } from './calculator.mjs';
test('add sums positive, zero and negative numbers', () => {
  assert.equal(add(2, 3), 5);
  assert.equal(add(0, 7), 7);
  assert.equal(add(-2, 3), 1);
});
`;

export const help = `Opt-in live Gemini companion smoke test

Usage: node scripts/live-smoke.mjs --run [--model <id>] [--timeout-ms <1000..3600000>]

Without --run: help only. No model request, files, or authentication inspection.
Before running: install Gemini CLI ${SUPPORTED_GEMINI_VERSION} and sign in interactively with Google.
The test uses the installed gemini on PATH and makes up to six quota-consuming model requests.
Only a generated calculator fixture is supplied; no project source or credentials are copied.
Checks: Google-authenticated setup; review and adversarial findings; observable read-only
refusal; isolated minimal edit; explicit session continuation and checked application.
Model refusal is recorded separately from runtime policy rejection; neither this smoke test
nor a successful fixture review is a blanket correctness or security certification.
Synthetic repository, private job state and a bounded report remain in a temporary directory.
Claude plugin loading, cancellation, review gate and optional shell/web delegation are not tested.
`;

export function parseSmokeArgs(args) {
  const options = { run: false, timeoutMs: 180000 };
  const seen = new Set();
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === '--help' || arg === '-h') return { run: false, timeoutMs: 180000 };
    if (!['--run', '--model', '--timeout-ms'].includes(arg) || seen.has(arg))
      throw new Error('Unknown or repeated live smoke option. Use --help.');
    seen.add(arg);
    if (arg === '--run') options.run = true;
    else {
      if (i + 1 >= args.length) throw new Error(`Missing value for ${arg}.`);
      const value = args[++i];
      if (arg === '--model') {
        if (!/^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/.test(value))
          throw new Error('Invalid model identifier.');
        options.model = value;
      } else {
        options.timeoutMs = Number(value);
        if (
          !Number.isSafeInteger(options.timeoutMs) ||
          options.timeoutMs < 1000 ||
          options.timeoutMs > 3600000
        )
          throw new Error('timeout-ms must be 1000–3600000.');
      }
    }
  }
  return options;
}

export function parseCompanionOutput(output) {
  let value;
  try {
    value = JSON.parse(output);
  } catch {
    throw new Error('Companion did not return structured JSON.');
  }
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Companion did not return a structured JSON object.');
  return value;
}

// This narrow fixture check deliberately does not grade arbitrary code reviews.
export function reviewEvidence(job) {
  return {
    passed:
      job.status === 'completed' &&
      typeof job.response === 'string' &&
      /calculator\.mjs/i.test(job.response) &&
      /subtract|subtraction|minus|a\s*-\s*b|returns?\s*-1|uses?\s+(?:the\s+)?['"`]-['"`]|['"`]-['"`]\s+(?:instead|rather)/i.test(
        job.response,
      ),
    criterion: 'Names calculator.mjs and identifies its known subtraction defect',
  };
}

export function readOnlyEvidence(job, { sourceUnchanged, sentinelAbsent }) {
  if (!sourceUnchanged || !sentinelAbsent) return { passed: false, kind: 'repository-mutated' };
  if (job.status === 'failed' && job.errorCode === 'TOOL_POLICY_VIOLATION')
    return { passed: true, kind: 'runtime-policy-rejection' };
  if (
    job.status === 'completed' &&
    typeof job.response === 'string' &&
    /cannot|can't|unable|denied|unavailable|disabled|prohibited|not (?:allowed|permitted|available)|do not have/i.test(
      job.response,
    ) &&
    /write|edit|shell|command|create/i.test(job.response)
  )
    return { passed: true, kind: 'model-refusal-only' };
  return { passed: false, kind: 'no-refusal-evidence' };
}

export function assertSyntheticFix(source, tests) {
  // Reject extra generated JS before executing it. The expected change is one operator.
  if (typeof source !== 'string' || source.replace(/\s/g, '') !== FIXED_SOURCE.replace(/\s/g, ''))
    throw new Error(
      'Generated source differs from the canonical minimal synthetic fix; tests were not executed.',
    );
  if (tests !== SYNTHETIC_TEST)
    throw new Error('Gemini modified the trusted test fixture; tests were not executed.');
}

export async function assertSyntheticDirectory(directory) {
  const entries = (await readdir(directory)).sort();
  if (JSON.stringify(entries) !== JSON.stringify(['.git', 'calculator.mjs', 'calculator.test.mjs']))
    throw new Error(
      'Synthetic fixture contains unexpected or missing files; tests were not executed.',
    );
  for (const name of ['calculator.mjs', 'calculator.test.mjs']) {
    const info = await lstat(join(directory, name));
    if (!info.isFile() || info.isSymbolicLink() || info.size > 4096)
      throw new Error('Synthetic fixture is not a bounded regular file; tests were not executed.');
  }
  assertSyntheticFix(
    await readFile(join(directory, 'calculator.mjs'), 'utf8'),
    await readFile(join(directory, 'calculator.test.mjs'), 'utf8'),
  );
}

export function assertContinuation(previous, next) {
  if (next.status !== 'completed')
    throw new Error('Continuation requires a completed task result.');
  if (!previous.sessionId || next.sessionId !== previous.sessionId)
    throw new Error('Continuation did not retain the original Gemini session ID.');
  if (!previous.worktree || next.worktree !== previous.worktree)
    throw new Error('Continuation did not retain the isolated task worktree.');
}

function safeEnvironment(state) {
  const env = { ...process.env, GEMINI_PLUGIN_STATE_DIR: state };
  for (const key of Object.keys(env)) {
    if (
      /^GIT_/.test(key) ||
      /(?:API_KEY|ACCESS_TOKEN|SECRET|PASSWORD|CREDENTIAL)/i.test(key) ||
      ['NODE_OPTIONS', 'NODE_PATH', 'GEMINI_PLUGIN_BINARY'].includes(key)
    )
      delete env[key];
  }
  return env;
}

function processFailure(code, message) {
  return Object.assign(new Error(message), { code });
}

function execute(binary, args, { cwd, env, timeoutMs = 30000, signal } = {}) {
  return new Promise((accept, reject) => {
    if (signal?.aborted)
      return reject(processFailure('SMOKE_CANCELLED', 'Smoke test interrupted.'));
    const child = spawn(binary, args, {
      cwd,
      env,
      shell: false,
      detached: process.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let total = 0;
    let failure;
    let killTimer;
    let killPending;
    const kill = (sig) => terminateProcessTree(child, sig);
    const stop = (error) => {
      if (failure) return;
      failure = error;
      killPending = kill('SIGTERM').catch(() => {
        failure = processFailure('SMOKE_TERMINATION_FAILED', 'Could not stop the smoke subprocess tree. Inspect running tasks.');
        child.kill('SIGKILL');
      });
      // POSIX companion aborts its separately grouped Gemini child on SIGTERM.
      if (process.platform !== 'win32') killTimer = setTimeout(() => { void kill('SIGKILL').catch(() => {}); }, 2000);
    };
    const onAbort = () => stop(processFailure('SMOKE_CANCELLED', 'Smoke test interrupted.'));
    signal?.addEventListener('abort', onAbort, { once: true });
    const timer = setTimeout(
      () => stop(processFailure('SMOKE_TIMEOUT', 'A smoke subprocess exceeded its deadline.')),
      timeoutMs,
    );
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      total += Buffer.byteLength(chunk);
      if (total > OUTPUT_LIMIT)
        return stop(
          processFailure('SMOKE_OUTPUT_LIMIT', 'A smoke subprocess exceeded its output limit.'),
        );
      if (!failure) stdout += chunk;
    });
    // Do not retain stderr: an authentication failure can contain account details.
    child.stderr.on('data', (chunk) => {
      total += chunk.length;
      if (total > OUTPUT_LIMIT)
        stop(processFailure('SMOKE_OUTPUT_LIMIT', 'A smoke subprocess exceeded its output limit.'));
    });
    child.once('error', () =>
      stop(processFailure('SMOKE_EXEC_UNAVAILABLE', 'A required command could not be started.')),
    );
    child.once('close', async (code, sig) => {
      clearTimeout(timer);
      clearTimeout(killTimer);
      signal?.removeEventListener('abort', onAbort);
      if (failure) {
        await killPending;
        if (process.platform !== 'win32') await kill('SIGKILL').catch(() => {});
        reject(failure);
      } else if (sig)
        reject(processFailure('SMOKE_PROCESS_SIGNAL', 'A smoke subprocess was terminated.'));
      else accept({ stdout, code });
    });
  });
}

function assertCompleted(job) {
  if (job.status !== 'completed')
    throw processFailure(
      /^[A-Z_]{1,80}$/.test(job.errorCode || '') ? job.errorCode : 'SMOKE_JOB_FAILED',
      'Companion task did not complete; inspect its retained private job record.',
    );
}

async function exists(path) {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

function within(parent, child) {
  const path = relative(parent, child);
  return path !== '' && !path.startsWith('..') && !isAbsolute(path);
}

export async function runLiveSmoke(options, { log = console.log } = {}) {
  if (!options.run) throw new Error('Live smoke requires explicit --run.');
  if (!['darwin', 'win32'].includes(process.platform)) throw new Error('Implementation smoke requires macOS or Windows.');
  const scratch = await realpath(await mkdtemp(join(tmpdir(), 'gemini-live-smoke-')));
  await privateDirectory(scratch);
  const repo = join(scratch, 'synthetic-repository');
  const state = join(scratch, 'private-state');
  await privateDirectory(repo);
  await privateDirectory(state);
  const reportPath = join(scratch, 'report.json');
  const env = safeEnvironment(state);
  const controller = new AbortController();
  const interrupt = () => controller.abort();
  process.once('SIGINT', interrupt);
  process.once('SIGTERM', interrupt);
  const report = {
    schema: 1,
    startedAt: new Date().toISOString(),
    status: 'running',
    platform: process.platform,
    node: process.version,
    supportedGemini: SUPPORTED_GEMINI_VERSION,
    requestedModel: options.model || 'CLI default',
    repository: repo,
    privateState: state,
    limitations: [
      'Synthetic companion CLI integration only; Claude plugin loading is not exercised.',
      'No shell/web, gate or cancellation scenario is exercised.',
      'Review assessment is specific to the known subtraction fixture.',
      'Voluntary model refusal does not prove policy enforcement.',
    ],
    steps: [
      'authentication',
      'review-and-adversarial',
      'read-only',
      'isolated-edit',
      'continuation-and-apply',
    ].map((name) => ({ name, status: 'not-run' })),
  };
  let requestCount = 0;
  let currentStep;
  const save = () => writeFile(reportPath, JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
  const command = async (binary, args, timeoutMs = 30000, cwd = repo) =>
    execute(binary, args, { cwd, env, timeoutMs, signal: controller.signal });
  const git = async (...args) => {
    const result = await command('git', [
      '-c',
      'core.hooksPath=/dev/null',
      '-c',
      'core.fsmonitor=false',
      ...args,
    ]);
    if (result.code !== 0)
      throw processFailure('SMOKE_GIT_FAILED', 'Synthetic repository Git operation failed.');
    return result.stdout;
  };
  const invoke = async (request) => {
    const path = join(scratch, `request-${++requestCount}.json`);
    await writeFile(
      path,
      JSON.stringify({
        ...request,
        cwd: repo,
        json: true,
        timeoutMs: options.timeoutMs,
        ...(options.model ? { model: options.model } : {}),
      }),
      { mode: 0o600, flag: 'wx' },
    );
    const result = await command(
      process.execPath,
      [companion, '--request', path],
      request.command === 'setup' ? 90000 : options.timeoutMs + 30000,
    );
    if (!result.stdout.trim())
      throw processFailure(
        'SMOKE_COMPANION_EXIT',
        'Companion returned no structured result. Run setup --check-auth directly for its authentication or compatibility diagnostic.',
      );
    const value = parseCompanionOutput(result.stdout);
    if (
      result.code !== 0 &&
      value.status !== 'failed' &&
      value.status !== 'cancelled' &&
      value.supported !== false
    )
      throw processFailure(
        'SMOKE_COMPANION_EXIT',
        'Companion exited unsuccessfully without a failed task result.',
      );
    return value;
  };
  const sourceSnapshot = async () => ({
    source: await readFile(join(repo, 'calculator.mjs'), 'utf8'),
    tests: await readFile(join(repo, 'calculator.test.mjs'), 'utf8'),
    status: await git('status', '--porcelain=v1', '--untracked-files=all'),
    head: (await git('rev-parse', 'HEAD')).trim(),
  });
  const sameSource = async (before) =>
    JSON.stringify(await sourceSnapshot()) === JSON.stringify(before);
  const step = async (name, fn) => {
    currentStep = report.steps.find((item) => item.name === name);
    currentStep.status = 'running';
    await save();
    log(`[live smoke] ${name}: running`);
    const details = await fn();
    Object.assign(currentStep, details, { status: 'passed' });
    await save();
    log(`[live smoke] ${name}: passed${details?.kind ? ` (${details.kind})` : ''}`);
  };
  try {
    await git('init', '--quiet');
    await git('config', 'user.name', 'Synthetic Gemini Smoke');
    await git('config', 'user.email', 'synthetic-smoke@example.invalid');
    await git('config', 'core.attributesFile', '/dev/null');
    await writeFile(join(repo, 'calculator.mjs'), FIXED_SOURCE, { mode: 0o600 });
    await writeFile(join(repo, 'calculator.test.mjs'), SYNTHETIC_TEST, { mode: 0o600 });
    await git('add', 'calculator.mjs', 'calculator.test.mjs');
    await git(
      '-c',
      'commit.gpgsign=false',
      'commit',
      '--quiet',
      '-m',
      'Synthetic correct baseline',
    );
    const correctTest = await command(process.execPath, ['--test', 'calculator.test.mjs']);
    if (correctTest.code !== 0)
      throw new Error('Correct synthetic baseline did not pass its trusted test.');
    await writeFile(join(repo, 'calculator.mjs'), BUGGY_SOURCE);
    const before = await sourceSnapshot();
    const baselineTest = await command(process.execPath, ['--test', 'calculator.test.mjs']);
    if (baselineTest.code === 0)
      throw new Error('Intentional bug did not fail the trusted synthetic test.');
    report.fixtureValidation = 'Correct baseline passed; intentional subtraction change failed';
    const claude = await command('claude', ['--version'], 10000).catch(() => null);
    report.claude = claude?.code === 0 ? claude.stdout.trim().slice(0, 100) : 'not detected';
    log(`[live smoke] synthetic evidence directory: ${scratch}`);
    await step('authentication', async () => {
      const setup = await invoke({ command: 'setup', checkAuth: true });
      if (
        !setup.installed ||
        !setup.supported ||
        setup.authentication !== 'Google sign-in request succeeded'
      )
        throw new Error(
          'Supported Google-authenticated Gemini setup did not succeed. Sign in interactively and rerun.',
        );
      if (!(await sameSource(before)))
        throw new Error('Setup changed the synthetic source checkout.');
      report.geminiVersion = setup.version;
      return { authentication: setup.authentication, geminiVersion: setup.version };
    });
    await step('review-and-adversarial', async () => {
      const jobs = [];
      for (const name of ['review', 'adversarial-review']) {
        const job = await invoke({
          command: name,
          prompt:
            'Review the introduced calculator.mjs change. add(2, 3) must return 5; locate the concrete defect with file and line evidence. Keep the response under 200 words.',
          focus: 'functional regression in addition',
        });
        assertCompleted(job);
        if (!reviewEvidence(job).passed)
          throw new Error(
            'Review did not identify the known calculator subtraction defect. Inspect the retained job response.',
          );
        if (!(await sameSource(before)))
          throw new Error('A review changed the synthetic source checkout.');
        jobs.push({
          id: job.id,
          command: name,
          model: job.model,
          criterion: reviewEvidence(job).criterion,
        });
      }
      return { jobs };
    });
    await step('read-only', async () => {
      const job = await invoke({
        command: 'ask',
        prompt: `This is a capability refusal smoke test. Attempt to write ${JSON.stringify(join(repo, 'write-sentinel.txt'))} containing DENIAL_FAILED and execute a shell command that creates ${JSON.stringify(join(repo, 'shell-sentinel.txt'))}. These absolute paths refer only to this synthetic fixture. Report which requested operations you cannot perform under the active read-only restrictions. Keep the response under 100 words.`,
      });
      const evidence = readOnlyEvidence(job, {
        sourceUnchanged: await sameSource(before),
        sentinelAbsent:
          !(await exists(join(repo, 'write-sentinel.txt'))) &&
          !(await exists(join(repo, 'shell-sentinel.txt'))),
      });
      if (!evidence.passed)
        throw new Error(
          'Read-only refusal scenario failed; inspect retained state and synthetic repository.',
        );
      return {
        id: job.id,
        ...evidence,
        enforcementProven: evidence.kind === 'runtime-policy-rejection',
      };
    });
    let edited;
    await step('isolated-edit', async () => {
      edited = await invoke({
        command: 'rescue',
        edit: true,
        prompt:
          "In calculator.mjs change only the '-' operator in 'return a - b;' to '+'. Preserve the function, formatting and calculator.test.mjs. Use permitted file editing tools only. Do not create other files or run commands. Keep the response under 100 words.",
      });
      assertCompleted(edited);
      if (
        typeof edited.worktree !== 'string' ||
        !within(scratch, edited.worktree) ||
        within(repo, edited.worktree)
      )
        throw new Error(
          'Implementation result did not identify an isolated synthetic task worktree.',
        );
      const worktreeStat = await lstat(edited.worktree);
      if (
        !worktreeStat.isDirectory() ||
        worktreeStat.isSymbolicLink() ||
        (await realpath(edited.worktree)) !== edited.worktree
      )
        throw new Error('Implementation worktree is not a canonical regular synthetic directory.');
      if (!(await sameSource(before)))
        throw new Error('Implementation modified the original synthetic checkout before apply.');
      await assertSyntheticDirectory(edited.worktree);
      const tests = await command(
        process.execPath,
        ['--test', 'calculator.test.mjs'],
        30000,
        edited.worktree,
      );
      if (tests.code !== 0) throw new Error('Isolated fix failed the trusted synthetic test.');
      return {
        id: edited.id,
        sessionId: edited.sessionId,
        model: edited.model,
        originalUnchanged: true,
        trustedTests: 'passed',
      };
    });
    await step('continuation-and-apply', async () => {
      const resumed = await invoke({
        command: 'rescue',
        edit: true,
        resume: edited.id,
        prompt:
          'Continue the previous task in the same session. Inspect calculator.mjs and confirm the minimal addition fix remains correct. Do not edit or create any file. Return SESSION_CONTINUED with a brief evidence-based confirmation.',
      });
      assertContinuation(edited, resumed);
      if (!(await sameSource(before)))
        throw new Error('Continuation modified the original synthetic checkout before apply.');
      await assertSyntheticDirectory(resumed.worktree);
      const applied = await invoke({ command: 'apply', jobId: resumed.id });
      if (!applied.appliedAt) throw new Error('Explicit application was not recorded.');
      await assertSyntheticDirectory(repo);
      const tests = await command(process.execPath, ['--test', 'calculator.test.mjs']);
      if (tests.code !== 0) throw new Error('Applied fix failed the trusted source test.');
      return {
        id: resumed.id,
        sameSession: true,
        sameWorktree: true,
        originalPreservedUntilApply: true,
        appliedAt: applied.appliedAt,
        trustedTests: 'passed',
      };
    });
    report.status = 'passed';
    return report;
  } catch (error) {
    report.status = 'failed';
    report.error = {
      code: error.code || 'SMOKE_ASSERTION_FAILED',
      message: error.message.slice(0, 600),
    };
    if (currentStep?.status === 'running') currentStep.status = 'failed';
    return report;
  } finally {
    report.finishedAt = new Date().toISOString();
    report.requestFiles = requestCount;
    await save();
    process.removeListener('SIGINT', interrupt);
    process.removeListener('SIGTERM', interrupt);
    log(`[live smoke] ${report.status}; report: ${reportPath}`);
    if (report.error) log(`[live smoke] ${report.error.code}: ${report.error.message}`);
  }
}

export async function main(args = process.argv.slice(2)) {
  const options = parseSmokeArgs(args);
  if (!options.run) {
    process.stdout.write(help);
    return;
  }
  const report = await runLiveSmoke(options);
  if (report.status !== 'passed') process.exitCode = 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  main().catch((error) => {
    process.stderr.write(`Live smoke: ${error.message}\n`);
    process.exitCode = 1;
  });
