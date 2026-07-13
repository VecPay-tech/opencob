#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
echo "Notice: scripts/local-vsix-smoke.sh is deprecated. Use scripts/dev/local-vsix-smoke.sh."
bash "$ROOT_DIR/scripts/dev/local-vsix-smoke.sh"