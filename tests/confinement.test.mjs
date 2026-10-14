import test from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtemp,
  mkdir,
  writeFile,
  rm,
  symlink,
  readFile,
  readdir,
  realpath,
  chmod,
} from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import {
  assertEditConfiguration,
  createEditBoundaryPolicy,
} from '../plugins/gemini/scripts/lib/confinement.mjs';
import { runGemini } from '../plugins/gemini/scripts/lib/runtime.mjs';

test('rejects inherited include directories including JSON comments and interpolation', async () => {
  const root = await mkdtemp(join(tmpdir(), 'gemini-config-boundary-'));
  try {
    const home = join(root, 'home');
    const cwd = join(root, 'worktree');
    await mkdir(join(home, '.gemini'), { recursive: true });
    await mkdir(cwd);
    await writeFile(
      join(home, '.gemini', 'settings.json'),
      '// comment\n{"context":{"includeDirectories":["${SOURCE_DIR}"]}}',
    );
    await assert.rejects(assertEditConfiguration({ cwd, env: { HOME: home }, systemFiles: [] }), {
      code: 'EDIT_CONFIGURATION_UNSAFE',
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('rejects symlinked custom sandbox policies without reading their contents', async () => {
  const root = await mkdtemp(join(tmpdir(), 'gemini-policy-boundary-'));
  try {
    await mkdir(join(root, '.gemini', 'policies'), { recursive: true });
    await symlink(join(root, 'does-not-exist'), join(root, '.gemini', 'policies', 'sandbox.toml'));
    await assert.rejects(
      assertEditConfiguration({ cwd: root, env: { HOME: root }, systemFiles: [] }),
      { code: 'EDIT_CONFIGURATION_UNSAFE' },
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('allows ordinary settings without inherited workspace expansion', async () => {
  const root = await mkdtemp(join(tmpdir(), 'gemini-safe-config-'));
  try {
    await mkdir(join(root, '.gemini'));
    await writeFile(
      join(root, '.gemini', 'settings.json'),
      '{"security":{"auth":{"selectedType":"oauth-personal"}},"context":{"includeDirectories":[]}}',
    );
    await assert.doesNotReject(
      assertEditConfiguration({ cwd: root, env: { HOME: root }, systemFiles: [] }),
    );
    assert.ok(createEditBoundaryPolicy(root).includes('allowed-path'));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test(
  'real upstream settings loader and native tools enforce execution confinement',
  {
    skip: !process.env.GEMINI_TEST_BUNDLE || process.platform !== 'darwin',
  },
  async () => {
    const scratch = await mkdtemp(join(tmpdir(), 'gemini-real-confinement-'));
    try {
      const home = join(scratch, 'home');
      const source = join(scratch, 'source');
      const target = join(scratch, 'task');
      const control = join(scratch, 'control');
      await mkdir(join(home, '.gemini'), { recursive: true });
      await mkdir(source);
      await writeFile(join(source, 'source.txt'), 'original source\n');
      execFileSync('git', ['init', source], { stdio: 'ignore' });
      execFileSync('git', ['-C', source, 'add', '.'], { stdio: 'ignore' });
      execFileSync(
        'git',
        [
          '-C',
          source,
          '-c',
          'user.name=Fixture',
          '-c',
          'user.email=fixture@example.test',
          '-c',
          'core.hooksPath=/dev/null',
          'commit',
          '-m',
          'fixture',
        ],
        { stdio: 'ignore' },
      );
      execFileSync('git', ['-C', source, 'worktree', 'add', '--detach', target], {
        stdio: 'ignore',
      });
      const globalMemory = join(home, '.gemini', 'GEMINI.md');
      await writeFile(globalMemory, 'original global instructions\n');
      await writeFile(
        join(home, '.gemini', '.env'),
        'GEMINI_FIXTURE_DOTENV_MARKER=must_not_load\n',
      );
      await writeFile(
        join(home, '.gemini', 'settings.json'),
        JSON.stringify({
          hooksConfig: { enabled: true },
          skills: { enabled: true },
          experimental: { gemmaModelRouter: { enabled: true } },
          ide: { enabled: true },
          mcpServers: {
            synthetic: {
              command: process.execPath,
              args: [
                '-e',
                `require('node:fs').writeFileSync(${JSON.stringify(join(scratch, 'mcp-started'))}, 'started')`,
              ],
            },
          },
        }),
      );
      const extensionDirectory = join(home, '.gemini', 'extensions', 'fixture-extension');
      await mkdir(extensionDirectory, { recursive: true });
      await writeFile(
        join(extensionDirectory, 'gemini-extension.json'),
        JSON.stringify({
          name: 'fixture-extension',
          version: '1.0.0',
          mcpServers: {
            extensionSynthetic: {
              command: process.execPath,
              args: [
                '-e',
                `require('node:fs').writeFileSync(${JSON.stringify(join(scratch, 'extension-started'))}, 'started')`,
              ],
            },
          },
        }),
      );
      const fake = fileURLToPath(new URL('./fixtures/fake-gemini.mjs', import.meta.url));
      await chmod(fake, 0o755);
      // Reproduce the inherited CONCAT scope before the effective-settings check:
      // even an empty workspace include list cannot erase this user-level entry.
      const userSettingsPath = join(home, '.gemini', 'settings.json');
      const ordinarySettings = await readFile(userSettingsPath, 'utf8');
      await writeFile(
        userSettingsPath,
        JSON.stringify({
          ...JSON.parse(ordinarySettings),
          context: { includeDirectories: [source] },
        }),
      );
      await assert.rejects(
        runGemini({
          cwd: target,
          executionDirectory: control,
          prompt: 'Fixture only.',
          mode: 'edit',
          binary: fake,
          env: { ...process.env, HOME: home },
        }),
        { code: 'EDIT_CONFIGURATION_UNSAFE' },
      );
      assert.equal(await readFile(join(source, 'source.txt'), 'utf8'), 'original source\n');
      await writeFile(userSettingsPath, ordinarySettings);
      const inspected = await runGemini({
        cwd: target,
        executionDirectory: control,
        prompt: 'Fixture only.',
        mode: 'edit',
        binary: fake,
        env: { ...process.env, HOME: home, FAKE_CASE: 'inspect' },
      });
      const generatedArguments = JSON.parse(inspected.response).args;
      const bundleDir = dirname(process.env.GEMINI_TEST_BUNDLE);
      const names = await readdir(bundleDir);
      const settingsBundle = names.find((n) => n.startsWith('chunk-') && n === 'chunk-HFRGWL72.js');
      assert.ok(settingsBundle, 'pinned settings bundle packaging');
      let cliSource;
      for (const name of names.filter((n) => /^gemini-.*\.js$/.test(n))) {
        const content = await readFile(join(bundleDir, name), 'utf8');
        if (content.includes('async function loadCliConfig(')) {
          cliSource = content;
          break;
        }
      }
      assert.ok(cliSource, 'pinned loadCliConfig source');
      // Expose the real private function for testing without running CLI main.
      // Resolve every original relative bundled import to the untouched package.
      cliSource = cliSource.replace(
        /(["'])\.\/([^"']+)\1/g,
        (_match, quote, name) => `${quote}${pathToFileURL(join(bundleDir, name)).href}${quote}`,
      );
      const exposedCli = join(scratch, 'upstream-cli.mjs');
      await writeFile(exposedCli, cliSource + '\nexport { loadCliConfig, parseArguments };\n');
      const script = `
      import assert from 'node:assert/strict';
      import { readFile, symlink } from 'node:fs/promises';
      const { loadSettings } = await import(${JSON.stringify(pathToFileURL(join(bundleDir, settingsBundle)).href)});
      const upstream = await import(${JSON.stringify(pathToFileURL(process.env.GEMINI_TEST_BUNDLE).href)});
      const { loadCliConfig, parseArguments } = await import(${JSON.stringify(pathToFileURL(exposedCli).href)});
      const control = ${JSON.stringify(control)}, target = ${JSON.stringify(await realpath(target))};
      process.argv = [process.execPath, 'gemini', ...${JSON.stringify(generatedArguments)}];
      // Match main: settings are loaded before argument parsing.
      const settings = loadSettings(control);
      assert.equal(settings.isTrusted, true);
      assert.equal(settings.merged.security.auth.selectedType, 'oauth-personal');
      assert.equal(settings.merged.security.auth.enforcedType, 'oauth-personal');
      assert.equal(settings.merged.security.toolSandboxing, true);
      assert.equal(settings.merged.hooksConfig.enabled, false);
      assert.equal(settings.merged.skills.enabled, false);
      assert.equal(settings.merged.experimental.gemmaModelRouter.enabled, false);
      assert.equal(settings.merged.ide.enabled, false);
      assert.deepEqual(settings.merged.context.includeDirectories, [target]);
      assert.equal(process.env.GEMINI_FIXTURE_DOTENV_MARKER, undefined);
      const argv = await parseArguments(settings.merged);
      assert.equal(argv.outputFormat, 'stream-json');
      assert.equal(argv.approvalMode, 'auto_edit');
      assert.deepEqual(argv.extensions, ['none']);
      const config = await loadCliConfig(settings.merged, 'fixture-session', argv, { cwd: control, loadedSettings: settings, worktreeSettings: {} });
      const fixtureExtension = config.getExtensionLoader().getExtensions().find((extension) => extension.name === 'fixture-extension');
      assert.ok(fixtureExtension, 'real extension loader discovered the synthetic installed extension');
      assert.equal(fixtureExtension.isActive, false, 'generated --extensions none disables inherited extension');
      assert.equal(config.getEnableHooks(), false);
      assert.equal(config.getSandboxEnabled(), true);
      assert.equal(config.getAllowedMcpServers().length, 1);
      assert.match(config.getAllowedMcpServers()[0], /^gemini-plugin-disabled-/);
      // Initialize actual tool/MCP/hook/skill startup while replacing ONLY provider initialization.
      config.geminiClient.initialize = async () => {};
      config.geminiClient.getHistory = () => [];
      config.getBaseLlmClient = () => ({ generateContent: () => { throw new Error('Provider call forbidden in offline test'); } });
      config.getDisableLLMCorrection = () => true;
      await config.initialize();
      assert.deepEqual(config.getToolRegistry().getAllToolNames().sort(), ['read_file', 'list_directory', 'grep_search', 'glob', 'replace', 'write_file'].sort());
      assert.equal(config.mcpClientManager.isBlockedBySettings('synthetic'), true);
      await assert.rejects(readFile(${JSON.stringify(join(scratch, 'mcp-started'))}), { code: 'ENOENT' });
      await assert.rejects(readFile(${JSON.stringify(join(scratch, 'extension-started'))}), { code: 'ENOENT' });
      const engine = config.getPolicyEngine();
      const signal = new AbortController().signal;
      for (const name of ['write_file', 'replace']) {
        for (const file_path of [${JSON.stringify(join(source, 'source.txt'))}, ${JSON.stringify(globalMemory)}, control + '/.gemini/settings.json', target + '/../source/source.txt', target + '-other/outside.txt', 'relative.txt']) {
          const args = name === 'write_file' ? { file_path, content: 'CHANGED' } : { file_path, old_string: 'original', new_string: 'CHANGED', instruction: 'Fixture replacement' };
          assert.equal((await engine.check({ name, args })).decision, 'deny', name + ':' + file_path);
          const Tool = name === 'write_file' ? upstream.WriteFileTool : upstream.EditTool;
          // Real native filesystem implementation must independently deny source/global writes.
          if (file_path === ${JSON.stringify(join(source, 'source.txt'))} || file_path === ${JSON.stringify(globalMemory)}) {
            try { const result = await new Tool(config).build(args).execute({ abortSignal: signal }); assert.ok(result.error); }
            catch (error) { assert.match(error.message, /outside|workspace|denied|Access/i); }
          }
        }
      }
      for (const [name, destination] of [['source-link', ${JSON.stringify(source)}], ['control-link', control]]) {
        await symlink(destination, target + '/' + name);
        const file_path = target + '/' + name + (name === 'source-link' ? '/source.txt' : '/.gemini/settings.json');
        const decision = await engine.check({ name: 'write_file', args: { file_path, content: 'CHANGED' } });
        assert.notEqual(decision.decision, 'allow', 'canonical symlink path rejected by safety checker');
        const result = await Promise.resolve().then(() => new upstream.WriteFileTool(config).build({ file_path, content: 'CHANGED' }).execute({ abortSignal: signal })).catch((error) => ({ error }));
        assert.ok(result.error, 'native sandbox independently rejects canonical symlink escape');
      }
      const file_path = target + '/allowed.txt';
      assert.equal((await engine.check({ name: 'write_file', args: { file_path, content: 'allowed\\n' } })).decision, 'allow');
      const result = await new upstream.WriteFileTool(config).build({ file_path, content: 'allowed\\n' }).execute({ abortSignal: signal });
      assert.equal(result.error, undefined, result.error?.message);
      assert.equal(await readFile(file_path, 'utf8'), 'allowed\\n');
      const edit = await new upstream.EditTool(config).build({ file_path, old_string: 'allowed', new_string: 'changed', instruction: 'Fixture replacement' }).execute({ abortSignal: signal });
      assert.equal(edit.error, undefined, edit.error?.message);
      assert.equal(await readFile(file_path, 'utf8'), 'changed\\n');
      assert.equal(await readFile(${JSON.stringify(join(source, 'source.txt'))}, 'utf8'), 'original source\\n');
      assert.equal(await readFile(${JSON.stringify(globalMemory)}, 'utf8'), 'original global instructions\\n');
      console.log('Real loader, config, MCP startup and native tools verified');
      process.exit(0);
    `;
      try {
        execFileSync(process.execPath, ['--input-type=module', '-e', script], {
          cwd: control,
          env: { ...process.env, HOME: home, GEMINI_CLI_TRUST_WORKSPACE: 'true' },
          timeout: 30000,
          stdio: ['ignore', 'pipe', 'pipe'],
        });
      } catch (error) {
        throw new Error(String(error.stdout) + String(error.stderr));
      }
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  },
);
