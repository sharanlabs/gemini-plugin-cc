import { mkdir, lstat, realpath, chmod, readFile, writeFile, rename, readdir, unlink, open } from 'node:fs/promises';
import { join, resolve, parse } from 'node:path';
import { homedir } from 'node:os';
import { createHash, randomUUID } from 'node:crypto';

const validId = id => /^job-[a-f0-9-]{36}$/.test(id);

export async function privateDirectory(path) {
  const absolute = resolve(path);
  // Refuse existing symlinks in the full ancestry, not just the final component.
  let part = parse(absolute).root;
  for (const segment of absolute.slice(part.length).split(/[\\/]/).filter(Boolean)) {
    part = join(part, segment);
    try {
      if ((await lstat(part)).isSymbolicLink()) {
        const systemAlias = process.platform === 'darwin' && ['/var','/tmp'].includes(part) && await realpath(part) === `/private${part}`;
        if (!systemAlias) throw new Error('State path cannot contain a symlink');
      }
    }
    catch (error) {if (error.code !== 'ENOENT') throw error;}
  }
  await mkdir(absolute, {recursive:true,mode:0o700});
  const s = await lstat(absolute);
  if (!s.isDirectory() || s.isSymbolicLink()) throw new Error('Invalid state directory');
  if (process.getuid && s.uid !== process.getuid()) throw new Error('State directory belongs to another user');
  await chmod(absolute,0o700);
  return absolute;
}

export async function atomicJson(path, value) {
  const temp = `${path}.${randomUUID()}.tmp`;
  await writeFile(temp, JSON.stringify(value,null,2)+'\n', {mode:0o600,flag:'wx'});
  try {await rename(temp,path);} catch (error) {await unlink(temp).catch(()=>{}); throw error;}
}

export class JobStore {
  constructor(workspace, stateRoot = process.env.GEMINI_PLUGIN_STATE_DIR || join(homedir(),'.local','state','gemini-plugin-cc')) {
    this.workspace = resolve(workspace);
    this.stateRoot = resolve(stateRoot);
    this.directory = join(this.stateRoot, createHash('sha256').update(this.workspace).digest('hex').slice(0,24));
  }
  async init() {await privateDirectory(this.stateRoot); await privateDirectory(this.directory);}
  jobPath(id) {if (!validId(id)) throw new Error('Invalid job ID'); return join(this.directory,`${id}.json`);}
  taskPath(id) {this.jobPath(id); return join(this.directory, id);}
  async create(data) {
    await this.init();
    const now = new Date().toISOString();
    const job = {...data,id:`job-${randomUUID()}`,schema:1,status:'queued',workspace:this.workspace,createdAt:now,updatedAt:now};
    await atomicJson(this.jobPath(job.id),job);
    return job;
  }
  async get(id) {
    let job;
    try {
      const path = this.jobPath(id);
      if ((await lstat(path)).isSymbolicLink()) throw new Error('Job file cannot be a symlink');
      job = JSON.parse(await readFile(path,'utf8'));
    } catch (error) {if (error.code === 'ENOENT') throw new Error(`Job not found in this workspace: ${id}`); throw error;}
    if (job.schema !== 1 || job.id !== id || job.workspace !== this.workspace) throw new Error('Invalid job record');
    return job;
  }
  async update(id,patch) {
    const job = {...await this.get(id),...patch,updatedAt:new Date().toISOString()};
    await atomicJson(this.jobPath(id),job);
    return job;
  }
  async list() {
    await this.init();
    const names = await readdir(this.directory);
    const records = [];
    for (const name of names) if (name.endsWith('.json') && validId(name.slice(0,-5))) records.push(await this.get(name.slice(0,-5)));
    return records.sort((a,b)=>b.createdAt.localeCompare(a.createdAt));
  }
  async latest(id) {
    if (id) return this.get(id);
    const jobs = await this.list();
    if (!jobs.length) throw new Error('No Gemini jobs in this workspace');
    return jobs[0];
  }
  async lock(name) {
    if (!/^[a-z0-9-]+$/.test(name)) throw new Error('Invalid lock');
    await this.init();
    const path = join(this.directory,`${name}.lock`);
    let handle;
    try {handle = await open(path,'wx',0o600);}
    catch (e) {if (e.code === 'EEXIST') throw new Error(`Workspace operation already active: ${name}. If interrupted, inspect ${path} before removing the stale lock.`); throw e;}
    await handle.writeFile(JSON.stringify({pid:process.pid,createdAt:new Date().toISOString()}));
    return async () => {await handle.close(); await unlink(path);};
  }
}
