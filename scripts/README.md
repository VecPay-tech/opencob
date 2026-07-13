# Scripts Layout

The scripts folder is organized by purpose.

- `dev/` — local developer workflows
  - `local-vsix-cycle.sh` build/package/install local VSIX
  - `local-vsix-smoke.sh` uninstall/reinstall smoke cycle
- `validate-opencob.mjs` — `.opencob` configuration validation used by CI

Compatibility wrappers remain at:

- `scripts/local-vsix-cycle.sh`
- `scripts/local-vsix-smoke.sh`

These wrappers forward to `scripts/dev/*` and may be removed in a future major version.
