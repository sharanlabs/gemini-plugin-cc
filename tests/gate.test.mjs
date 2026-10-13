import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { JobStore, atomicJson } from '../plugins/gemini/scripts/lib/store.mjs';
import { reviewStop } from '../plugins/gemini/scripts/stop-hook.mjs';

test('Stop review is inactive by default and recursive stops never invoke Gemini',async()=>{
 const root=await mkdtemp(join(tmpdir(),'gemini-gate-root-'));const state=await mkdtemp(join(tmpdir(),'gemini-gate-state-'));
 const store=new JobStore(root,state);let calls=0;const runner=async()=>{calls++;throw new Error('must not run');};
 assert.deepEqual(await reviewStop({cwd:root},{store,runner}),{});
 await store.init();await atomicJson(join(store.directory,'settings.json'),{reviewGate:true});
 assert.deepEqual(await reviewStop({cwd:root,stop_hook_active:true},{store,runner}),{});
 assert.equal(calls,0);
});

test('one bounded gate review blocks supported findings and deduplicates the same stop',async()=>{
 const root=await mkdtemp(join(tmpdir(),'gemini-gate-root-'));const store=new JobStore(root,await mkdtemp(join(tmpdir(),'gemini-gate-state-')));
 await store.init();await atomicJson(join(store.directory,'settings.json'),{reviewGate:true});
 let calls=0;const runner=async options=>{calls++;assert.equal(options.timeoutMs,60000);return {response:JSON.stringify({verdict:'fail',findings:['app.js:3: reproducible defect']})};};
 const input={cwd:root,session_id:'abc',last_assistant_message:'done'};
 assert.equal((await reviewStop(input,{store,runner})).decision,'block');
 assert.deepEqual(await reviewStop(input,{store,runner}),{});assert.equal(calls,1);
});

test('unavailable or invalid review cannot be presented as a passing verdict',async()=>{
 const root=await mkdtemp(join(tmpdir(),'gemini-gate-root-'));const store=new JobStore(root,await mkdtemp(join(tmpdir(),'gemini-gate-state-')));
 await store.init();await atomicJson(join(store.directory,'settings.json'),{reviewGate:true});
 const result=await reviewStop({cwd:root,session_id:'abc',last_assistant_message:'done'},{store,runner:async()=>({response:'looks fine'})});
 assert.match(result.warning,/not validated/);assert.equal(result.decision,undefined);
});
