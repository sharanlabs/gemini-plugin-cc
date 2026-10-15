import { spawn } from 'node:child_process';
import { access, chmod, lstat, readFile, realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import { delimiter, dirname, isAbsolute, join, parse, resolve, win32 } from 'node:path';

function failure(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

// Windows has aliases with semantics that POSIX containment checks do not model.
// Confined data and control paths must use an ordinary local drive namespace.
export function assertWindowsLocalPath(path) {
  if (
    typeof path !== 'string' ||
    !/^[A-Za-z]:[\\/]/.test(path) ||
    /[\x00-\x1f<>"|?*]/.test(path) ||
    path.slice(2).includes(':') ||
    path.slice(2).split(/[\\/]/).filter(Boolean).some((segment) =>
      segment === '.' || segment === '..' || /[. ]$/.test(segment) ||
      /^(?:CON|PRN|AUX|NUL|COM[1-9\u00b9\u00b2\u00b3]|LPT[1-9\u00b9\u00b2\u00b3])(?:\.|$)/i.test(segment),
    )
  ) throw failure('UNSAFE_WINDOWS_PATH', 'Windows path must use an ordinary local drive without aliases or alternate streams.');
  return path;
}

export function systemConfigurationDirectory(platform = process.platform) {
  return platform === 'win32' ? 'C:\\ProgramData\\gemini-cli' :
    platform === 'darwin' ? '/Library/Application Support/GeminiCli' : '/etc/gemini-cli';
}

export function getInstallBase(platform = process.platform, env = process.env) {
  return platform === 'win32'
    ? win32.join(env.LOCALAPPDATA || win32.join(homedir(), 'AppData', 'Local'), 'gemini-plugin-cc')
    : join(homedir(), '.local', 'share', 'gemini-plugin-cc');
}

export function managedInstallReceiptPath(env = process.env) {
  return join(getInstallBase(process.platform, env), 'install.json');
}

async function packageEntry(packageRoot) {
  try {
    const manifestPath = join(packageRoot, 'package.json');
    const manifestInfo = await lstat(manifestPath);
    if (!manifestInfo.isFile() || manifestInfo.isSymbolicLink() || manifestInfo.size > 1024 * 1024) throw new Error();
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
    if (manifest.name !== '@google/gemini-cli' || manifest.bin?.gemini !== 'bundle/gemini.js') throw new Error();
    const entry = join(packageRoot, 'bundle', 'gemini.js');
    const canonical = await realpath(entry);
    if (canonical !== join(await realpath(packageRoot), 'bundle', 'gemini.js') || !(await lstat(canonical)).isFile()) throw new Error();
    return canonical;
  } catch {
    throw failure('GEMINI_UNAVAILABLE', 'The Gemini command does not resolve to the supported official package.');
  }
}

async function findExecutable(binary, env) {
  if (isAbsolute(binary) || /[\\/]/.test(binary)) return resolve(binary);
  const path = Object.entries(env).find(([name]) => name.toUpperCase() === 'PATH')?.[1] || '';
  const suffixes = process.platform === 'win32' && !/\.[a-z0-9]+$/i.test(binary)
    ? ['.exe', '.cmd', '.bat', ''] : [''];
  for (const directory of path.split(delimiter).filter(Boolean)) {
    for (const suffix of suffixes) {
      const candidate = join(directory, binary + suffix);
      try {
        if ((await lstat(candidate)).isFile() || (await lstat(candidate)).isSymbolicLink()) return candidate;
      } catch (error) { if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR') throw error; }
    }
  }
  return binary;
}

// Never interpret npm's .cmd shim or model-supplied text through cmd.exe.
export async function resolveGeminiLaunch(binary = 'gemini', env = process.env) {
  if (typeof binary !== 'string' || !binary || /[\0\r\n]/.test(binary))
    throw failure('GEMINI_UNAVAILABLE', 'Invalid Gemini executable.');
  if (binary === 'gemini') {
    const receipt = managedInstallReceiptPath(env);
    try {
      const info = await lstat(receipt);
      if (!info.isFile() || info.isSymbolicLink() || info.size > 1024 * 1024) throw new Error();
      const installed = JSON.parse(await readFile(receipt, 'utf8'));
      if (installed.schema !== 1 || typeof installed.geminiEntry !== 'string' || !isAbsolute(installed.geminiEntry)) throw new Error();
      const entry = await packageEntry(dirname(dirname(installed.geminiEntry)));
      if (entry !== await realpath(installed.geminiEntry)) throw new Error();
      return { command: process.execPath, argsPrefix: [entry] };
    } catch (error) {
      if (error.code !== 'ENOENT')
        throw failure('GEMINI_UNAVAILABLE', 'The managed Gemini installation receipt is invalid; run the installer again.');
    }
  }
  let executable = await findExecutable(binary, env);
  if (/\.(?:cmd|bat)$/i.test(executable)) {
    if (process.platform === 'win32') assertWindowsLocalPath(executable);
    const entry = await packageEntry(join(dirname(executable), 'node_modules', '@google', 'gemini-cli'));
    return { command: process.execPath, argsPrefix: [entry] };
  }
  if (/\.(?:mjs|js)$/i.test(executable)) {
    await access(executable);
    return { command: process.execPath, argsPrefix: [resolve(executable)] };
  }
  // A standard Unix npm bin is a symlink to the package's JavaScript entry.
  if (isAbsolute(executable)) {
    try {
      executable = await realpath(executable);
      if (/\.(?:mjs|js)$/i.test(executable)) return { command: process.execPath, argsPrefix: [executable] };
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  return { command: executable, argsPrefix: [] };
}

function windowsSystemExecutable(relative) {
  const root = process.env.SystemRoot || process.env.SYSTEMROOT || 'C:\\Windows';
  assertWindowsLocalPath(root);
  return win32.join(root, 'System32', relative);
}

function fixedProcess(command, args, { env = process.env, timeoutMs = 30000 } = {}) {
  return new Promise((accept, reject) => {
    const child = spawn(command, args, { env, shell: false, windowsHide: true, stdio: 'ignore' });
    let settled = false;
    const finish = (ok) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      ok ? accept() : reject(failure('PLATFORM_BOUNDARY_FAILED', 'The required operating-system security operation failed.'));
    };
    const timer = setTimeout(() => { child.kill('SIGKILL'); finish(false); }, timeoutMs);
    child.on('error', () => finish(false));
    child.on('close', (code) => finish(code === 0));
  });
}

function waitForOwnedChildExit(child, timeoutMs) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true);
  return new Promise((accept) => {
    const exited = () => { clearTimeout(timer); accept(true); };
    const timer = setTimeout(() => { child.removeListener('exit', exited); accept(false); }, timeoutMs);
    child.once('exit', exited);
  });
}

export async function terminateProcessTree(child, signal = 'SIGTERM') {
  if (!Number.isSafeInteger(child?.pid) || child.pid <= 0) return;
  if (process.platform === 'win32') {
    // Only the worker's current live ChildProcess is eligible. Persisted job PIDs
    // are never accepted here, preventing cancellation against a reused PID.
    if (child.exitCode !== null || child.signalCode !== null) return;
    try {
      await fixedProcess(windowsSystemExecutable('taskkill.exe'), ['/PID', String(child.pid), '/T', '/F'], { timeoutMs: 10000 });
    } catch (error) {
      // A short-lived CLI can finish between spawning taskkill and its process
      // lookup. Preserve the request's original error when exit is verified.
      if (child.exitCode !== null || child.signalCode !== null) return;
      try { process.kill(child.pid, 0); }
      catch (probeError) { if (probeError.code === 'ESRCH') return; }
      throw error;
    }
  } else {
    try { process.kill(-child.pid, signal); }
    catch (error) {
      if (error.code === 'ESRCH') return;
      // macOS reports EPERM for a group containing only an unreaped zombie.
      // Yield until this owned child's exit is observed, then signal its group
      // again so surviving descendants still receive the requested termination.
      // A live child or a remaining permission failure must still fail closed.
      if (process.platform === 'darwin' && error.code === 'EPERM' && await waitForOwnedChildExit(child, 250)) {
        try { process.kill(-child.pid, signal); }
        catch (retryError) { if (retryError.code !== 'ESRCH') throw retryError; }
        return;
      }
      throw error;
    }
  }
}

// This script is fixed program text. The path is an environment value consumed
// by .NET filesystem APIs, never executable PowerShell syntax or an expression.
const DIRECTORY_ACL_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
$target = [System.IO.Path]::GetFullPath($env:GEMINI_PLUGIN_ACL_PATH)
$part = [System.IO.Path]::GetPathRoot($target)
foreach ($segment in $target.Substring($part.Length).Split([char]92)) {
  if ($segment.Length -eq 0) { continue }
  $part = [System.IO.Path]::Combine($part, $segment)
  if (([System.IO.File]::GetAttributes($part) -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'Reparse point refused' }
}
$identity = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
$system = New-Object System.Security.Principal.SecurityIdentifier('S-1-5-18')
if ($env:GEMINI_PLUGIN_ACL_ACTION -eq 'protect') {
  $acl = New-Object System.Security.AccessControl.DirectorySecurity
  $acl.SetAccessRuleProtection($true, $false)
  $acl.SetOwner($identity)
  $inherit = [System.Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [System.Security.AccessControl.InheritanceFlags]::ObjectInherit
  foreach ($sid in @($identity, $system)) {
    $rule = New-Object System.Security.AccessControl.FileSystemAccessRule($sid, [System.Security.AccessControl.FileSystemRights]::FullControl, $inherit, [System.Security.AccessControl.PropagationFlags]::None, [System.Security.AccessControl.AccessControlType]::Allow)
    $acl.AddAccessRule($rule)
  }
  [System.IO.Directory]::SetAccessControl($target, $acl)
}
$actual = [System.IO.Directory]::GetAccessControl($target)
if (-not $actual.AreAccessRulesProtected) { throw 'Inherited access refused' }
if ($actual.GetOwner([System.Security.Principal.SecurityIdentifier]).Value -ne $identity.Value) { throw 'Unexpected owner' }
$userAllowed = $false
foreach ($rule in $actual.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier])) {
  if ($rule.AccessControlType -eq [System.Security.AccessControl.AccessControlType]::Allow) {
    if ($rule.IdentityReference.Value -ne $identity.Value -and $rule.IdentityReference.Value -ne $system.Value) { throw 'Unexpected access rule' }
    if ($rule.IdentityReference.Value -eq $identity.Value -and ($rule.FileSystemRights -band [System.Security.AccessControl.FileSystemRights]::FullControl) -eq [System.Security.AccessControl.FileSystemRights]::FullControl) { $userAllowed = $true }
  } else { throw 'Unexpected deny rule' }
}
if (-not $userAllowed) { throw 'Owner access missing' }
`;

async function directoryAcl(path, protect) {
  const absolute = resolve(path);
  if (process.platform === 'win32') {
    assertWindowsLocalPath(absolute);
    const encoded = Buffer.from(DIRECTORY_ACL_SCRIPT, 'utf16le').toString('base64');
    await fixedProcess(windowsSystemExecutable('WindowsPowerShell\\v1.0\\powershell.exe'),
      ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', encoded],
      { env: { ...process.env, GEMINI_PLUGIN_ACL_PATH: absolute, GEMINI_PLUGIN_ACL_ACTION: protect ? 'protect' : 'verify' } });
  } else {
    let part = parse(absolute).root;
    for (const segment of absolute.slice(part.length).split('/').filter(Boolean)) {
      part = join(part, segment);
      if ((await lstat(part)).isSymbolicLink()) {
        const systemAlias = process.platform === 'darwin' && ['/var', '/tmp'].includes(part) && (await realpath(part)) === `/private${part}`;
        if (!systemAlias) throw failure('PLATFORM_BOUNDARY_FAILED', 'A private directory cannot contain a symlink.');
      }
    }
    const info = await lstat(absolute);
    if (!info.isDirectory() || info.isSymbolicLink() || (process.getuid && info.uid !== process.getuid()))
      throw failure('PLATFORM_BOUNDARY_FAILED', 'Invalid private directory.');
    if (protect) await chmod(absolute, 0o700);
    if (((await lstat(absolute)).mode & 0o777) !== 0o700)
      throw failure('PLATFORM_BOUNDARY_FAILED', 'A private directory has unsafe permissions.');
  }
  return absolute;
}

export const protectPrivateDirectory = (path) => directoryAcl(path, true);
export const verifyPrivateDirectory = (path) => directoryAcl(path, false);
