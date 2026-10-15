import { lstat, mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';

const allowed = ['.claude-plugin', 'plugins', 'installer', 'docs', 'scripts', 'tests', 'package.json', 'README.md', 'SECURITY.md', 'LICENSE', 'NOTICE', 'CHANGELOG.md', 'CONTRIBUTING.md', 'AGENTS.md'];
const crcTable = Array.from({ length: 256 }, (_, n) => {
  for (let i = 0; i < 8; i++) n = n & 1 ? 0xedb88320 ^ (n >>> 1) : n >>> 1;
  return n >>> 0;
});
function crc32(bytes) {
  let n = 0xffffffff;
  for (const byte of bytes) n = crcTable[(n ^ byte) & 255] ^ (n >>> 8);
  return (n ^ 0xffffffff) >>> 0;
}
// Stored ZIP entries keep distribution dependency-free and preserve Unix launcher modes.
export function createZip(entries) {
  const local = [], central = [];
  let offset = 0;
  for (const { name, content, mode = 0o644 } of entries) {
    const filename = Buffer.from(name, 'utf8');
    if (filename.length > 65535 || content.length > 0xffffffff) throw new Error('Archive entry too large.');
    const crc = crc32(content);
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0); header.writeUInt16LE(20, 4); header.writeUInt16LE(0x800, 6);
    header.writeUInt16LE(33, 12); header.writeUInt32LE(crc, 14); header.writeUInt32LE(content.length, 18); header.writeUInt32LE(content.length, 22); header.writeUInt16LE(filename.length, 26);
    local.push(header, filename, content);
    const directory = Buffer.alloc(46);
    directory.writeUInt32LE(0x02014b50, 0); directory.writeUInt16LE(0x314, 4); directory.writeUInt16LE(20, 6); directory.writeUInt16LE(0x800, 8);
    directory.writeUInt16LE(33, 14); directory.writeUInt32LE(crc, 16); directory.writeUInt32LE(content.length, 20); directory.writeUInt32LE(content.length, 24); directory.writeUInt16LE(filename.length, 28);
    directory.writeUInt32LE(((0o100000 | mode) << 16) >>> 0, 38); directory.writeUInt32LE(offset, 42);
    central.push(directory, filename); offset += header.length + filename.length + content.length;
  }
  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10); end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, directory, end]);
}
function sensitivePath(path) {
  return path.split('/').some(segment => /^(?:\.env(?:[.-].*)?|\.npmrc|\.netrc|credentials?(?:[._-].*)?|secrets?(?:[._-].*)?|auth(?:[._-].*)?|oauth(?:[._-].*)?|id_(?:rsa|ed25519)(?:\.pub)?|.*\.(?:pem|key|p12|pfx))$/i.test(segment));
}
function committedInventory(root) {
  const git = args => execFileSync('git', ['-C', root, ...args], { maxBuffer: 32 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
  if (git(['status', '--porcelain', '--untracked-files=no']).length) throw new Error('Release packaging requires a clean committed source tree.');
  const inventory = git(['ls-tree', '-rz', '--full-tree', 'HEAD']).toString('utf8').split('\0').filter(Boolean).map(line => {
    const separator = line.indexOf('\t');
    const [mode, type, object] = line.slice(0, separator).split(' ');
    return { path: line.slice(separator + 1), mode, type, object };
  });
  if (inventory.some(item => sensitivePath(item.path))) throw new Error('Refusing a tracked sensitive path in the release source.');
  return { git, inventory };
}
export async function buildArtifacts({ root = resolve(dirname(fileURLToPath(import.meta.url)), '..'), output = resolve(root, '..', 'gemini-plugin-cc-releases') } = {}) {
  const { git, inventory } = committedInventory(root);
  const manifest = inventory.find(item => item.path === 'package.json');
  if (!manifest) throw new Error('Committed release package.json is missing.');
  const { version } = JSON.parse(git(['cat-file', 'blob', manifest.object]).toString('utf8'));
  if (!/^\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(version)) throw new Error('Invalid release version.');
  const prefix = `gemini-companion-v${version}`;
  const entries = [];
  for (const item of inventory) {
    if (!allowed.some(name => item.path === name || item.path.startsWith(name + '/'))) continue;
    if (item.path.split('/').some(name => ['.git', 'node_modules', 'work', '.workstate', 'outputs', '.DS_Store'].includes(name))) continue;
    if (item.type !== 'blob' || !['100644', '100755'].includes(item.mode)) throw new Error(`Refusing a link or non-file in release payload: ${item.path}`);
    let content = git(['cat-file', 'blob', item.object]);
    if (/\.(?:cmd|ps1)$/i.test(item.path)) content = Buffer.from(content.toString('utf8').replace(/\r?\n/g, '\r\n'));
    entries.push({ name: `${prefix}/${item.path}`, content, mode: item.path.endsWith('.command') || item.path.endsWith('.sh') ? 0o755 : 0o644 });
  }
  await mkdir(output, { recursive: true });
  const artifacts = [], sums = [];
  for (const [platform, launcher] of [['macos', 'Install.command'], ['windows', 'Install.cmd']]) {
    const original = entries.find(item => item.name === `${prefix}/installer/${launcher}`);
    if (!original) throw new Error(`Committed installer/${launcher} is missing.`);
    const data = createZip([...entries, { ...original, name: `${prefix}/${launcher}`, mode: 0o755 }]);
    const name = `gemini-companion-${platform}-v${version}.zip`;
    const path = join(output, name);
    await writeFile(path, data); artifacts.push(path); sums.push(`${createHash('sha256').update(data).digest('hex')}  ${name}`);
  }
  await writeFile(join(output, 'SHA256SUMS.txt'), sums.join('\n') + '\n');
  return artifacts;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args.length && !(args.length === 2 && args[0] === '--out')) throw new Error('Usage: node scripts/pack.mjs [--out <directory>]');
  console.log((await buildArtifacts(args.length ? { output: resolve(args[1]) } : {})).join('\n'));
}
