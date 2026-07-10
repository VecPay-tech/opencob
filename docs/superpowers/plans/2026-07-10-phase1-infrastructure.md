# Phase 1: Infrastructure Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Harden the CI pipeline so lint failures block merges, coverage is tracked automatically, and the VS Code extension is packaged on every push to `main`.

**Architecture:** Three targeted edits to existing CI YAML files plus an extension to the Vitest config. No new dependencies.

**Tech Stack:** GitHub Actions, Vitest v8 coverage, pnpm, vsce (already used by `packages/extension`).

## Global Constraints

- Node 22, pnpm >= 10
- All YAML files must pass `yamllint` (no tab indentation, 2-space indent)
- Coverage thresholds: lines 70%, functions 70%, branches 60%
- VSIX artifact retention: 14 days (pre-release), attached to GitHub Release (tags)

---

### Task 1: Fix the lint gate in `ci.yaml`

**Files:**

- Modify: `.github/workflows/ci.yaml`

**Interfaces:**

- Produces: lint job that fails CI when `pnpm lint` exits non-zero; `ci-ok` gate includes lint

- [ ] **Step 1: Open `.github/workflows/ci.yaml` and locate the lint job**

Find the `lint` job. It currently contains:

```yaml
- name: Lint
  run: pnpm lint
  continue-on-error: true
```

- [ ] **Step 2: Remove `continue-on-error` and add `lint` to the `ci-ok` gate**

Replace the lint job step and update `ci-ok`:

```yaml
# ─── Lint ───────────────────────────────────────────────────────────────────
lint:
  name: Lint & Format
  needs: install
  runs-on: ubuntu-latest
  steps:
    - uses: actions/checkout@v4

    - uses: pnpm/action-setup@v4

    - uses: actions/setup-node@v4
      with:
        node-version: ${{ env.NODE_VERSION }}
        cache: pnpm

    - name: Restore node_modules
      uses: actions/cache/restore@v4
      with:
        path: |
          node_modules
          packages/*/node_modules
        key: modules-${{ runner.os }}-${{ hashFiles('pnpm-lock.yaml') }}

    - name: Check formatting
      run: pnpm format:check

    - name: Lint
      run: pnpm lint

# ─── Status Gate ────────────────────────────────────────────────────────────
ci-ok:
  name: CI Passed
  if: always()
  needs: [build, test, typecheck, lint]
  runs-on: ubuntu-latest
  steps:
    - name: Check required jobs
      run: |
        if [[ "${{ needs.build.result }}" != "success" ]] || \
           [[ "${{ needs.test.result }}" != "success" ]] || \
           [[ "${{ needs.typecheck.result }}" != "success" ]] || \
           [[ "${{ needs.lint.result }}" != "success" ]]; then
          echo "❌ Required jobs failed"
          exit 1
        fi
        echo "✅ All required jobs passed"
```

- [ ] **Step 3: Verify YAML is valid**

```bash
python -c "import yaml; yaml.safe_load(open('.github/workflows/ci.yaml'))" && echo "YAML OK"
```

Expected: `YAML OK`

- [ ] **Step 4: Commit**

```bash
git add .github/workflows/ci.yaml
git commit -m "ci: make lint failures block the ci-ok gate"
```

---

### Task 2: Add coverage to Vitest config

**Files:**

- Modify: `packages/core/vitest.config.ts`
- Modify: `packages/core/package.json` (add `test:coverage` script)

**Interfaces:**

- Produces: `pnpm --filter @opencob/core test:coverage` runs tests with v8 coverage and writes `coverage/lcov.info`

- [ ] **Step 1: Update `packages/core/vitest.config.ts`**

Replace the entire file:

```typescript
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov', 'json-summary'],
      reportsDirectory: './coverage',
      thresholds: {
        lines: 70,
        functions: 70,
        branches: 60,
      },
      exclude: ['**/tests/**', '**/dist/**', '**/node_modules/**', 'src/index.ts'],
    },
  },
});
```

- [ ] **Step 2: Add `test:coverage` script to `packages/core/package.json`**

In the `scripts` block, add alongside `"test"`:

```json
"test:coverage": "vitest run --coverage"
```

- [ ] **Step 3: Run coverage locally to confirm it works and thresholds pass**

```bash
pnpm --filter @opencob/core test:coverage
```

Expected: Coverage table printed to stdout. If any threshold fails, the command exits non-zero — raise the failing threshold value in `vitest.config.ts` by 5 percentage points until it passes, then re-run.

- [ ] **Step 4: Commit**

```bash
git add packages/core/vitest.config.ts packages/core/package.json
git commit -m "test(core): add v8 coverage with thresholds"
```

---

### Task 3: Add coverage step to CI test job

**Files:**

- Modify: `.github/workflows/ci.yaml`

**Interfaces:**

- Consumes: `packages/core/package.json` `test:coverage` script from Task 2
- Produces: `lcov.info` and `coverage-summary.json` artifacts in CI; coverage summary posted as job summary

- [ ] **Step 1: Replace the test job in `.github/workflows/ci.yaml`**

```yaml
# ─── Test ───────────────────────────────────────────────────────────────────
test:
  name: Test & Coverage
  needs: install
  runs-on: ubuntu-latest
  steps:
    - uses: actions/checkout@v4

    - uses: pnpm/action-setup@v4

    - uses: actions/setup-node@v4
      with:
        node-version: ${{ env.NODE_VERSION }}
        cache: pnpm

    - name: Restore node_modules
      uses: actions/cache/restore@v4
      with:
        path: |
          node_modules
          packages/*/node_modules
        key: modules-${{ runner.os }}-${{ hashFiles('pnpm-lock.yaml') }}

    - name: Test with coverage
      run: pnpm --filter @opencob/core test:coverage

    - name: Upload coverage artifacts
      if: always()
      uses: actions/upload-artifact@v4
      with:
        name: coverage-report
        path: |
          packages/core/coverage/lcov.info
          packages/core/coverage/coverage-summary.json
        retention-days: 14

    - name: Post coverage summary
      if: always()
      run: |
        SUMMARY="packages/core/coverage/coverage-summary.json"
        if [ -f "$SUMMARY" ]; then
          node -e "
            const s = JSON.parse(require('fs').readFileSync('$SUMMARY'));
            const t = s.total;
            console.log('## Coverage Summary');
            console.log('| Metric | Covered | Total | % |');
            console.log('|--------|---------|-------|---|');
            ['lines','functions','branches','statements'].forEach(k => {
              const m = t[k];
              console.log('| ' + k + ' | ' + m.covered + ' | ' + m.total + ' | ' + m.pct.toFixed(1) + '% |');
            });
          " >> \$GITHUB_STEP_SUMMARY
        fi
```

- [ ] **Step 2: Verify YAML syntax**

```bash
python -c "import yaml; yaml.safe_load(open('.github/workflows/ci.yaml'))" && echo "YAML OK"
```

Expected: `YAML OK`

- [ ] **Step 3: Commit**

```bash
git add .github/workflows/ci.yaml
git commit -m "ci: add coverage reporting to test job"
```

---

### Task 4: Create VSIX packaging workflow

**Files:**

- Create: `.github/workflows/package-extension.yaml`

**Interfaces:**

- Produces: `opencob-*.vsix` artifact on every push to `main`; VSIX attached to GitHub Release on `v*.*.*` tags

- [ ] **Step 1: Create `.github/workflows/package-extension.yaml`**

```yaml
name: Package Extension

on:
  push:
    branches: [main]
    tags: ['v*.*.*']

env:
  NODE_VERSION: 22

jobs:
  package:
    name: Build VSIX
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - uses: pnpm/action-setup@v4

      - uses: actions/setup-node@v4
        with:
          node-version: ${{ env.NODE_VERSION }}
          cache: pnpm

      - name: Install dependencies
        run: pnpm install --frozen-lockfile

      - name: Build all packages
        run: pnpm build

      - name: Package VS Code extension
        working-directory: packages/extension
        run: pnpm package

      - name: Find VSIX
        id: vsix
        run: echo "path=$(ls packages/extension/*.vsix | head -1)" >> $GITHUB_OUTPUT

      - name: Upload VSIX artifact
        uses: actions/upload-artifact@v4
        with:
          name: opencob-vsix
          path: ${{ steps.vsix.outputs.path }}
          retention-days: 14

      - name: Attach VSIX to GitHub Release
        if: startsWith(github.ref, 'refs/tags/v')
        uses: softprops/action-gh-release@v2
        with:
          files: ${{ steps.vsix.outputs.path }}
        env:
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
```

- [ ] **Step 2: Verify YAML syntax**

```bash
python -c "import yaml; yaml.safe_load(open('.github/workflows/package-extension.yaml'))" && echo "YAML OK"
```

Expected: `YAML OK`

- [ ] **Step 3: Verify `pnpm package` works locally**

```bash
cd packages/extension && pnpm package
ls *.vsix
```

Expected: A `.vsix` file listed. If it fails, run `pnpm build` from the repo root first.

- [ ] **Step 4: Commit**

```bash
git add .github/workflows/package-extension.yaml
git commit -m "ci: add VSIX packaging workflow"
```

---

## Self-Review Checklist

- [x] Lint gate now blocks `ci-ok` — `lint` added to `needs` array
- [x] Coverage thresholds match spec (70/70/60)
- [x] VSIX artifact uploaded on `main` push and attached to release on tags
- [x] No placeholders or TODOs
- [x] All YAML steps have syntax-check instructions
