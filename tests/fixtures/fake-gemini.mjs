#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
const args = process.argv.slice(2);
if (args.includes('--version')) {
  console.log(process.env.FAKE_VERSION || '0.63.0');
  process.exit(0);
}
if (args.includes('--help')) {
  console.log(
    '--prompt --output-format stream-json --model --resume --admin-policy --approval-mode --extensions --sandbox',
  );
  process.exit(0);
}
let input = '';
for await (const chunk of process.stdin) input += chunk;
const emit = (value) => console.log(JSON.stringify(value));
const behavior = process.env.FAKE_CASE;
if (behavior === 'hang') {
  setInterval(() => {}, 1000);
} else if (behavior === 'tree') {
  const descendant = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], {
    stdio: 'ignore',
  });
  emit({
    type: 'init',
    session_id: 'tree-session',
    model: 'test-model',
    child_pid: descendant.pid,
  });
  setInterval(() => {}, 1000);
} else if (behavior === 'overflow') console.log('x'.repeat(10000));
else if (behavior === 'malformed') console.log('not json');
else if (behavior === 'fail') {
  console.error('credential: TOP_SECRET_VALUE');
  process.exit(1);
} else if (behavior === 'empty') process.exit(0);
else {
  emit({ type: 'init', session_id: 'session-123', model: 'test-model' });
  if (behavior === 'tool')
    emit({ type: 'tool_use', tool_name: 'write_file', parameters: { file_path: '/tmp/bad' } });
  if (behavior === 'web')
    emit({ type: 'tool_use', tool_name: 'google_web_search', parameters: { query: 'test' } });
  emit({
    type: 'message',
    role: 'assistant',
    content:
      behavior === 'inspect'
        ? JSON.stringify({
            args,
            input,
            settings: JSON.parse(readFileSync(process.env.GEMINI_CLI_SYSTEM_SETTINGS_PATH, 'utf8')),
            authEnv: Object.keys(process.env).filter((k) =>
              /API_KEY|USE_VERTEXAI|GEMINI_CLI_HOME/.test(k),
            ),
          })
        : 'Verified answer.',
    delta: true,
  });
  if (behavior !== 'no-result')
    emit({
      type: 'result',
      status: behavior === 'result-error' ? 'error' : 'success',
      stats: { total_tokens: 12 },
    });
}
