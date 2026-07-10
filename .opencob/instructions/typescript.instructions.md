---
applyTo: 'packages/**/src/**/*.{ts,tsx}'
description: TypeScript conventions for all monorepo packages
# owner: backend-team  # Uncomment to scope to CODEOWNERS owner
---

## TypeScript Conventions

- Use strict TypeScript and avoid `any`; if unavoidable, isolate and justify it.
- Prefer named exports over default exports.
- Keep modules focused: one primary responsibility per file.
- Add JSDoc for public APIs and externally consumed types.
- Use early returns to reduce nesting and improve readability.
- Validate external input with explicit guards rather than type assertions.
- Preserve ESM import style and avoid mixing module systems.
- Prefer pure functions for shared logic where practical to simplify testing.
