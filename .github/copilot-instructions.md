# OpenCob Copilot Instructions

This is a pnpm monorepo using Turborepo. Key packages:

- `packages/extension` — VS Code extension (esbuild bundled, CJS output)
- `packages/core` — Shared engine (TypeScript ESM, exports modes/tools/LLM adapters)
- `packages/cli` — CLI interface

## Commands

- **Install**: `pnpm install`
- **Build all**: `pnpm build`
- **Build extension only**: `pnpm --filter opencob build`
- **Watch extension**: `pnpm --filter opencob watch`
- **Test all**: `pnpm test`
- **Test core**: `pnpm --filter @opencob/core test`
- **Lint**: `pnpm lint`
- **Package VSIX**: `cd packages/extension && pnpm package`

## Conventions

- Use Conventional Commits.
- Use pnpm (not npm/yarn).
- Extension entry: `packages/extension/src/extension.ts`
- The extension depends on `@opencob/core` via `workspace:*`.
- Extension bundles with esbuild to `dist/extension.js` (CJS, externals: `vscode`).
- Node >= 22, pnpm >= 10, VS Code >= 1.100.0.
