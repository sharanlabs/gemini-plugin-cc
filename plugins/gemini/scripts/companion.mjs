#!/usr/bin/env node
import { readFile, lstat } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs, validateRequest } from './lib/request.mjs';
import { JobStore, atomicJson } from './lib/store.mjs';
import { resolveWorkspace } from './lib/context.mjs';
import { probeGemini, runGemini, SUPPORTED_GEMINI_VERSION } from './lib/runtime.mjs';
import {
  startJob,
  executeJob,
  cancelJob,
  statusJobs,
  applyJob,
  cleanJob,
  cleanText,
} from './lib/jobs.mjs';

export const help = `Gemini companion for Claude Code (unofficial)
Google sign-in only. No API keys. Gemini CLI ${SUPPORTED_GEMINI_VERSION}; Node 20+.

Commands:
  setup [--check-auth]                 Check CLI; optional Google authentication request
  ask <question>                      Independent second opinion
  judge <criteria and work>            Independent acceptance verdict with evidence
  advisor <decision>                  Compare approaches and recommend a direction
  review [--base <ref>]                Evidence-backed code review
  adversarial-review [--focus <text>]  Challenge assumptions and failure modes
  rescue <task> [--edit]               Investigate; optionally edit an isolated worktree
  transfer <handoff-summary>           New resumable Gemini session from explicit summary
  status [job-id]                      Show recent workspace jobs
  result [job-id]                      Show stored output and session ID
  cancel <job-id>                      Request cancellation without PID-reuse risk
  apply <job-id>                       Apply checked incremental implementation patch
  clean <job-id>                       Remove only a clean, owned task worktree
  gate on|off                         Enable or disable the optional bounded Stop review

Run options: --cwd <path> --model <id> --web --background --wait --timeout-ms <1000..3600000>
Rescue continuation: --resume <job-id> or --fresh (no implicit session reuse).
Rescue shell: --edit --allow-shell --sandbox (supported macOS tool sandbox required).
Safe integration: --request <JSON-file> with command/cwd/options; never interpolate task text in shell.
Output: --json or json:true in a JSON request. Model output is untrusted advisory evidence.
`;

export async function readRequest(path) {
  const s = await lstat(path);
  if (!s.isFile() || s.isSymbolicLink() || s.size > 300000)
    throw new Error('Request must be a regular JSON file under 300 KB');
  if (process.getuid && s.uid !== process.getuid())
    throw new Error('Request file belongs to another user');
  return validateRequest(JSON.parse(await readFile(path, 'utf8')));
}

function presentJob(job) {
  return {
    id: job.id,
    command: job.command,
    status: job.status,
    model: job.model,
    sessionId: job.sessionId,
    stats: job.stats,
    response: job.response,
    error: job.error,
    errorCode: job.errorCode,
    exitCode: job.exitCode,
    worktree: job.worktree,
    patchPath: job.patchPath,
    patchBytes: job.patchBytes,
    changes: job.changes,
    appliedAt: job.appliedAt,
    cleanedAt: job.cleanedAt,
    cancellationRequested: job.cancellationRequested,
    resumeDirectory: job.sessionId ? job.worktree || job.workspace : undefined,
    resumeCommand: job.sessionId
      ? `gemini --resume '${job.sessionId.replaceAll("'", "'\"'\"'")}'`
      : undefined,
  };
}

export async function dispatch(input) {
  const request = validateRequest(input);
  const workspace = await resolveWorkspace(request.cwd);
  const store = new JobStore(workspace.root);
  if (request.command === 'setup') {
    let probe;
    try {
      probe = await probeGemini({ binary: process.env.GEMINI_PLUGIN_BINARY || 'gemini' });
    } catch {
      return {
        installed: false,
        supported: false,
        authentication: 'not checked',
        instructions: `Install Gemini CLI ${SUPPORTED_GEMINI_VERSION} yourself, run gemini, and choose Sign in with Google. No settings were changed.`,
      };
    }
    let auth = 'not checked (use --check-auth for a minimal Google-authenticated request)';
    if (request.checkAuth) {
      await runGemini({
        cwd: workspace.root,
        prompt: 'Reply with READY. Do not use tools.',
        mode: 'ask',
        model: request.model,
        timeoutMs: 60000,
        binary: process.env.GEMINI_PLUGIN_BINARY || 'gemini',
      });
      auth = 'Google sign-in request succeeded';
    }
    return {
      installed: true,
      ...probe,
      authentication: auth,
      authMode: 'Google sign-in only',
      instructions: probe.supported
        ? 'Run gemini interactively and choose Sign in with Google if you have not signed in.'
        : `Requires the tested Gemini CLI ${SUPPORTED_GEMINI_VERSION}; existing installation was not changed.`,
    };
  }
  switch (request.command) {
    case 'status':
      return statusJobs(store, request.jobId);
    case 'result':
      return presentJob(await store.latest(request.jobId));
    case 'cancel':
      return presentJob(await cancelJob(store, request.jobId));
    case 'apply':
      return presentJob(await applyJob(store, request.jobId));
    case 'clean':
      return presentJob(await cleanJob(store, request.jobId));
    case 'gate':
      await store.init();
      await atomicJson(join(store.directory, 'settings.json'), { reviewGate: request.enabled });
      return {
        reviewGate: request.enabled,
        message: request.enabled
          ? 'Stop review enabled for this workspace. Each eligible stop can use a Gemini request; recursive hook stops are skipped.'
          : 'Stop review disabled for this workspace.',
      };
    default:
      return presentJob(await startJob(request, { store }));
  }
}

export function render(value) {
  if (Array.isArray(value))
    return value.length
      ? value
          .map(
            (v) =>
              `${v.id}  ${v.command}  ${v.status}${v.model ? `  ${v.model}` : ''}${v.error ? `\n  ${v.error}` : ''}`,
          )
          .join('\n')
      : 'No Gemini jobs in this workspace.';
  if (value.id) {
    return [
      `Gemini ${value.command}: ${value.status}`,
      `Job: ${value.id}`,
      value.model && `Model: ${value.model}`,
      value.sessionId && `Session: ${value.sessionId}`,
      value.worktree && `Task worktree: ${value.worktree}`,
      value.patchPath && `Incremental patch: ${value.patchPath} (${value.patchBytes} bytes)`,
      value.appliedAt && 'Changes applied to the source checkout.',
      value.cancellationRequested && 'Cancellation requested; use status to confirm.',
      value.error && `Error: ${value.error}`,
      value.response && `\n${value.response}`,
      value.resumeCommand &&
        `\nContinue directly from ${value.resumeDirectory}: ${value.resumeCommand}`,
    ]
      .filter(Boolean)
      .join('\n');
  }
  return Object.entries(value)
    .map(([k, v]) => `${k}: ${typeof v === 'object' ? JSON.stringify(v) : v}`)
    .join('\n');
}

export async function main(args = process.argv.slice(2)) {
  if (args[0] === '--internal-worker') {
    if (args.length !== 4) throw new Error('Invalid worker invocation');
    const store = new JobStore(args[1]);
    const job = await executeJob(store, args[2], { token: args[3] });
    if (job.status === 'failed') process.exitCode = 1;
    return;
  }
  const raw =
    args[0] === '--request'
      ? args.length === 2
        ? await readRequest(args[1])
        : (() => {
            throw new Error('Use --request <path> without additional shell options');
          })()
      : parseArgs(args);
  if (raw.command === 'help') {
    process.stdout.write(help);
    return;
  }
  const result = await dispatch(raw);
  process.stdout.write((raw.json ? JSON.stringify(result, null, 2) : render(result)) + '\n');
  if (result.status === 'failed' || result.status === 'cancelled' || result.supported === false)
    process.exitCode = 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  main().catch((error) => {
    process.stderr.write(`Gemini companion: ${cleanText(error.message).slice(0, 1500)}\n`);
    process.exitCode = 1;
  });
