import { join, dirname } from 'node:path';
import { writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { privateDirectory, atomicJson } from '../plugins/gemini/scripts/lib/store.mjs';

// Preserve the user's real HOME and OAuth cache; remove inherited alternate providers
// and settings/Node injection selectors without reading any credential or user config.
export function googleLoginEnvironment(env) {
  const clean = { ...env };
  for (const key of Object.keys(clean)) {
    if (/(?:API_KEY|ACCESS_TOKEN|SECRET|PASSWORD|CREDENTIAL)/i.test(key) ||
      /^(?:GOOGLE_GENAI_USE_VERTEXAI|GOOGLE_GENAI_USE_GCA|GOOGLE_GEMINI_BASE_URL|GOOGLE_VERTEX_BASE_URL|GEMINI_CLI_AUTH_OVERRIDE|GEMINI_CLI_TRUST_WORKSPACE|GEMINI_RESTRICTED_MODE|GEMINI_CLI_INTEGRATION_TEST|VITEST|GEMINI_CLI_USE_COMPUTE_ADC|CLOUD_SHELL|GEMINI_CLI_HOME|GEMINI_CLI_SYSTEM_.*|GEMINI_SYSTEM_MD|GEMINI_MODEL|GEMINI_SANDBOX.*|GEMINI_CLI_IDE_.*|SANDBOX.*|SEATBELT_PROFILE|BUILD_SANDBOX|NODE_OPTIONS|NODE_PATH|DEBUG|DEBUG_PORT)$/i.test(key)) delete clean[key];
  }
  clean.GEMINI_CLI_TRUST_WORKSPACE = 'true';
  clean.NO_UPDATE_NOTIFIER = '1';
  return clean;
}
export async function prepareGoogleLogin({ receipt, env = process.env }) {
  const cwd = await privateDirectory(join(dirname(receipt.pluginRoot), 'login'));
  await privateDirectory(join(cwd, '.gemini'));
  const settings = {
    security: { auth: { selectedType: 'oauth-personal', enforcedType: 'oauth-personal', useExternal: false }, disableYoloMode: true },
    hooksConfig: { enabled: false }, skills: { enabled: false }, mcp: { allowed: [] },
    tools: { core: [], discoveryCommand: null, callCommand: null, sandbox: false },
    general: { enableAutoUpdate: false, plan: { enabled: false } },
    experimental: { enableAgents: false, gemmaModelRouter: { enabled: false } },
    ide: { enabled: false }, advanced: { ignoreLocalEnv: true }, telemetry: { enabled: false },
    context: { includeDirectories: [], fileName: `gemini-plugin-login-disabled-${randomUUID()}.md`, includeDirectoryTree: false, loadMemoryFromIncludeDirectories: false },
  };
  await writeFile(join(cwd, '.gemini', '.env'), '', { mode: 0o600 });
  await writeFile(join(cwd, '.geminiignore'), '*\n', { mode: 0o600 });
  await atomicJson(join(cwd, '.gemini', 'settings.json'), settings);
  return { command: receipt.nodePath, args: [receipt.geminiEntry, '--skip-trust', '--extensions', 'none', '--allowed-mcp-server-names', `gemini-plugin-login-disabled-${randomUUID()}`], options: { env: googleLoginEnvironment(env), cwd, interactive: true } };
}
export async function signIn({ receipt, env, execute } = {}) {
  const launch = await prepareGoogleLogin({ receipt, env });
  if (execute) return execute(launch.command, launch.args, launch.options);
  return new Promise((resolve, reject) => {
    const child = spawn(launch.command, launch.args, { env: launch.options.env, cwd: launch.options.cwd, stdio: 'inherit', shell: false });
    child.once('error', () => reject(new Error('Google sign-in could not start. Run the installer again.')));
    child.once('exit', code => code === 0 ? resolve() : reject(new Error('Google sign-in ended before completion. Run the Sign in to Gemini shortcut again.')));
  });
}
