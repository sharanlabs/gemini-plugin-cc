import { resolve } from 'node:path';

const commands = new Set(['setup','ask','judge','advisor','review','adversarial-review','rescue','transfer','status','result','cancel','apply','clean','gate']);
const strings = new Set(['cwd','prompt','focus','base','model','resume','jobId']);
const booleans = new Set(['background','fresh','edit','allowShell','allowWeb','sandbox','json','checkAuth','enabled']);
const flags = {'--cwd':'cwd','--prompt':'prompt','--focus':'focus','--base':'base','--model':'model','--resume':'resume','--job-id':'jobId','--timeout-ms':'timeoutMs'};
const switches = {'--background':'background','--wait':'wait','--fresh':'fresh','--edit':'edit','--allow-shell':'allowShell','--web':'allowWeb','--sandbox':'sandbox','--json':'json','--check-auth':'checkAuth'};

export function parseArgs(args) {
  if (!args.length || args[0] === '--help' || args[0] === '-h') return {command:'help'};
  const request = {command:args[0]};
  const words = [];
  for (let i=1;i<args.length;i++) {
    const arg = args[i];
    if (arg === '--') {words.push(...args.slice(i+1)); break;}
    if (Object.hasOwn(flags,arg)) {
      if (i+1 >= args.length) throw new Error(`Missing value for ${arg}`);
      request[flags[arg]] = arg === '--timeout-ms' ? Number(args[++i]) : args[++i];
    } else if (Object.hasOwn(switches,arg)) {
      if (arg === '--wait') request.background = false;
      else request[switches[arg]] = true;
    } else if (arg.startsWith('-')) throw new Error(`Unknown option: ${arg}`);
    else words.push(arg);
  }
  if (words.length) {
    if (['status','result','cancel','apply','clean'].includes(request.command)) {
      if (words.length !== 1 || request.jobId) throw new Error('Supply one job ID');
      request.jobId = words[0];
    } else if (request.command === 'gate') {
      if (words.length !== 1 || !['on','off'].includes(words[0])) throw new Error('Use gate on or gate off');
      request.enabled = words[0] === 'on';
    } else if (request.prompt) throw new Error('Use --prompt or positional prompt, not both');
    else request.prompt = words.join(' ');
  }
  return request;
}

export function validateRequest(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Request must be an object');
  for (const [key,value] of Object.entries(input)) {
    if (!['command','timeoutMs',...strings,...booleans].includes(key)) throw new Error(`Unknown request field: ${key}`);
    if ((strings.has(key) || key === 'command') && (typeof value !== 'string' || value.includes('\0') || value.length > 200000)) throw new Error(`Invalid string: ${key}`);
    if (booleans.has(key) && typeof value !== 'boolean') throw new Error(`${key} must be boolean`);
  }
  if (!commands.has(input.command)) throw new Error(`Unknown command: ${input.command}`);
  const r = {background:false,edit:false,fresh:false,allowShell:false,sandbox:false,timeoutMs:600000,...input,cwd:resolve(input.cwd || process.cwd())};
  if (!Number.isSafeInteger(r.timeoutMs) || r.timeoutMs < 1000 || r.timeoutMs > 3600000) throw new Error('timeoutMs must be 1000–3600000');
  if (r.edit && r.command !== 'rescue') throw new Error('Only rescue accepts --edit');
  if (r.allowShell && (!r.edit || !r.sandbox)) throw new Error('--allow-shell requires --edit and --sandbox');
  if (r.sandbox && !r.allowShell) throw new Error('--sandbox requires --allow-shell');
  if (r.fresh && r.resume) throw new Error('--fresh and --resume are mutually exclusive');
  if (r.resume && r.command !== 'rescue') throw new Error('Only rescue accepts --resume <job-id>');
  if (r.base && (!['review','adversarial-review'].includes(r.command) || r.base.startsWith('-'))) throw new Error('Invalid review base');
  if (r.model && (!/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/.test(r.model))) throw new Error('Invalid model identifier');
  if (r.background && !['ask','judge','advisor','review','adversarial-review','rescue','transfer'].includes(r.command)) throw new Error('This command cannot run in background');
  if (['ask','judge','advisor','rescue','transfer'].includes(r.command) && !r.prompt?.trim()) throw new Error(`${r.command} requires a task, decision, acceptance criteria or handoff summary`);
  if (r.command === 'gate' && typeof r.enabled !== 'boolean') throw new Error('Use gate on or gate off');
  if (['apply','clean','cancel'].includes(r.command) && !r.jobId) throw new Error(`${r.command} requires an explicit job ID`);
  if (r.jobId && !/^job-[a-f0-9-]{36}$/.test(r.jobId)) throw new Error('Invalid job ID');
  return r;
}
