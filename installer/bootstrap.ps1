param([switch]$DryRun)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
if ($DryRun) {
  Write-Host 'Bootstrap plan: reuse Node.js 20+, otherwise download private Node.js 24.22.0 from nodejs.org and verify its pinned SHA-256. No files or downloads created.'
  $node = Get-Command node.exe -ErrorAction SilentlyContinue
  if ($node) { & $node.Source (Join-Path $PSScriptRoot 'install.mjs') --dry-run; exit $LASTEXITCODE }
  exit 0
}
$node = Get-Command node.exe -ErrorAction SilentlyContinue
$nodePath = $null
if ($node) {
  & $node.Source -e 'process.exit(Number(process.versions.node.split(String.fromCharCode(46))[0]) >= 20 ? 0 : 1)'
  if ($LASTEXITCODE -eq 0) { $nodePath = $node.Source }
}
if (-not $nodePath) {
  $cpu = if ($env:PROCESSOR_ARCHITEW6432) { $env:PROCESSOR_ARCHITEW6432 } else { $env:PROCESSOR_ARCHITECTURE }
  switch ($cpu) {
    'ARM64' { $arch = 'arm64'; $expected = '3a5c209a5bc59e65b3bc0fa13ed5e166a26bd3d55332847f498b76b037408d61' }
    'AMD64' { $arch = 'x64'; $expected = 'f9683a19877e12a9b167305c8db71040d812876359de21f0d2e97c3f321f80c3' }
    default { throw 'This installer supports Windows x64 and ARM64.' }
  }
  $runtimeParent = Join-Path $env:LOCALAPPDATA 'gemini-plugin-cc\runtimes'
  $check = $runtimeParent
  while ($check) {
    if (Test-Path -LiteralPath $check) {
      if (((Get-Item -LiteralPath $check -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'Refusing an installation path containing a link or junction.' }
    }
    $parent = Split-Path -Parent $check
    if ($parent -eq $check) { break }
    $check = $parent
  }
  $runtime = Join-Path $runtimeParent "node-v24.22.0-win-$arch"
  $nodePath = Join-Path $runtime 'node.exe'
  if (-not (Test-Path -LiteralPath $nodePath)) {
    $temporary = Join-Path ([IO.Path]::GetTempPath()) ([Guid]::NewGuid().ToString('N'))
    New-Item -ItemType Directory -Path $temporary | Out-Null
    try {
      $archive = "node-v24.22.0-win-$arch.zip"
      $download = Join-Path $temporary $archive
      Write-Host 'Downloading private Node.js from nodejs.org; existing software is preserved.'
      [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
      Invoke-WebRequest -Uri "https://nodejs.org/download/release/v24.22.0/$archive" -OutFile $download -UseBasicParsing
      # Use framework APIs so checksum verification and ZIP extraction do not
      # depend on optional PowerShell cmdlet module discovery.
      $sha256 = [System.Security.Cryptography.SHA256]::Create()
      $archiveStream = [System.IO.File]::OpenRead($download)
      try { $actual = [System.BitConverter]::ToString($sha256.ComputeHash($archiveStream)).Replace('-', '').ToLowerInvariant() }
      finally { $archiveStream.Dispose(); $sha256.Dispose() }
      if ($actual -ne $expected) { throw 'Node.js checksum mismatch. Installation stopped.' }
      $compressionAssembly = [IO.Path]::Combine([Runtime.InteropServices.RuntimeEnvironment]::GetRuntimeDirectory(), 'System.IO.Compression.FileSystem.dll')
      [void][System.Reflection.Assembly]::LoadFrom($compressionAssembly)
      [System.IO.Compression.ZipFile]::ExtractToDirectory($download, $temporary)
      New-Item -ItemType Directory -Path $runtimeParent -Force | Out-Null
      if (Test-Path -LiteralPath $runtime) { throw 'Incomplete Node runtime exists. Inspect it before retrying.' }
      Move-Item -LiteralPath (Join-Path $temporary "node-v24.22.0-win-$arch") -Destination $runtime
    } finally { Remove-Item -LiteralPath $temporary -Recurse -Force }
  }
  $reportedVersion = & $nodePath --version
  if ($LASTEXITCODE -ne 0 -or $reportedVersion -ne 'v24.22.0') { throw 'Private Node version check failed.' }
}
$env:PATH = (Split-Path $nodePath) + ';' + (Join-Path $env:USERPROFILE '.local\bin') + ';' + $env:PATH
& $nodePath (Join-Path $PSScriptRoot 'install.mjs')
$result = $LASTEXITCODE
if ($result -eq 2) {
  Write-Host 'Setup needs Git and/or Claude Code. Install missing tools from the official pages, then double-click Install.cmd again.'
  if (-not (Get-Command git.exe -ErrorAction SilentlyContinue)) { Start-Process 'https://git-scm.com/downloads/win' }
  if (-not (Get-Command claude.exe -ErrorAction SilentlyContinue)) { Start-Process 'https://code.claude.com/docs/en/setup' }
}
if ($result -eq 0 -and $env:CI -ne 'true') { Start-Process explorer.exe -ArgumentList ('"' + (Join-Path $env:LOCALAPPDATA 'gemini-plugin-cc') + '"') }
exit $result
