Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$rootDir = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$extDir = Join-Path $rootDir 'packages\extension'

if (-not (Get-Command pnpm -ErrorAction SilentlyContinue)) {
  throw 'Error: pnpm is required but not found in PATH.'
}

$vscodeCli = if (Get-Command code -ErrorAction SilentlyContinue) {
  'code'
} elseif (Get-Command code-insiders -ErrorAction SilentlyContinue) {
  'code-insiders'
} else {
  throw "Error: VS Code CLI not found. Install 'code' command from VS Code Command Palette."
}

Write-Host '==> Building extension'
& pnpm --filter opencob build

Write-Host '==> Packaging VSIX'
Push-Location $extDir
try {
  & pnpm dlx @vscode/vsce package --no-dependencies
  $vsix = Get-ChildItem -File -Filter 'opencob-*.vsix' |
    Sort-Object LastWriteTime -Descending |
    Select-Object -First 1

  if (-not $vsix) {
    throw 'Error: VSIX not found after packaging.'
  }

  Write-Host "==> Installing $($vsix.Name) into local VS Code"
  & $vscodeCli --install-extension $vsix.FullName --force
}
finally {
  Pop-Location
}

Write-Host '==> Done'
Write-Host "Installed: $extDir\$($vsix.Name)"
Write-Host 'Tip: reload VS Code window to test latest extension build.'