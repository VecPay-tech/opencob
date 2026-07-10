#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
EXT_DIR="$ROOT_DIR/packages/extension"

if ! command -v pnpm >/dev/null 2>&1; then
  echo "Error: pnpm is required but not found in PATH."
  exit 1
fi

VSCODE_CLI=""
if command -v code >/dev/null 2>&1; then
  VSCODE_CLI="code"
elif command -v code-insiders >/dev/null 2>&1; then
  VSCODE_CLI="code-insiders"
else
  echo "Error: VS Code CLI not found. Install 'code' command from VS Code Command Palette."
  exit 1
fi

echo "==> Building extension"
pnpm --filter opencob build

echo "==> Packaging VSIX"
cd "$EXT_DIR"
pnpm dlx @vscode/vsce package --no-dependencies

VSIX_FILE="$(ls -1t opencob-*.vsix | head -n 1)"
if [[ -z "$VSIX_FILE" ]]; then
  echo "Error: VSIX not found after packaging."
  exit 1
fi

echo "==> Installing $VSIX_FILE into local VS Code"
"$VSCODE_CLI" --install-extension "$VSIX_FILE" --force

echo "==> Done"
echo "Installed: $EXT_DIR/$VSIX_FILE"
echo "Tip: reload VS Code window to test latest extension build."
