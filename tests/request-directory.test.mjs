import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, lstat, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequestDirectory, removeRequestDirectory } from '../plugins/gemini/scripts/request-directory.mjs';

test('portable request directory is private and cleanup preserves unrelated files', async (t) => {
  const result = await createRequestDirectory();
  t.after(() => rm(result.directory, { recursive: true, force: true }));
  assert.equal(result.requestFile, join(result.directory, 'request.json'));
  if (process.platform !== 'win32') assert.equal((await lstat(result.directory)).mode & 0o777, 0o700);
  await writeFile(result.requestFile, '{"command":"status"}');
  await writeFile(join(result.directory, 'keep.txt'), 'valuable');
  await assert.rejects(removeRequestDirectory(result.directory), /unexpected/i);
  assert.equal(await readFile(join(result.directory, 'keep.txt'), 'utf8'), 'valuable');
  assert.equal(await readFile(result.requestFile, 'utf8'), '{"command":"status"}');
  await rm(join(result.directory, 'keep.txt'));
  await removeRequestDirectory(result.directory);
  await assert.rejects(lstat(result.directory), { code: 'ENOENT' });
});

test('cleanup refuses directories it did not create', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'gemini-request-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await writeFile(join(directory, 'request.json'), 'preserve');
  await assert.rejects(removeRequestDirectory(directory), /managed|marker/i);
  assert.equal(await readFile(join(directory, 'request.json'), 'utf8'), 'preserve');
});
