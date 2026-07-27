Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$rootDir = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$extensionId = if ($env:OPENCOB_EXTENSION_ID) { $env:OPENCOB_EXTENSION_ID } else { 'opencob.opencob' }

if (-not (Get-Command code -ErrorAction SilentlyContinue) -and
    -not (Get-Command code-insiders -ErrorAction SilentlyContinue)) {
  throw "Error: VS Code CLI not found. Install 'code' command from VS Code Command Palette."
}

$vscodeCli = if (Get-Command code -ErrorAction SilentlyContinue) {
  'code'
} else {
  'code-insiders'
}

Write-Host "==> Uninstalling existing extension (if installed): $extensionId"
try {
  & $vscodeCli --uninstall-extension $extensionId | Out-Null
  Write-Host "Removed: $extensionId"
} catch {
  Write-Host "Not installed (continuing): $extensionId"
}

Write-Host '==> Building, packaging, and reinstalling latest VSIX'
& (Join-Path $PSScriptRoot 'local-vsix-cycle.ps1')

Write-Host '==> Smoke cycle complete'
Write-Host 'Tip: reload the VS Code window to ensure activation paths are reinitialized.'