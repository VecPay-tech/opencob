#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
EXTENSION_ID="${OPENCOB_EXTENSION_ID:-opencob.opencob}"

VSCODE_CLI=""
if command -v code >/dev/null 2>&1; then
  VSCODE_CLI="code"
elif command -v code-insiders >/dev/null 2>&1; then
  VSCODE_CLI="code-insiders"
else
  echo "Error: VS Code CLI not found. Install 'code' command from VS Code Command Palette."
  exit 1
fi

echo "==> Uninstalling existing extension (if installed): $EXTENSION_ID"
if "$VSCODE_CLI" --uninstall-extension "$EXTENSION_ID" >/dev/null 2>&1; then
  echo "Removed: $EXTENSION_ID"
else
  echo "Not installed (continuing): $EXTENSION_ID"
fi

echo "==> Building, packaging, and reinstalling latest VSIX"
bash "$ROOT_DIR/scripts/dev/local-vsix-cycle.sh"

echo "==> Smoke cycle complete"
echo "Tip: reload the VS Code window to ensure activation paths are reinitialized."