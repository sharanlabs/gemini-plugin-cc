import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
async function walk(dir) {
 for(const entry of await readdir(dir,{withFileTypes:true})) {
  if(['.git','node_modules','work'].includes(entry.name))continue;
  const path=join(dir,entry.name);
  if(entry.isDirectory())await walk(path);
  else if(path.endsWith('.mjs'))execFileSync(process.execPath,['--check',path],{stdio:'pipe'});
  else if(path.endsWith('.json'))JSON.parse(await readFile(path,'utf8'));
 }
}
await walk('.');
console.log('JavaScript syntax and JSON checks passed.');
