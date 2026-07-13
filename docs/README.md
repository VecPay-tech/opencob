# OpenCob Documentation

## Community Edition Docs

For contributor documentation, see the root-level files:

- [README.md](../README.md) — Quick start and project overview
- [CONTRIBUTING.md](../CONTRIBUTING.md) — Development setup, coding standards, PR process
- [SECURITY.md](../SECURITY.md) — Vulnerability reporting policy
- [AGENTS.md](../AGENTS.md) — AI agent guardrails
- [docs/pages](./pages) — User-facing docs pages (Nextra)

## Architecture

OpenCob is a **pnpm monorepo** with three packages:

| Package              | Purpose                                                               | Entry Point                           |
| -------------------- | --------------------------------------------------------------------- | ------------------------------------- |
| `@opencob/core`      | Agent engine, tool system, mode engine, MCP client, LLM adapters, RAG | `packages/core/src/index.ts`          |
| `@opencob/cli`       | Interactive REPL + headless `--task` mode                             | `packages/cli/src/index.ts`           |
| `@opencob/extension` | VS Code extension: chat panel, inline completion, mode selector       | `packages/extension/src/extension.ts` |

### Core Module Map

```
packages/core/src/
├── agent/              # AgentLoop, OrchestratorEngine, TaskComplexity
├── completion/         # FIM engine, model routing
├── config/             # ConfigLoader, project settings
├── context/            # MentionParser, PromptEnhancer
├── conversation/       # ConversationManager, Compactor
├── findings/           # Security/quality scanner
├── indexing/           # WorkspaceIndexer, RAG pipeline, vector store
├── legacy/             # COBOL/RPG/PL-I parsers, ModernizationAssistant
├── llm/                # OllamaAdapter, ModelRouter
├── mcp/                # MCPClient (stdio + SSE)
├── modes/              # ModeEngine, built-in + custom YAML modes
├── privacy/            # RedactionEngine, FileFilter
├── skills/             # SkillsLoader (.OpenCob/skills/)
├── snapshots/          # SnapshotManager (checkpoint/rollback)
└── tools/              # ToolRegistry + 20 tool implementations
```

## Enterprise Edition

The Enterprise Edition documentation lives in the `opencob_ee` repository under `docs/`:

- `ADR.md` — Architecture Decision Records
- `ARCHITECTURE.md` — System component overview
- `FEATURE_SPEC.md` — CE feature specifications
- `FEATURE_SPEC_EE.md` — EE feature specifications
- `IMPLEMENTATION_STATUS.md` — Build progress tracker

## CI and Release Docs Pointers

- `.github/workflows/ci.yaml` — Build/test/lint/typecheck + `.opencob` validation
- `.github/workflows/package-extension.yaml` — VSIX packaging and release attachment
- `.github/workflows/secret-scan.yaml` — gitleaks-based secret scanning
- `.github/workflows/codeql.yaml` — code scanning analysis

## Spikes

The `spikes/` directory contains technical research and prototypes:

| Spike | Topic                     |
| ----- | ------------------------- |
| s0-1  | Continue.dev evaluation   |
| s0-2  | State machine patterns    |
| s0-3  | Vector DB comparison      |
| s0-4  | WebView performance       |
| s0-5  | Tree-sitter COBOL grammar |
| s0-6  | Ollama FIM integration    |
| s0-7  | Chat API design           |
| s0-8  | Codex/Driver-X comparison |

These are not built or tested as part of CI — they are research artifacts.
