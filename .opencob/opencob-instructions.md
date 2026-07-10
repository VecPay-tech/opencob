# Project Instructions

These instructions are always included in the system prompt for every conversation.

## Project Context

OpenCob is a privacy-first, local-first AI coding assistant specialising in legacy language support.
The primary languages in scope are COBOL, RPG, PL/I, JCL, NATURAL, REXX, and Assembler — treat
these as first-class citizens in analysis, suggestions, and tooling decisions.

## General Guidelines

- Follow the project's existing code style and conventions (see CLAUDE.md)
- Write concise, readable code; prefer clarity over cleverness
- Add tests for new functionality — Vitest, no real I/O (use mocks)
- Run `pnpm lint`, `pnpm test`, and `pnpm build` before reporting substantial tasks complete
- Prefer editing existing files over creating new ones

## Response and Change Quality

- Start with the direct answer or result, then provide concise supporting details.
- Keep diffs minimal and scoped to the request; avoid opportunistic rewrites.
- Include file references for key changes so reviewers can verify quickly.
- If a requirement cannot be completed, state the blocker and provide the best viable alternative.
- When behavior changes, update docs and tests in the same change set.

## Architecture Awareness

- Core logic lives in `packages/core/src/` — changes here affect the CLI and VS Code extension
- Legacy language parsers are in `packages/core/src/legacy/` — Tree-sitter grammars, handle carefully
- LLM calls go through `packages/core/src/llm/` adapters — never call a provider SDK directly
- Tool definitions live in `packages/core/src/tools/` — group by category (read/edit/command/analysis/meta)
- Modes gate tool availability (`packages/core/src/modes/`) — respect mode boundaries in new tools

## Development Priorities

- Privacy and local-first execution are non-negotiable — no telemetry, no data leaving the machine
  unless the user explicitly configures a remote provider
- Legacy language fidelity over modern language assumptions — COBOL division structure, fixed-format
  RPG, JCL job steps all have specific syntax rules; verify against Tree-sitter grammar definitions
- Cross-platform compatibility — the tool runs on Windows, macOS, and Linux; use `path.join`, avoid
  shell-specific syntax, test commands with the cross-platform `command` tool abstraction
- Token efficiency — the `ConversationCompactor` manages budgets; new features should not balloon
  context unexpectedly

## Security and Privacy Guardrails

- Never log or commit secrets, keys, tokens, or proprietary customer data.
- Treat all workspace input as untrusted; sanitize where data crosses trust boundaries.
- Prefer allowlists and explicit capability checks for tool and command execution.
- Keep network access opt-in and explicit to preserve local-first guarantees.

## Monorepo Workflow

- Use `pnpm` (not npm or yarn) for all dependency and script operations.
- Prefer targeted commands first (for example, `pnpm --filter <pkg> test`) before full-repo runs.
- Respect Turborepo task boundaries and avoid unnecessary cross-package coupling.
- For user-facing changes, include a changeset (`pnpm changeset`) before merge.

## Conventions Reminder

- TypeScript: strict mode, ESM imports, no `any`, early returns, named exports
- Formatting: Prettier, 2 spaces, no semicolons, single quotes — run `pnpm format`
- Commits: Conventional Commits (`feat`, `fix`, `refactor`, etc.) with scope (`core`, `cli`, `extension`)
- User-facing changes require a changeset: `pnpm changeset`
