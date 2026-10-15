import { mkdtemp, realpath, lstat, readFile, writeFile, readdir, unlink, rmdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, dirname, basename } from 'node:path';
import { pathToFileURL } from 'node:url';
import { privateDirectory } from './lib/store.mjs';

const marker = '.gemini-request-owner';
const markerValue = 'gemini-companion-request-v1\n';

export async function createRequestDirectory() {
  const directory = await mkdtemp(join(await realpath(tmpdir()), 'gemini-request-'));
  await privateDirectory(directory);
  await writeFile(join(directory, marker), markerValue, { mode: 0o600, flag: 'wx' });
  return { directory, requestFile: join(directory, 'request.json') };
}

export async function removeRequestDirectory(input) {
  const directory = resolve(input);
  if (!/^gemini-request-[A-Za-z0-9]{6}$/.test(basename(directory)) ||
      dirname(directory) !== await realpath(tmpdir()))
    throw new Error('Not a managed request directory');
  if ((await lstat(directory)).isSymbolicLink() || !((await lstat(directory)).isDirectory()))
    throw new Error('Invalid managed request directory');
  const names = await readdir(directory);
  if (names.some((name) => ![marker, 'request.json'].includes(name)))
    throw new Error('Request directory contains unexpected files; preserve and inspect it');
  const owner = join(directory, marker);
  try {
    const metadata = await lstat(owner);
    if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size !== Buffer.byteLength(markerValue) || await readFile(owner, 'utf8') !== markerValue)
      throw new Error('Invalid request ownership marker');
  } catch (error) {
    if (error.code === 'ENOENT') throw new Error('Missing managed request ownership marker');
    throw error;
  }
  // Unlink only our two files; never recursively remove a user-supplied path.
  await unlink(join(directory, 'request.json')).catch((error) => {
    if (error.code !== 'ENOENT') throw error;
  });
  await unlink(owner);
  await rmdir(directory);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    if (process.argv.length === 2) console.log(JSON.stringify(await createRequestDirectory()));
    else if (process.argv.length === 4 && process.argv[2] === '--cleanup')
      await removeRequestDirectory(process.argv[3]);
    else throw new Error('Usage: node request-directory.mjs [--cleanup <directory>]');
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
