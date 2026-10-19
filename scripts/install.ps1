# Install LCU on Windows: find the official ChatGPT Store app registered for this account, check its identity
# and signature, and run its own node.exe on scripts/install_windows.mjs with all arguments. The app is never
# downloaded or installed here. Run: powershell -ExecutionPolicy Bypass -File scripts\install.ps1 --runtime-only
$ErrorActionPreference = 'Stop'

function Fail([string]$Message) {
  [Console]::Error.WriteLine("LCU Windows installer: $Message")
  exit 1
}

$installer = Join-Path $PSScriptRoot 'install_windows.mjs'
$packages = @(Get-AppxPackage -Name 'OpenAI.Codex')
if ($packages.Count -eq 0) {
  Fail ('LCU requires the official ChatGPT desktop app, which includes Codex, to be installed first. LCU does not ' +
    'download or install the app. Install it from https://chatgpt.com/download/ for this Windows account and rerun LCU.')
}
if ($packages.Count -ne 1) { Fail 'Expected exactly one registered OpenAI.Codex package for this account.' }
$package = $packages[0]
# The same identity the Node installer checks again in full: OpenAI's publisher, a Store signature, x64, and an
# installed (not development-mode) package that Windows reports as intact.
if ($package.Publisher -ne 'CN=50BDFD77-8903-4850-9FFE-6E8522F64D5B' -or
    $package.SignatureKind.ToString() -ne 'Store' -or
    $package.Architecture.ToString() -ne 'X64' -or
    $package.IsDevelopmentMode -or
    $package.Status.ToString() -ne 'Ok') {
  Fail 'The registered ChatGPT package is not the intact official Windows x64 Store app.'
}
$runtime = Join-Path $package.InstallLocation 'app\resources\cua_node\bin'
$node = Join-Path $runtime 'node.exe'
if (-not (Test-Path -LiteralPath $node -PathType Leaf)) { Fail "The registered ChatGPT app has no $node." }

# The protected WindowsApps directory may refuse direct execution; then run a temporary copy of the same
# node.exe (it needs nothing else from cua_node to run the installer).
$scratch = $null
try {
  & $node --version *> $null
  $usable = $LASTEXITCODE -eq 0
} catch {
  $usable = $false
}
if (-not $usable) {
  $scratch = Join-Path ([IO.Path]::GetTempPath()) ('lcu-node-' + [Guid]::NewGuid().ToString('N'))
  New-Item -ItemType Directory -Path $scratch | Out-Null
  Copy-Item -LiteralPath $node -Destination $scratch
  if ((Get-FileHash -LiteralPath $node).Hash -ne (Get-FileHash -LiteralPath (Join-Path $scratch 'node.exe')).Hash) {
    Remove-Item -LiteralPath $scratch -Recurse -Force
    Fail 'The temporary copy of the app''s node.exe differs from the original.'
  }
  $node = Join-Path $scratch 'node.exe'
}
try {
  # Windows PowerShell 5.1 turns a native command's stderr into errors; with 'Stop' the first one would abort.
  $ErrorActionPreference = 'Continue'
  & $node $installer @args
  $status = $LASTEXITCODE
} finally {
  $ErrorActionPreference = 'Stop'
  if ($scratch) { Remove-Item -LiteralPath $scratch -Recurse -Force -ErrorAction SilentlyContinue }
}
exit $status
