# Contributing to OpenCob

Thank you for your interest in contributing to OpenCob! This document provides guidelines and instructions for contributing.

## Table of Contents

- [Code of Conduct](#code-of-conduct)
- [Getting Started](#getting-started)
- [Development Setup](#development-setup)
- [Making Changes](#making-changes)
- [Pull Request Process](#pull-request-process)
- [Coding Standards](#coding-standards)
- [Testing](#testing)
- [Commit Convention](#commit-convention)

## Code of Conduct

This project follows the [Contributor Covenant v2.1](CODE_OF_CONDUCT.md). By participating, you are expected to uphold this code.

## Getting Started

1. **Fork** the repository on GitHub.
2. **Clone** your fork locally:
   ```bash
   git clone https://github.com/<your-username>/opencob.git
   cd opencob
   ```
3. **Install dependencies**:
   ```bash
   pnpm install
   ```
4. **Create a branch** for your change:
   ```bash
   git checkout -b feat/my-feature
   ```

## Development Setup

### Prerequisites

| Tool    | Version   | Install                             |
| ------- | --------- | ----------------------------------- |
| Node.js | >= 22.0.0 | [nodejs.org](https://nodejs.org/)   |
| pnpm    | >= 10.0.0 | `npm install -g pnpm`               |
| Git     | >= 2.40   | [git-scm.com](https://git-scm.com/) |

### Build & Test

```bash
pnpm build        # Build all packages (Turborepo)
pnpm test         # Run all tests (Vitest)
pnpm lint         # Lint all packages (ESLint)
pnpm typecheck    # Type-check all packages (tsc --noEmit)
pnpm validate:opencob # Validate .opencob shared agent config
pnpm format       # Format code (Prettier)
pnpm format:check # Check formatting without changes
```

### Package-Specific Development

```bash
# Core library
cd packages/core
pnpm test -- --watch     # Watch mode for tests

# VS Code extension
cd packages/extension
# Press F5 in VS Code to launch Extension Development Host

# CLI
cd packages/cli
pnpm build && node dist/index.js
```

## Making Changes

1. **Keep changes focused.** One PR = one logical change.
2. **Write tests** for new functionality. Maintain or improve coverage.
3. **Update types.** All public APIs must have TypeScript types.
4. **Don't break the build.** Run `pnpm build && pnpm test` before pushing.

### What We Accept

- Bug fixes with regression tests
- New tools, modes, or MCP integrations
- Legacy language grammar improvements
- Documentation improvements
- Performance optimizations with benchmarks

### What Needs Discussion First

Open an issue or discussion before submitting PRs for:

- New packages or major architectural changes
- Breaking changes to public APIs
- New runtime dependencies
- Changes to the mode system or tool approval flow

## Pull Request Process

1. **Fill out the PR template** completely.
2. **Ensure CI passes** — all checks must be green.
3. **Request review** from a code owner (see [CODEOWNERS](.github/CODEOWNERS)).
4. **Address feedback** promptly.
5. **Squash commits** if requested.

### PR Checklist

- [ ] Tests pass (`pnpm test`)
- [ ] Build succeeds (`pnpm build`)
- [ ] Linting passes (`pnpm lint`)
- [ ] Types check (`pnpm typecheck`)
- [ ] OpenCob config validates (`pnpm validate:opencob`)
- [ ] Formatting is correct (`pnpm format:check`)
- [ ] Changeset added (if user-facing change)

## Coding Standards

### TypeScript

- **Strict mode** enabled (`strict: true` in tsconfig).
- **ESM** — all packages use ES modules.
- **No `any`** unless absolutely necessary (enforced by ESLint warning).
- **Unused variables** prefixed with `_` (`_unused`).

### Style

- **Prettier** handles formatting. Don't fight it.
- **2 spaces** for indentation.
- **No semicolons** in Prettier config (project preference).
- **Single quotes** for strings.

### File Organization

- Source in `src/`, tests in `tests/`.
- One class/module per file.
- Barrel exports via `index.ts`.

## Testing

We use [Vitest](https://vitest.dev/) for all testing.

```bash
pnpm test                          # Run all tests
pnpm --filter @opencob/core test   # Run core tests only
pnpm test -- --watch               # Watch mode
pnpm test -- --coverage            # With coverage report
```

### Test Guidelines

- **Unit tests** for all public functions.
- **Integration tests** for tool chains and agent workflows.
- **Test file naming**: `*.test.ts` in the `tests/` directory.
- **No test dependencies on network or file system** — use mocks.

## Commit Convention

We use [Conventional Commits](https://www.conventionalcommits.org/):

```
<type>(<scope>): <description>

[optional body]

[optional footer]
```

### Types

| Type       | Description                                             |
| ---------- | ------------------------------------------------------- |
| `feat`     | New feature                                             |
| `fix`      | Bug fix                                                 |
| `docs`     | Documentation only                                      |
| `style`    | Formatting, missing semicolons, etc.                    |
| `refactor` | Code change that neither fixes a bug nor adds a feature |
| `perf`     | Performance improvement                                 |
| `test`     | Adding or correcting tests                              |
| `build`    | Build system or external dependencies                   |
| `ci`       | CI configuration                                        |
| `chore`    | Other changes that don't modify src or test files       |

### Scopes

| Scope       | Package              |
| ----------- | -------------------- |
| `core`      | `@opencob/core`      |
| `cli`       | `@opencob/cli`       |
| `extension` | `@opencob/extension` |
| `docs`      | Documentation        |
| `deps`      | Dependencies         |

### Examples

```
feat(core): add COBOL paragraph-level refactoring tool
fix(extension): prevent ghost text flickering on rapid typing
docs: update contributing guidelines
ci: add CodeQL security scanning workflow
```

## Contributor License Agreement (CLA)

By submitting a pull request, you agree that your contributions are licensed under the [Apache License 2.0](LICENSE), and you grant the OpenCob project the right to sublicense your contributions for use in OpenCob Enterprise Edition under a commercial license.

## Questions?

- Open a [GitHub Discussion](https://github.com/opencob/opencob/discussions)
- File an [Issue](https://github.com/opencob/opencob/issues)

---

Thank you for contributing to OpenCob!
