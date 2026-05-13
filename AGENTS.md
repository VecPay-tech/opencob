# AGENTS

This file defines guardrails for AI coding agents working in OpenCob.

## Scope

- Apply these rules repository-wide unless a nested AGENTS file overrides them.

## Engineering Rules

- Use pnpm for dependency management.
- Keep changes minimal and focused.
- Add or update tests for behavior changes.
- Run `pnpm lint`, `pnpm test`, and `pnpm build` before finishing substantial changes.
- Do not commit generated artifacts unless explicitly requested.

## Security Rules

- Never commit secrets, tokens, or credentials.
- Treat user input as untrusted.
- Prefer explicit allowlists over permissive defaults.
- Follow least-privilege principles for integrations and tool execution.

## PR Quality Rules

- Use Conventional Commit style in commit messages.
- Add a changeset for any user-facing change.
- Keep docs aligned with behavior changes.
