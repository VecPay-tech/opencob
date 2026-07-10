# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Is

OpenCob is a privacy-first, local-first AI coding assistant with strong legacy language support (COBOL, RPG, PL/I, JCL, NATURAL, REXX, Assembler). It's a pnpm monorepo managed by Turborepo with three main packages:

- `packages/core` — Agent engine, tools, modes, LLM adapters, RAG pipeline (TypeScript ESM)
- `packages/extension` — VS Code extension (esbuild → CJS, externals: `vscode`)
- `packages/cli` — Terminal REPL (esbuild → single bundle)

**Requirements**: Node >= 22, pnpm >= 10, VS Code >= 1.100.0 (for extension development).

## Commands

```bash
# Install
pnpm install

# Build all packages (respects dependency order via Turborepo)
pnpm build

# Run all tests
pnpm test

# Run only core tests
pnpm --filter @opencob/core test

# Run a single test file
pnpm --filter @opencob/core test -- tests/agent-loop.test.ts

# Run tests matching a pattern
pnpm --filter @opencob/core test -- --reporter=verbose -t "pattern"

# Watch mode for tests
pnpm test -- --watch

# Watch extension (rebuilds on src changes)
pnpm --filter opencob watch

# Lint, typecheck, format
pnpm lint
pnpm typecheck
pnpm format
pnpm format:check

# Package VS Code extension as VSIX
cd packages/extension && pnpm package

# Add a changeset before merging user-facing changes
pnpm changeset

# Clean all dist/ directories
pnpm clean
```

For VS Code extension development, press **F5** in VS Code to launch the Extension Development Host.

## Architecture

### Agent Loop

The core agent loop lives in `packages/core/src/agent/`. The flow is:

1. User prompt arrives via CLI or VS Code extension
2. `AgentLoop` initializes with a LLM adapter, tool registry, and mode engine
3. `ModeEngine` selects available tools based on the active mode
4. `RedactionEngine` (`src/security/`) masks secrets before any LLM call
5. LLM adapter streams a response; tool calls are extracted and executed
6. `PostEditVerifier` validates file changes; `ConversationCompactor` manages token budgets
7. Events emitted: `text`, `tool_call`, `tool_result`, `error`, `done`, `verification`

### Modes

Modes (`packages/core/src/modes/`) gate which tools are available:

- **Code** — full read/write/execute access
- **Ask** — read-only Q&A
- **Plan** — planning + markdown output
- **Advanced** — all tools
- **Orchestrator** — delegates to sub-modes

Custom modes can be defined in `.opencob/custom_modes.json`.

### Tools

Tools (`packages/core/src/tools/`) are grouped into:

- `read` — read files, list, search, semantic search, code definitions
- `edit` — write, apply diff, multi-edit
- `command` — cross-platform shell execution
- `mcp` — Model Context Protocol integrations
- `analysis` — complexity, quality, dependency, refactoring analysis
- `meta` — mode switching, undo, ask followup

### LLM Adapters

`packages/core/src/llm/` provides pluggable adapters for Ollama, OpenAI, Azure OpenAI, Anthropic, Google Gemini, and LiteLLM. The `ModelRouter` routes chat/completion/embedding calls to different configured models. Configure via `.env` or VS Code settings (`OpenCob.*`).

### Legacy Language Support

`packages/core/src/legacy/` contains Tree-sitter-based parsers for COBOL, RPG, and PL/I, plus a `ModernizationAssistant` that suggests Java/Python/TypeScript equivalents.

### RAG Pipeline

`packages/core/src/indexer/` implements a workspace indexer and vector store. `WorkspaceIndexer` scans for definitions and cross-references; semantic search uses embeddings routed through `ModelRouter`.

## Conventions

**TypeScript**: strict mode, ESM imports, no `any`, unused variables prefixed with `_`, named exports preferred over default exports, JSDoc on public APIs, early returns to reduce nesting.

**Formatting**: Prettier with 2 spaces, no semicolons, single quotes. Run `pnpm format` — don't manually fight it.

**File organization**: source in `src/`, tests in `tests/`, one class/module per file, barrel exports via `index.ts`.

**Tests**: Vitest with globals enabled. Test files are `*.test.ts`. No real network or filesystem dependencies — use mocks.

**Commits**: Conventional Commits required (`feat`, `fix`, `docs`, `refactor`, `perf`, `test`, `build`, `ci`, `chore`). Scopes: `core`, `cli`, `extension`, `docs`, `deps`.

**Releases**: User-facing changes require a changeset (`pnpm changeset`) before merging.

**Before finishing substantial changes**: run `pnpm lint`, `pnpm test`, and `pnpm build`.

## Key Configuration Files

| File                               | Purpose                                                         |
| ---------------------------------- | --------------------------------------------------------------- |
| `.env` (from `.env.example`)       | LLM provider credentials, model names, log level                |
| `.opencob/custom_modes.json`       | Custom mode definitions                                         |
| `.opencob/mcp-servers.json`        | MCP server configurations                                       |
| `.opencob/opencob-instructions.md` | Per-project system prompt injected into every conversation      |
| `.opencob/instructions/`           | Per-file-glob coding conventions (e.g. TypeScript rules)        |
| `.opencob/hooks/`                  | Dev hooks (e.g. test reminder on src changes)                   |
| `turbo.json`                       | Task dependency graph (`build` → `test`, `build` → `typecheck`) |
| `tsconfig.base.json`               | Shared TS config (ES2022, strict, ESM, source maps)             |
