import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, chmod, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { probeGemini, runGemini } from '../plugins/gemini/scripts/lib/runtime.mjs';
const binary = fileURLToPath(new URL('./fixtures/fake-gemini.mjs', import.meta.url));
await chmod(binary, 0o755);
const cwd = await mkdtemp(join(tmpdir(), 'gemini-runtime-test-'));
test.after(() => rm(cwd, { recursive: true, force: true }));
const opts = extra => ({ binary, cwd, prompt: 'Review context.', ...extra });
test('probes version and required capabilities without authentication', async () => {
  const result = await probeGemini({ binary });
  assert.equal(result.version, '0.63.0');
  assert.equal(result.supported, true);
  assert.equal(result.capabilities.streamJson, true);
});
test('streams validated assistant output and returns metadata', async () => {
  const events = [];
  const result = await runGemini(opts({ onEvent: e => events.push(e) }));
  assert.equal(result.response, 'Verified answer.');
  assert.equal(result.sessionId, 'session-123');
  assert.equal(result.model, 'test-model');
  assert.equal(result.stats.total_tokens, 12);
  assert.equal(result.exitCode, 0);
  assert.equal(events.length, 3);
});
test('keeps user input off argv and forces Google login plus tool restrictions', async () => {
  const prompt = '/danger @/tmp/secret $(touch no)';
  const result = await runGemini(opts({ prompt, env: { ...process.env, FAKE_CASE: 'inspect', GEMINI_API_KEY: 'TOP_SECRET_VALUE', GOOGLE_API_KEY: 'TOP_SECRET_VALUE', GOOGLE_GENAI_USE_VERTEXAI: 'true', GEMINI_CLI_HOME: '/wrong' } }));
  const details = JSON.parse(result.response);
  assert.equal(details.args.includes(prompt), false);
  assert.ok(details.input.includes(prompt));
  assert.ok(!details.input.startsWith('/danger'));
  assert.deepEqual(details.authEnv, []);
  assert.equal(details.settings.security.auth.selectedType, 'oauth-personal');
  assert.equal(details.settings.security.auth.enforcedType, 'oauth-personal');
  assert.equal(details.settings.hooksConfig.enabled, false);
  assert.equal(details.settings.admin.mcp.enabled, false);
  assert.equal(details.settings.admin.extensions.enabled, false);
  assert.equal(details.settings.tools.core.includes('run_shell_command'), false);
  assert.equal(details.settings.tools.core.includes('write_file'), false);
  assert.equal(details.settings.context.fileFiltering.respectGeminiIgnore, true);
  assert.equal(details.settings.context.fileFiltering.customIgnoreFilePaths.length, 1);
});

test('upstream 0.63.0 policy engine enforces tool and expansion restrictions', { skip: !process.env.GEMINI_TEST_BUNDLE }, async () => {
  const { loadPoliciesFromToml, PolicyEngine } = await import(process.env.GEMINI_TEST_BUNDLE);
  for (const [policy, expected] of [['readonly.toml', ['allow', 'deny', 'deny', 'deny', 'deny']], ['edit.toml', ['allow', 'allow', 'deny', 'deny', 'deny']], ['edit-shell.toml', ['allow', 'allow', 'allow', 'deny', 'deny']]]) {
    const loaded = await loadPoliciesFromToml([fileURLToPath(new URL(`../plugins/gemini/policies/${policy}`, import.meta.url))], () => 5);
    assert.deepEqual(loaded.errors, []);
    const engine = new PolicyEngine({ rules: loaded.rules, nonInteractive: true });
    const requests = [['read_file', {}], ['write_file', {}], ['run_shell_command', { command: 'npm test' }], ['run_shell_command', { command: 'npm test', additional_permissions: { network: true } }], ['mcp_remote_tool', {}]];
    for (const [i, [name, args]] of requests.entries()) assert.equal((await engine.check({ name, args })).decision, expected[i]);
    for (const file_path of ['.env', '/repo/.env.local', '/repo/signing.key', '/repo/oauth_creds.json']) assert.equal((await engine.check({ name: 'read_file', args: { file_path } })).decision, 'deny');
  }
  const web = await loadPoliciesFromToml([fileURLToPath(new URL('../plugins/gemini/policies/readonly.toml', import.meta.url)), fileURLToPath(new URL('../plugins/gemini/policies/web.toml', import.meta.url))], () => 5);
  assert.deepEqual(web.errors, []);
  const webEngine = new PolicyEngine({ rules: web.rules, nonInteractive: true });
  for (const name of ['google_web_search', 'web_fetch']) assert.equal((await webEngine.check({ name, args: {} })).decision, 'allow');
});

test('upstream macOS tool sandbox allows workspace writes and denies outside writes', { skip: !process.env.GEMINI_TEST_BUNDLE || process.platform !== 'darwin' }, async () => {
  const { createSandboxManager } = await import(process.env.GEMINI_TEST_BUNDLE);
  const outside = await mkdtemp(join(process.cwd(), '.gemini-sandbox-test-'));
  let prepared;
  try {
    const manager = createSandboxManager({ enabled: true }, { workspace: cwd, forbiddenPaths: async () => [], includeDirectories: [], modeConfig: { readonly: false, network: false, approvedTools: [], allowOverrides: true } }, 'autoEdit');
    const insidePath = join(cwd, 'inside-probe');
    const outsidePath = join(outside, 'outside-probe');
    prepared = await manager.prepareCommand({ command: '/bin/sh', args: ['-c', 'printf inside > "$1"; printf outside > "$2"', '_', insidePath, outsidePath], cwd, env: process.env, policy: { enabled: true, networkAccess: false } });
    assert.equal(prepared.program, '/usr/bin/sandbox-exec');
    assert.throws(() => execFileSync(prepared.program, prepared.args, { cwd, env: prepared.env, stdio: 'ignore' }));
    await access(insidePath);
    await assert.rejects(access(outsidePath), { code: 'ENOENT' });
  } finally {
    prepared?.cleanup?.();
    await rm(outside, { recursive: true, force: true });
  }
});
for (const [behavior, code] of [['malformed', 'INVALID_STREAM'], ['empty', 'INVALID_STREAM'], ['no-result', 'INVALID_STREAM'], ['result-error', 'GEMINI_FAILED'], ['overflow', 'OUTPUT_LIMIT'], ['fail', 'GEMINI_FAILED'], ['tool', 'TOOL_POLICY_VIOLATION']]) {
  test(`rejects ${behavior} output with safe errors`, async () => {
    await assert.rejects(runGemini(opts({ maxOutputBytes: 4096, env: { ...process.env, FAKE_CASE: behavior } })), error => error.code === code && !error.message.includes('TOP_SECRET_VALUE'));
  });
}
test('terminates hung child on deadline', async () => {
  await assert.rejects(runGemini(opts({ timeoutMs: 150, env: { ...process.env, FAKE_CASE: 'hang' } })), { code: 'TIMEOUT' });
});
test('cancels active subprocess', async () => {
  const controller = new AbortController();
  const pending = runGemini(opts({ signal: controller.signal, env: { ...process.env, FAKE_CASE: 'hang' } }));
  setTimeout(() => controller.abort(), 100);
  await assert.rejects(pending, { code: 'CANCELLED' });
});
test('cancellation kills the subprocess process group', async () => {
  const controller = new AbortController();
  let descendant;
  await assert.rejects(runGemini(opts({ signal: controller.signal, env: { ...process.env, FAKE_CASE: 'tree' }, onEvent: event => { if (event.type === 'init') { descendant = event.child_pid; controller.abort(); } } })), { code: 'CANCELLED' });
  assert.equal(typeof descendant, 'number');
  for (let attempt = 0; attempt < 20; attempt++) {
    try { process.kill(descendant, 0); } catch (error) { assert.equal(error.code, 'ESRCH'); return; }
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.fail('The descendant remained alive after group cancellation.');
});
test('rejects unsupported versions before inference', async () => {
  await assert.rejects(runGemini(opts({ env: { ...process.env, FAKE_VERSION: '0.62.0' } })), { code: 'UNSUPPORTED_VERSION' });
});
test('rejects edit in ordinary directory', async () => {
  await assert.rejects(runGemini(opts({ mode: 'edit' })), { code: 'WORKTREE_REQUIRED' });
});
test('rejects invalid inputs before spawning', async () => {
  await assert.rejects(runGemini(opts({ mode: 'yolo' })), { code: 'INVALID_INPUT' });
  await assert.rejects(runGemini(opts({ timeoutMs: -1 })), { code: 'INVALID_INPUT' });
  await assert.rejects(runGemini(opts({ allowWeb: 'false' })), { code: 'INVALID_INPUT' });
});
test('shell delegation requires explicit sandbox and edit mode', async () => {
  await assert.rejects(runGemini(opts({ allowShell: true })), { code: 'SANDBOX_REQUIRED' });
  await assert.rejects(runGemini(opts({ allowShell: true, sandbox: true })), { code: 'INVALID_INPUT' });
});
test('web tools require explicit opt-in', async () => {
  await assert.rejects(runGemini(opts({ env: { ...process.env, FAKE_CASE: 'web' } })), { code: 'TOOL_POLICY_VIOLATION' });
  const result = await runGemini(opts({ allowWeb: true, env: { ...process.env, FAKE_CASE: 'web' } }));
  assert.equal(result.response, 'Verified answer.');
  const inspection = await runGemini(opts({ allowWeb: true, env: { ...process.env, FAKE_CASE: 'inspect' } }));
  const details = JSON.parse(inspection.response);
  assert.equal(details.settings.tools.core.includes('google_web_search'), true);
  assert.equal(details.settings.tools.core.includes('web_fetch'), true);
});
test('edits use a linked worktree and opt-in tool sandbox on macOS', { skip: process.platform !== 'darwin' }, async () => {
  const repo = join(cwd, 'repository');
  const worktree = join(cwd, 'linked');
  execFileSync('git', ['init', repo], { stdio: 'ignore' });
  execFileSync('git', ['-C', repo, '-c', 'user.name=Test', '-c', 'user.email=test@example.test', '-c', 'core.hooksPath=/dev/null', 'commit', '--allow-empty', '-m', 'fixture'], { stdio: 'ignore' });
  execFileSync('git', ['-C', repo, 'worktree', 'add', '--detach', worktree], { stdio: 'ignore' });
  const result = await runGemini(opts({ cwd: worktree, mode: 'edit', allowShell: true, sandbox: true, env: { ...process.env, FAKE_CASE: 'inspect', SECRET_TOKEN: 'private' } }));
  const details = JSON.parse(result.response);
  assert.equal(details.settings.security.toolSandboxing, true);
  assert.equal(details.settings.advanced.ignoreLocalEnv, true);
  assert.equal(details.settings.tools.core.includes('run_shell_command'), true);
  assert.equal(details.settings.tools.sandbox, false);
});
