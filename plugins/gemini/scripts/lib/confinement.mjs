import { readFile, lstat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { systemConfigurationDirectory } from './platform.mjs';

function unsafe() {
  const error = new Error(
    'Gemini refused: inherited included directories, administrator settings, environment files, or custom sandbox policies prevent confined execution. Use ordinary Google sign-in settings without these overrides.',
  );
  error.code = 'EDIT_CONFIGURATION_UNSAFE';
  return error;
}

// Match upstream JSON-with-comments parsing without evaluating configuration.
function stripComments(text) {
  let result = '';
  let quoted = false;
  let escaped = false;
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (quoted) {
      result += char;
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') quoted = false;
    } else if (char === '"') {
      quoted = true;
      result += char;
    } else if (char === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i++;
      result += '\n';
    } else if (char === '/' && text[i + 1] === '*') {
      i += 2;
      while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) i++;
      if (i >= text.length) throw unsafe();
      i++;
      result += ' ';
    } else result += char;
  }
  return result;
}

export async function assertEditConfiguration({ cwd, env = process.env, systemFiles } = {}) {
  const home = env.HOME || homedir();
  const defaults = systemConfigurationDirectory();
  for (const file of [
    ...(systemFiles ?? [
      join(defaults, 'settings.json'),
      join(defaults, 'system-defaults.json'),
      env.GEMINI_CLI_SYSTEM_SETTINGS_PATH,
      env.GEMINI_CLI_SYSTEM_DEFAULTS_PATH,
    ]),
  ].filter(Boolean)) {
    try {
      await lstat(file);
      throw unsafe();
    } catch (error) {
      if (error.code !== 'ENOENT') throw unsafe();
    }
  }
  const files = new Set(
    [
      join(home, '.gemini', 'settings.json'),
      join(cwd, '.gemini', 'settings.json'),
      ...(systemFiles ?? [
        join(defaults, 'settings.json'),
        join(defaults, 'system-defaults.json'),
        env.GEMINI_CLI_SYSTEM_SETTINGS_PATH,
        env.GEMINI_CLI_SYSTEM_DEFAULTS_PATH,
      ]),
    ].filter(Boolean),
  );
  for (const file of files) {
    let info;
    try {
      info = await lstat(file);
    } catch (error) {
      if (error.code === 'ENOENT') continue;
      throw unsafe();
    }
    if (!info.isFile() || info.isSymbolicLink() || info.size > 1024 * 1024) throw unsafe();
    let settings;
    try {
      settings = JSON.parse(stripComments(await readFile(file, 'utf8')));
    } catch {
      throw unsafe();
    }
    if (!settings || typeof settings !== 'object' || Array.isArray(settings)) throw unsafe();
    const includes = settings.context?.includeDirectories;
    // CONCAT means an empty override cannot remove lower-scope entries. Reject
    // nonempty entries before env interpolation; no interpreted path can escape.
    if (includes !== undefined && (!Array.isArray(includes) || includes.length !== 0))
      throw unsafe();
  }
  try {
    await lstat(join(home, '.gemini', 'policies', 'sandbox.toml'));
    throw unsafe();
  } catch (error) {
    if (error.code !== 'ENOENT') throw unsafe();
  }
}

export function createEditBoundaryPolicy(directory) {
  const root = JSON.stringify(resolve(directory))
    .slice(1, -1)
    .replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const outside = `"file_path"\\s*:\\s*"(?!${root}/)`;
  const traversal = '"file_path"\\s*:\\s*"[^\"]*/\\.\\.(?:/|\")';
  return `\n# Per-invocation boundary: reject non-absolute/outside writes before dispatch.\n[[rule]]\ntoolName = ["write_file", "replace"]\nargsPattern = ${JSON.stringify(outside)}\ndecision = "deny"\npriority = 999\n\n[[rule]]\ntoolName = ["write_file", "replace"]\nargsPattern = ${JSON.stringify(traversal)}\ndecision = "deny"\npriority = 999\n\n# Canonicalize existing ancestors and symlinks before permitted file writes.\n[[safety_checker]]\ntoolName = ["write_file", "replace"]\npriority = 999\n[safety_checker.checker]\ntype = "in-process"\nname = "allowed-path"\nrequired_context = ["environment"]\n[safety_checker.checker.config]\nincluded_args = ["file_path"]\n`;
}
