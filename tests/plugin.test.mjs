import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));
const pluginRoot = path.join(root, 'plugins/gemini');
const commands = [
  'setup',
  'ask',
  'review',
  'adversarial-review',
  'rescue',
  'transfer',
  'status',
  'result',
  'cancel',
  'apply',
  'clean',
  'gate',
  'judge',
  'advisor',
];
const json = async (filename) => JSON.parse(await readFile(path.join(root, filename), 'utf8'));
const document = async (filename) => (await readFile(path.join(root, filename), 'utf8')).replaceAll('\r\n', '\n');

test('marketplace points to the self-contained Gemini plugin', async () => {
  const marketplace = await json('.claude-plugin/marketplace.json');
  assert.equal(marketplace.name, 'gemini-companion');
  assert.ok(marketplace.owner.name);
  assert.equal(marketplace.plugins.length, 1);
  assert.equal(marketplace.plugins[0].name, 'gemini');
  assert.equal(marketplace.plugins[0].source, './plugins/gemini');
});

test('manifest identifies Gemini capabilities without hidden services', async () => {
  const manifest = await json('plugins/gemini/.claude-plugin/plugin.json');
  assert.equal(manifest.name, 'gemini');
  assert.match(manifest.version, /^\d+\.\d+\.\d+$/);
  assert.match(manifest.description, /Google sign-in/i);
  assert.equal(manifest.license, 'Apache-2.0');
  for (const field of ['hooks', 'mcpServers', 'settings', 'dependencies'])
    assert.equal(manifest[field], undefined);
});

test('all public capabilities have one discoverable skill', async () => {
  const entries = await readdir(path.join(pluginRoot, 'skills'));
  assert.deepEqual(entries.sort(), [...commands].sort());
  for (const command of commands) {
    const skill = await document(`plugins/gemini/skills/${command}/SKILL.md`);
    assert.ok(skill.startsWith('---\n'), command);
    assert.match(skill, new RegExp(`^name: ${command}$`, 'm'), command);
    assert.match(skill, /^description: .+/m, command);
  }
});

test('skill requests use JSON data rather than shell-expanded arguments', async () => {
  for (const command of commands) {
    const skill = await document(`plugins/gemini/skills/${command}/SKILL.md`);
    assert.match(skill, /Write tool/, command);
    assert.match(skill, /--request/, command);
    assert.ok(skill.includes('${CLAUDE_PLUGIN_ROOT}/scripts/companion.mjs'), command);
    assert.ok(!skill.includes('$ARGUMENTS'), `${command} must not interpolate user text`);
    assert.ok(!/!`/.test(skill), `${command} must not execute dynamic shell context`);
    assert.ok(!/^allowed-tools:.*(?:Bash\(\*\)|Bash\(node \*\)|Bash$)/m.test(skill), command);
  }
});

test('apply and cleanup remain explicit user actions', async () => {
  for (const command of ['setup', 'apply', 'clean', 'gate']) {
    const skill = await document(`plugins/gemini/skills/${command}/SKILL.md`);
    assert.match(skill, /^disable-model-invocation: true$/m, command);
  }
});

test('independent specialist agents delegate model work through skills', async () => {
  const agents = await readdir(path.join(pluginRoot, 'agents'));
  assert.deepEqual(agents.sort(), [
    'adversarial-reviewer.md',
    'advisor.md',
    'implementer.md',
    'investigator.md',
    'judge.md',
    'reviewer.md',
  ]);
  for (const filename of agents) {
    const agent = await document(`plugins/gemini/agents/${filename}`);
    assert.match(agent, /^name: .+/m, filename);
    assert.match(agent, /^tools: .*Skill/m, filename);
    assert.ok(
      !/^model: gemini/m.test(agent),
      `${filename} must not claim native Gemini subagent support`,
    );
    assert.match(agent, /Gemini CLI/);
    assert.match(agent, /evidence/i);
  }
});

test('documentation explains OAuth, limitations, and provider privacy', async () => {
  const readme = await document('README.md');
  const security = await document('SECURITY.md');
  assert.match(readme, /Gemini Companion/);
  assert.match(readme, /Sign in with Google/);
  assert.match(readme, /subscription/i);
  assert.match(readme, /quota/i);
  assert.match(readme, /live smoke test/i);
  assert.match(readme, /not.*native.*transcript/i);
  assert.match(security, /Google/);
  assert.match(security, /not.*sandbox/i);
  assert.match(security, /prompt injection/i);
});

test('CI checks real files without invoking a provider account', async () => {
  const ci = await document('.github/workflows/ci.yml');
  assert.match(ci, /npm test/);
  assert.match(ci, /node: \[20, 22, 24\]/);
  assert.match(ci, /node-version: \$\{\{ matrix\.node \}\}/);
  assert.ok(!/GEMINI_API_KEY|GOOGLE_API_KEY|\$\{\{\s*secrets\./.test(ci));
});
