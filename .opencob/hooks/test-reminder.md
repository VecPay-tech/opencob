---
event: onFileChange
applyTo: 'packages/**/src/**/*.{ts,tsx}'
description: Remind contributors to update tests for source changes in monorepo packages
---

When modifying package source files, verify that related tests were updated.

Expected checks:

- Look for tests under package-local `tests/` directories.
- Prefer colocated behavior-focused tests for new logic.
- If no test is added or updated, include a short reason in your final response.
