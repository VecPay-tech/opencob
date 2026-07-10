# Phase 2: Agent Loop Decomposition Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Break `packages/core/src/agent/agent-loop.ts` (1,358 lines) into five focused single-responsibility modules, leaving `AgentLoop` as a thin coordinator of ~200 lines.

**Architecture:** Extract five internal modules — `ChangeTracker`, `GitContextResolver`, `SystemPromptBuilder`, `SlashCommandHandler`, `ToolCallLoop` — all in `src/agent/`. `AgentLoop` wires them together. No changes to the public API or barrel exports. Existing tests must all continue to pass throughout.

**Tech Stack:** TypeScript ESM, Vitest, Node 22 built-ins.

## Global Constraints

- TypeScript strict mode, no `any`, named exports only
- No new `node_modules` dependencies — use Node 22 built-ins
- All existing tests in `packages/core/tests/agent-loop*.test.ts` must pass after every task
- Each extracted module is NOT re-exported from `packages/core/src/index.ts` (internal only)
- Commit after every task; run `pnpm --filter @opencob/core test` before each commit

---

### Task 1: Extract `ChangeTracker`

**Files:**

- Create: `packages/core/src/agent/change-tracker.ts`
- Create: `packages/core/tests/change-tracker.test.ts`
- Modify: `packages/core/src/agent/agent-loop.ts` (remove extracted methods, import ChangeTracker)

**Interfaces:**

- Produces:

  ```typescript
  export class ChangeTracker {
    reset(): void;
    track(filePath: string, content: string, toolName?: string): void;
    buildSummaryEvent(): AgentEvent | null;
  }
  ```

- [ ] **Step 1: Write the failing test**

Create `packages/core/tests/change-tracker.test.ts`:

```typescript
import { describe, it, expect, beforeEach } from 'vitest';
import { ChangeTracker } from '../src/agent/change-tracker.js';

describe('ChangeTracker', () => {
  let tracker: ChangeTracker;

  beforeEach(() => {
    tracker = new ChangeTracker();
  });

  it('returns null summary when no files tracked', () => {
    expect(tracker.buildSummaryEvent()).toBeNull();
  });

  it('counts all lines as added for write_to_file', () => {
    tracker.track('foo.ts', 'a\nb\nc', 'write_to_file');
    const event = tracker.buildSummaryEvent()!;
    expect(event.type).toBe('changes_summary');
    expect(event.changesSummary!.files[0].added).toBe(3);
    expect(event.changesSummary!.files[0].status).toBe('A');
  });

  it('parses diff markers for apply_diff', () => {
    tracker.track('foo.ts', '+added line\n-removed line\ncontext', 'apply_diff');
    const event = tracker.buildSummaryEvent()!;
    expect(event.changesSummary!.files[0].added).toBe(1);
    expect(event.changesSummary!.files[0].removed).toBe(1);
    expect(event.changesSummary!.files[0].status).toBe('M');
  });

  it('merges changes for the same file across multiple track() calls', () => {
    tracker.track('foo.ts', 'a\nb', 'write_to_file');
    tracker.track('foo.ts', '+more\n-less', 'apply_diff');
    const event = tracker.buildSummaryEvent()!;
    expect(event.changesSummary!.filesChanged).toBe(1);
    expect(event.changesSummary!.files[0].added).toBe(3);
  });

  it('reset() clears state so next summary is null', () => {
    tracker.track('foo.ts', 'content', 'write_to_file');
    tracker.reset();
    expect(tracker.buildSummaryEvent()).toBeNull();
  });

  it('aggregates totals across multiple files', () => {
    tracker.track('a.ts', 'line1\nline2', 'write_to_file');
    tracker.track('b.ts', 'line1', 'write_to_file');
    const event = tracker.buildSummaryEvent()!;
    expect(event.changesSummary!.filesChanged).toBe(2);
    expect(event.changesSummary!.linesAdded).toBe(3);
  });
});
```

- [ ] **Step 2: Run test to confirm it fails**

```bash
pnpm --filter @opencob/core test -- tests/change-tracker.test.ts
```

Expected: `FAIL` — `Cannot find module '../src/agent/change-tracker.js'`

- [ ] **Step 3: Create `packages/core/src/agent/change-tracker.ts`**

```typescript
import type { AgentEvent } from './agent-loop.js';

interface FileChange {
  path: string;
  status: 'M' | 'A' | 'D' | 'R';
  added: number;
  removed: number;
}

export class ChangeTracker {
  private changes: FileChange[] = [];

  reset(): void {
    this.changes = [];
  }

  track(filePath: string, content: string, toolName?: string): void {
    let added = 0;
    let removed = 0;

    if (toolName === 'write_to_file') {
      added = content.split('\n').length;
    } else if (toolName === 'apply_diff' || toolName === 'multi_edit') {
      const lines = content.split('\n');
      for (const line of lines) {
        if (line.startsWith('+') && !line.startsWith('+++')) added++;
        if (line.startsWith('-') && !line.startsWith('---')) removed++;
      }
      if (added === 0 && removed === 0) added = Math.max(1, lines.length);
    } else {
      added = content ? content.split('\n').length : 1;
    }

    const existing = this.changes.find((f) => f.path === filePath);
    if (existing) {
      existing.added += added;
      existing.removed += removed;
    } else {
      this.changes.push({
        path: filePath,
        status: added > 0 && removed === 0 ? 'A' : 'M',
        added,
        removed,
      });
    }
  }

  buildSummaryEvent(): AgentEvent | null {
    if (this.changes.length === 0) return null;
    const totalAdded = this.changes.reduce((s, f) => s + f.added, 0);
    const totalRemoved = this.changes.reduce((s, f) => s + f.removed, 0);
    return {
      type: 'changes_summary',
      changesSummary: {
        filesChanged: this.changes.length,
        linesAdded: totalAdded,
        linesRemoved: totalRemoved,
        files: [...this.changes],
      },
    };
  }
}
```

- [ ] **Step 4: Run tests to confirm they pass**

```bash
pnpm --filter @opencob/core test -- tests/change-tracker.test.ts
```

Expected: all 6 tests PASS

- [ ] **Step 5: Wire into `agent-loop.ts`**

In `agent-loop.ts`:

1. Add import: `import { ChangeTracker } from './change-tracker.js'`
2. Replace the `turnFileChanges` array field with `private changeTracker = new ChangeTracker()`
3. Remove `trackFileChange()` and `buildChangesSummaryEvent()` private methods
4. In `processMessage`: replace `this.turnFileChanges = []` with `this.changeTracker.reset()`
5. Anywhere `trackFileChange(path, content, tool)` is called, replace with `this.changeTracker.track(path, content, tool)`
6. Replace `this.buildChangesSummaryEvent()` with `this.changeTracker.buildSummaryEvent()`

- [ ] **Step 6: Run all agent tests**

```bash
pnpm --filter @opencob/core test -- tests/agent-loop.test.ts tests/change-tracker.test.ts
```

Expected: all tests PASS

- [ ] **Step 7: Commit**

```bash
git add packages/core/src/agent/change-tracker.ts packages/core/tests/change-tracker.test.ts packages/core/src/agent/agent-loop.ts
git commit -m "refactor(core): extract ChangeTracker from AgentLoop"
```

---

### Task 2: Extract `GitContextResolver`

**Files:**

- Create: `packages/core/src/agent/git-context-resolver.ts`
- Create: `packages/core/tests/git-context-resolver.test.ts`
- Modify: `packages/core/src/agent/agent-loop.ts`

**Interfaces:**

- Produces:

  ```typescript
  export class GitContextResolver {
    looksLikeBranch(input: string): boolean;
    resolveGitBranchDiff(branch: string, workspaceRoot: string): string;
    resolveGitPrContext(baseBranch: string, workspaceRoot: string): string;
  }
  ```

- [ ] **Step 1: Write the failing test**

Create `packages/core/tests/git-context-resolver.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { GitContextResolver } from '../src/agent/git-context-resolver.js';

describe('GitContextResolver.looksLikeBranch', () => {
  const resolver = new GitContextResolver();

  it('accepts typical branch names', () => {
    expect(resolver.looksLikeBranch('main')).toBe(true);
    expect(resolver.looksLikeBranch('feat/my-feature')).toBe(true);
    expect(resolver.looksLikeBranch('release-1.2.3')).toBe(true);
  });

  it('rejects inputs with spaces', () => {
    expect(resolver.looksLikeBranch('not a branch')).toBe(false);
  });

  it('rejects file paths with extensions', () => {
    expect(resolver.looksLikeBranch('src/foo.ts')).toBe(false);
    expect(resolver.looksLikeBranch('file.cbl')).toBe(false);
  });

  it('rejects inputs starting with @', () => {
    expect(resolver.looksLikeBranch('@scope/pkg')).toBe(false);
  });

  it('rejects inputs starting with /', () => {
    expect(resolver.looksLikeBranch('/absolute/path')).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to confirm it fails**

```bash
pnpm --filter @opencob/core test -- tests/git-context-resolver.test.ts
```

Expected: `FAIL` — module not found

- [ ] **Step 3: Create `packages/core/src/agent/git-context-resolver.ts`**

```typescript
import { execSync } from 'node:child_process';

export class GitContextResolver {
  looksLikeBranch(input: string): boolean {
    if (input.includes(' ') || input.startsWith('@') || input.startsWith('/')) return false;
    if (/\.(ts|js|py|java|go|rs|c|h|cbl|cob|rpg|pli|md|yaml|json|xml|html|css)$/i.test(input))
      return false;
    return /^[a-zA-Z0-9_][a-zA-Z0-9_./-]*$/.test(input);
  }

  resolveGitBranchDiff(branch: string, workspaceRoot: string): string {
    try {
      if (branch === 'HEAD') {
        return execSync('git diff HEAD', {
          cwd: workspaceRoot,
          encoding: 'utf-8',
          maxBuffer: 1024 * 1024,
        });
      }
      const mergeBase = execSync(`git merge-base ${branch} HEAD`, {
        cwd: workspaceRoot,
        encoding: 'utf-8',
      }).trim();
      const diff = execSync(`git diff ${mergeBase}..HEAD`, {
        cwd: workspaceRoot,
        encoding: 'utf-8',
        maxBuffer: 1024 * 1024,
      });
      return diff || `(no diff between ${branch} and HEAD)`;
    } catch (err) {
      return `(git diff failed: ${err instanceof Error ? err.message : String(err)})`;
    }
  }

  resolveGitPrContext(baseBranch: string, workspaceRoot: string): string {
    try {
      const log = execSync(`git log ${baseBranch}..HEAD --oneline`, {
        cwd: workspaceRoot,
        encoding: 'utf-8',
      });
      const diff = this.resolveGitBranchDiff(baseBranch, workspaceRoot);
      return `## Commits\n\n${log}\n\n## Diff\n\n\`\`\`diff\n${diff}\n\`\`\``;
    } catch (err) {
      return `(git log failed: ${err instanceof Error ? err.message : String(err)})`;
    }
  }
}
```

- [ ] **Step 4: Run tests**

```bash
pnpm --filter @opencob/core test -- tests/git-context-resolver.test.ts
```

Expected: all 5 tests PASS

- [ ] **Step 5: Wire into `agent-loop.ts`**

1. Add import: `import { GitContextResolver } from './git-context-resolver.js'`
2. Add field: `private gitResolver = new GitContextResolver()`
3. Delete `looksLikeBranch()`, `resolveGitBranchDiff()`, `resolveGitPrContext()` private methods
4. Update call sites:
   - `this.looksLikeBranch(x)` → `this.gitResolver.looksLikeBranch(x)`
   - `this.resolveGitBranchDiff(x)` → `this.gitResolver.resolveGitBranchDiff(x, this.config.workspaceRoot ?? process.cwd())`
   - `this.resolveGitPrContext(x)` → `this.gitResolver.resolveGitPrContext(x, this.config.workspaceRoot ?? process.cwd())`

- [ ] **Step 6: Run all agent tests**

```bash
pnpm --filter @opencob/core test -- tests/agent-loop.test.ts tests/git-context-resolver.test.ts
```

Expected: all PASS

- [ ] **Step 7: Commit**

```bash
git add packages/core/src/agent/git-context-resolver.ts packages/core/tests/git-context-resolver.test.ts packages/core/src/agent/agent-loop.ts
git commit -m "refactor(core): extract GitContextResolver from AgentLoop"
```

---

### Task 3: Extract `SystemPromptBuilder`

**Files:**

- Create: `packages/core/src/agent/system-prompt-builder.ts`
- Create: `packages/core/tests/system-prompt-builder.test.ts`
- Modify: `packages/core/src/agent/agent-loop.ts`

**Interfaces:**

- Consumes: `ModeEngine`, `CustomizationLoader | null`, `SkillsLoader | null`, `workspaceRoot: string | undefined`
- Produces:

  ```typescript
  export class SystemPromptBuilder {
    constructor(opts: SystemPromptBuilderOpts);
    build(): string;
  }
  export interface SystemPromptBuilderOpts {
    modeEngine: ModeEngine;
    customizationLoader: CustomizationLoader | null;
    skillsLoader: SkillsLoader | null;
    workspaceRoot?: string;
  }
  ```

- [ ] **Step 1: Write the failing test**

Create `packages/core/tests/system-prompt-builder.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { SystemPromptBuilder } from '../src/agent/system-prompt-builder.js';
import { ModeEngine } from '../src/modes/mode-engine.js';

describe('SystemPromptBuilder', () => {
  it('includes mode roleDefinition in output', () => {
    const modeEngine = new ModeEngine();
    const builder = new SystemPromptBuilder({
      modeEngine,
      customizationLoader: null,
      skillsLoader: null,
    });
    const prompt = builder.build();
    const mode = modeEngine.getActive();
    expect(prompt).toContain(mode.roleDefinition);
  });

  it('includes Guidelines section', () => {
    const modeEngine = new ModeEngine();
    const builder = new SystemPromptBuilder({
      modeEngine,
      customizationLoader: null,
      skillsLoader: null,
    });
    expect(builder.build()).toContain('## Guidelines');
  });

  it('includes Workspace Structure when workspaceRoot is set', () => {
    const modeEngine = new ModeEngine();
    const builder = new SystemPromptBuilder({
      modeEngine,
      customizationLoader: null,
      skillsLoader: null,
      workspaceRoot: process.cwd(),
    });
    const prompt = builder.build();
    expect(prompt).toContain('## Workspace Structure');
  });

  it('omits Workspace Structure when workspaceRoot is undefined', () => {
    const modeEngine = new ModeEngine();
    const builder = new SystemPromptBuilder({
      modeEngine,
      customizationLoader: null,
      skillsLoader: null,
    });
    expect(builder.build()).not.toContain('## Workspace Structure');
  });
});
```

- [ ] **Step 2: Run test to confirm it fails**

```bash
pnpm --filter @opencob/core test -- tests/system-prompt-builder.test.ts
```

Expected: `FAIL` — module not found

- [ ] **Step 3: Create `packages/core/src/agent/system-prompt-builder.ts`**

Move `buildSystemPrompt()` and `buildCompactRepoTree()` from `agent-loop.ts` into this class:

```typescript
import * as fs from 'node:fs';
import * as nodePath from 'node:path';
import type { ModeEngine } from '../modes/mode-engine.js';
import type { CustomizationLoader } from './customization-loader.js';
import type { SkillsLoader } from '../skills/skills-loader.js';

export interface SystemPromptBuilderOpts {
  modeEngine: ModeEngine;
  customizationLoader: CustomizationLoader | null;
  skillsLoader: SkillsLoader | null;
  workspaceRoot?: string;
}

export class SystemPromptBuilder {
  private modeEngine: ModeEngine;
  private customizationLoader: CustomizationLoader | null;
  private skillsLoader: SkillsLoader | null;
  private workspaceRoot: string | undefined;

  constructor(opts: SystemPromptBuilderOpts) {
    this.modeEngine = opts.modeEngine;
    this.customizationLoader = opts.customizationLoader;
    this.skillsLoader = opts.skillsLoader;
    this.workspaceRoot = opts.workspaceRoot;
  }

  build(): string {
    const mode = this.modeEngine.getActive();
    const repoTree = this.buildCompactRepoTree();

    const parts = [
      mode.roleDefinition,
      '',
      mode.customInstructions || '',
      '',
      '## Guidelines',
      '',
      '- Be concise and direct in your responses.',
      '- Use the available tools to accomplish tasks. Call tools rather than describing what you would do.',
      '- When users ask about architecture, flow, dependencies, or structure, prefer calling generate_diagram and briefly explain the result.',
      '- When modifying files, use apply_diff for targeted changes and write_to_file for new files.',
      '- Always read a file before modifying it.',
      '- Explain what you are doing and why before making changes.',
      '- If a tool call fails, diagnose the error and try a different approach.',
      repoTree ? `\n## Workspace Structure\n\n\`\`\`\n${repoTree}\n\`\`\`` : '',
    ];

    if (this.customizationLoader) {
      const resolved = this.customizationLoader.resolve([]);
      if (resolved.systemPromptAdditions.length > 0) {
        parts.push('\n## Project Instructions\n');
        parts.push(...resolved.systemPromptAdditions);
      }
      const hookResult = this.customizationLoader.fireHook({ event: 'onChatStart' });
      if (hookResult.instructions.length > 0) {
        parts.push('\n## Active Hooks\n');
        parts.push(...hookResult.instructions);
      }
    }

    if (this.workspaceRoot) {
      const docsPath = nodePath.join(this.workspaceRoot, 'docs', 'pages');
      if (fs.existsSync(docsPath)) {
        parts.push('\n## Self-Help Documentation\n');
        parts.push(
          'When users ask how to use OpenCob, read the relevant MDX file from docs/pages/.\n' +
            'Key files: installation.mdx, getting-started.mdx, customization.mdx, hooks.mdx, modes.mdx, tools.mdx, commands.mdx, mcp.mdx, troubleshooting.mdx',
        );
      }
    }

    return parts.filter(Boolean).join('\n');
  }

  private buildCompactRepoTree(): string {
    if (!this.workspaceRoot) return '';
    try {
      const root = this.workspaceRoot;
      const lines: string[] = [];
      const maxLines = 60;
      const skip = new Set([
        'node_modules',
        '.git',
        'dist',
        'build',
        '.next',
        '.turbo',
        'coverage',
        '.nyc_output',
        '__pycache__',
        '.venv',
        'target',
      ]);

      const walk = (dir: string, prefix: string, depth: number): void => {
        if (depth > 3 || lines.length >= maxLines) return;
        let entries: fs.Dirent[];
        try {
          entries = fs.readdirSync(dir, { withFileTypes: true });
        } catch {
          return;
        }
        entries = entries
          .filter((e) => !skip.has(e.name) && !e.name.startsWith('.'))
          .sort((a, b) =>
            a.isDirectory() === b.isDirectory()
              ? a.name.localeCompare(b.name)
              : a.isDirectory()
                ? -1
                : 1,
          );
        for (let i = 0; i < entries.length && lines.length < maxLines; i++) {
          const entry = entries[i];
          const isLast = i === entries.length - 1;
          lines.push(
            `${prefix}${isLast ? '└── ' : '├── '}${entry.name}${entry.isDirectory() ? '/' : ''}`,
          );
          if (entry.isDirectory())
            walk(nodePath.join(dir, entry.name), prefix + (isLast ? '    ' : '│   '), depth + 1);
        }
      };

      lines.push(`${nodePath.basename(root)}/`);
      walk(root, '', 0);
      if (lines.length >= maxLines) lines.push('... (truncated)');
      return lines.join('\n');
    } catch {
      return '';
    }
  }
}
```

- [ ] **Step 4: Run tests**

```bash
pnpm --filter @opencob/core test -- tests/system-prompt-builder.test.ts
```

Expected: all 4 tests PASS

- [ ] **Step 5: Wire into `agent-loop.ts`**

1. Import: `import { SystemPromptBuilder } from './system-prompt-builder.js'`
2. Add field: `private promptBuilder: SystemPromptBuilder`
3. In constructor, after assigning fields: `this.promptBuilder = new SystemPromptBuilder({ modeEngine, customizationLoader: config.customizationLoader ?? null, skillsLoader: config.skillsLoader ?? null, workspaceRoot: config.workspaceRoot })`
4. Replace `this.buildSystemPrompt()` calls with `this.promptBuilder.build()`
5. Delete the `buildSystemPrompt()` and `buildCompactRepoTree()` private methods from `agent-loop.ts`

- [ ] **Step 6: Run all agent tests**

```bash
pnpm --filter @opencob/core test -- tests/agent-loop.test.ts tests/system-prompt-builder.test.ts
```

Expected: all PASS

- [ ] **Step 7: Commit**

```bash
git add packages/core/src/agent/system-prompt-builder.ts packages/core/tests/system-prompt-builder.test.ts packages/core/src/agent/agent-loop.ts
git commit -m "refactor(core): extract SystemPromptBuilder from AgentLoop"
```

---

### Task 4: Extract `SlashCommandHandler`

**Files:**

- Create: `packages/core/src/agent/slash-command-handler.ts`
- Create: `packages/core/tests/slash-command-handler.test.ts`
- Modify: `packages/core/src/agent/agent-loop.ts`

**Interfaces:**

- Consumes: `ModeEngine`, `SnapshotManager | null`, `ToolRegistry`, `customCommands: Map<string, {description: string; prompt: string}>`
- Produces:

  ```typescript
  export type SlashResult =
    | { kind: 'event'; event: AgentEvent } // terminal — return to caller
    | { kind: 'rewrite'; message: string } // continue with rewritten message
    | { kind: 'passthrough' }; // not a slash command, pass original
  export class SlashCommandHandler {
    constructor(opts: SlashCommandHandlerOpts);
    handle(input: string): SlashResult;
  }
  ```

- [ ] **Step 1: Write the failing test**

Create `packages/core/tests/slash-command-handler.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { SlashCommandHandler } from '../src/agent/slash-command-handler.js';
import { ModeEngine } from '../src/modes/mode-engine.js';
import { ToolRegistry } from '../src/tools/tool-registry.js';

function makeHandler() {
  const modeEngine = new ModeEngine();
  const toolRegistry = new ToolRegistry([], modeEngine);
  return new SlashCommandHandler({
    modeEngine,
    snapshotManager: null,
    toolRegistry,
    customCommands: new Map(),
  });
}

describe('SlashCommandHandler', () => {
  it('returns passthrough for non-slash input', () => {
    const h = makeHandler();
    expect(h.handle('hello world').kind).toBe('passthrough');
  });

  it('/code switches mode and returns event', () => {
    const h = makeHandler();
    const result = h.handle('/code');
    expect(result.kind).toBe('event');
    if (result.kind === 'event') expect(result.event.type).toBe('mode_switch');
  });

  it('/new returns done event', () => {
    const h = makeHandler();
    const result = h.handle('/new');
    expect(result.kind).toBe('event');
    if (result.kind === 'event') expect(result.event.type).toBe('done');
  });

  it('/explain returns rewrite with prefix', () => {
    const h = makeHandler();
    const result = h.handle('/explain some code');
    expect(result.kind).toBe('rewrite');
    if (result.kind === 'rewrite') expect(result.message).toContain('Explain');
  });

  it('/explain without args returns usage event', () => {
    const h = makeHandler();
    const result = h.handle('/explain');
    expect(result.kind).toBe('event');
    if (result.kind === 'event') expect(result.event.text).toContain('Usage');
  });

  it('custom command returns rewrite with custom prompt', () => {
    const modeEngine = new ModeEngine();
    const toolRegistry = new ToolRegistry([], modeEngine);
    const customCommands = new Map([
      ['myCmd', { description: 'test', prompt: 'Do custom thing:' }],
    ]);
    const h = new SlashCommandHandler({
      modeEngine,
      snapshotManager: null,
      toolRegistry,
      customCommands,
    });
    const result = h.handle('/myCmd context');
    expect(result.kind).toBe('rewrite');
    if (result.kind === 'rewrite') expect(result.message).toContain('Do custom thing:');
  });
});
```

- [ ] **Step 2: Run test to confirm it fails**

```bash
pnpm --filter @opencob/core test -- tests/slash-command-handler.test.ts
```

Expected: `FAIL` — module not found

- [ ] **Step 3: Create `packages/core/src/agent/slash-command-handler.ts`**

```typescript
import type { AgentEvent } from './agent-loop.js';
import type { ModeEngine } from '../modes/mode-engine.js';
import type { SnapshotManager } from '../checkpoints/snapshot-manager.js';
import type { ToolRegistry } from '../tools/tool-registry.js';

export type SlashResult =
  | { kind: 'event'; event: AgentEvent }
  | { kind: 'rewrite'; message: string }
  | { kind: 'passthrough' };

export interface SlashCommandHandlerOpts {
  modeEngine: ModeEngine;
  snapshotManager: SnapshotManager | null;
  toolRegistry: ToolRegistry;
  customCommands: Map<string, { description: string; prompt: string }>;
}

const PROMPT_PREFIXES: Record<string, string> = {
  '/explain':
    'Explain the following code in detail. What does it do, how does it work, and what are the key patterns used?\n\n',
  '/fix':
    'Analyze the following code for bugs, errors, and issues. Fix all problems you find and explain each fix.\n\n',
  '/test':
    'Generate comprehensive unit tests for the following code. Cover edge cases, error paths, and typical usage.\n\n',
  '/diagram':
    'Generate the most relevant diagram for the following code/context. Prefer Mermaid output and include a short explanation.\n\n',
  '/review':
    'Review the following code for quality, security, performance, and maintainability issues. Suggest improvements.\n\n',
};

const MODE_COMMANDS: Record<string, string> = {
  '/code': 'code',
  '/ask': 'ask',
  '/plan': 'orchestrator',
  '/advanced': 'advanced',
  '/orchestrator': 'orchestrator',
};

export class SlashCommandHandler {
  private modeEngine: ModeEngine;
  private snapshotManager: SnapshotManager | null;
  private toolRegistry: ToolRegistry;
  private customCommands: Map<string, { description: string; prompt: string }>;

  constructor(opts: SlashCommandHandlerOpts) {
    this.modeEngine = opts.modeEngine;
    this.snapshotManager = opts.snapshotManager;
    this.toolRegistry = opts.toolRegistry;
    this.customCommands = opts.customCommands;
  }

  handle(input: string): SlashResult {
    const trimmed = input.trim();
    if (!trimmed.startsWith('/')) return { kind: 'passthrough' };

    const [command] = trimmed.split(/\s+/);
    const remainder = trimmed.slice(command.length).trim();

    if (command in MODE_COMMANDS) {
      this.modeEngine.setActive(MODE_COMMANDS[command]);
      const mode = this.modeEngine.getActive();
      if (remainder) return { kind: 'passthrough' }; // mode set; processMessage handles message
      return {
        kind: 'event',
        event: { type: 'mode_switch', mode: mode.name, text: `Switched to ${mode.name} mode` },
      };
    }

    if (command === '/new' || command === '/clear') {
      return { kind: 'event', event: { type: 'done', text: 'Conversation cleared.' } };
    }

    if (command === '/undo') {
      if (!this.snapshotManager)
        return {
          kind: 'event',
          event: { type: 'done', text: 'Undo not available — no snapshot manager configured.' },
        };
      const result = this.snapshotManager.undoLastTurn();
      if (!result) return { kind: 'event', event: { type: 'done', text: 'Nothing to undo.' } };
      const fileList = result.restoredFiles.join('\n  ');
      return {
        kind: 'event',
        event: {
          type: 'done',
          text: `Undid turn ${result.turnId}. Restored ${result.restoredFiles.length} file(s):\n  ${fileList}`,
        },
      };
    }

    if (command === '/help') {
      const available = this.toolRegistry.listAvailable();
      const toolList = available.map((t) => `  ${t.name} — ${t.description}`).join('\n');
      const customList =
        this.customCommands.size > 0
          ? Array.from(this.customCommands.entries())
              .map(([n, c]) => `  /${n} — ${c.description}`)
              .join('\n')
          : '';
      const text = [
        'Available commands:',
        '  /code /ask /plan /advanced /orchestrator — switch mode',
        '  /new /clear — start new conversation',
        '  /undo — undo last turn file changes',
        '  /explain /fix /test /diagram /review /create-pr — prompt shortcuts',
        '  /help — show this help',
        customList ? `\nCustom commands:\n${customList}` : '',
        `\nAvailable tools (${this.modeEngine.getActive().name} mode):\n${toolList || '  (none)'}`,
      ]
        .filter(Boolean)
        .join('\n');
      return { kind: 'event', event: { type: 'done', text } };
    }

    if (command in PROMPT_PREFIXES) {
      if (!remainder && command !== '/review' && command !== '/diagram') {
        return {
          kind: 'event',
          event: { type: 'done', text: `Usage: ${command} <code or file reference>` },
        };
      }
      return { kind: 'rewrite', message: PROMPT_PREFIXES[command] + remainder };
    }

    const cmdName = command.slice(1);
    const customCmd = this.customCommands.get(cmdName);
    if (customCmd) return { kind: 'rewrite', message: customCmd.prompt + '\n\n' + remainder };

    return { kind: 'passthrough' };
  }
}
```

- [ ] **Step 4: Run tests**

```bash
pnpm --filter @opencob/core test -- tests/slash-command-handler.test.ts
```

Expected: all 6 tests PASS

- [ ] **Step 5: Wire into `agent-loop.ts`**

1. Import: `import { SlashCommandHandler, type SlashResult } from './slash-command-handler.js'`
2. Add field: `private slashHandler: SlashCommandHandler`
3. In constructor: `this.slashHandler = new SlashCommandHandler({ modeEngine, snapshotManager: config.snapshotManager ?? null, toolRegistry, customCommands: this.customCommands })`
4. In `processMessage`, replace the `handleSlashCommand()` call block with:
   ```typescript
   const slashResult = this.slashHandler.handle(userMessage);
   if (slashResult.kind === 'event') {
     yield slashResult.event;
     return;
   }
   if (slashResult.kind === 'rewrite') effectiveMessage = slashResult.message;
   ```
5. Delete the `handleSlashCommand()` private method from `agent-loop.ts`

- [ ] **Step 6: Run all agent tests**

```bash
pnpm --filter @opencob/core test -- tests/agent-loop.test.ts tests/slash-command-handler.test.ts
```

Expected: all PASS

- [ ] **Step 7: Commit**

```bash
git add packages/core/src/agent/slash-command-handler.ts packages/core/tests/slash-command-handler.test.ts packages/core/src/agent/agent-loop.ts
git commit -m "refactor(core): extract SlashCommandHandler from AgentLoop"
```

---

### Task 5: Extract `ToolCallLoop`

**Files:**

- Create: `packages/core/src/agent/tool-call-loop.ts`
- Create: `packages/core/tests/tool-call-loop.test.ts`
- Modify: `packages/core/src/agent/agent-loop.ts`

**Interfaces:**

- Consumes: `LlmAdapter`, `ToolRegistry`, `ConversationManager`, `RedactionEngine`, `ChangeTracker`, `AgentConfig`
- Produces:

  ```typescript
  export interface ToolCallLoopOpts {
    llm: LlmAdapter;
    toolRegistry: ToolRegistry;
    conversationManager: ConversationManager;
    redactionEngine: RedactionEngine;
    changeTracker: ChangeTracker;
    maxToolRounds: number;
    maxSelfCorrectionAttempts: number;
    enablePostEditVerification: boolean;
    postEditVerifier: PostEditVerifier | null;
    workspaceRoot?: string;
  }
  export class ToolCallLoop {
    constructor(opts: ToolCallLoopOpts);
    run(systemPrompt: string, maxContextTokens: number): AsyncIterable<AgentEvent>;
  }
  ```

- [ ] **Step 1: Write the failing test**

Create `packages/core/tests/tool-call-loop.test.ts`:

```typescript
import { describe, it, expect, vi } from 'vitest';
import { ToolCallLoop } from '../src/agent/tool-call-loop.js';
import { ChangeTracker } from '../src/agent/change-tracker.js';
import { ConversationManager } from '../src/conversation/conversation-manager.js';
import { ModeEngine } from '../src/modes/mode-engine.js';
import { RedactionEngine } from '../src/security/redaction-engine.js';
import { ToolRegistry } from '../src/tools/tool-registry.js';
import type {
  LlmAdapter,
  ChatMessage,
  ChatOptions,
  StreamChunk,
  CompletionRequest,
  CompletionResponse,
} from '../src/llm/types.js';

function makeMockAdapter(chunks: StreamChunk[]): LlmAdapter {
  return {
    name: 'mock',
    getChatModel: () => 'mock',
    getCompletionModel: () => 'mock',
    setChatModel: vi.fn(),
    setCompletionModel: vi.fn(),
    isAvailable: async () => true,
    listModels: async () => ['mock'],
    complete: async (_req: CompletionRequest): Promise<CompletionResponse> => ({
      text: '',
      finishReason: 'stop',
    }),
    async *chat(_msgs: ChatMessage[], _opts?: ChatOptions): AsyncIterable<StreamChunk> {
      for (const c of chunks) yield c;
    },
  };
}

describe('ToolCallLoop', () => {
  it('yields text events from LLM and a done event', async () => {
    const modeEngine = new ModeEngine();
    const toolRegistry = new ToolRegistry([], modeEngine);
    const conversationManager = new ConversationManager({});
    const redactionEngine = new RedactionEngine();
    const changeTracker = new ChangeTracker();
    const adapter = makeMockAdapter([
      { type: 'text', text: 'Hello' },
      { type: 'text', text: ' world' },
      { type: 'done' },
    ]);
    const loop = new ToolCallLoop({
      llm: adapter,
      toolRegistry,
      conversationManager,
      redactionEngine,
      changeTracker,
      maxToolRounds: 5,
      maxSelfCorrectionAttempts: 2,
      enablePostEditVerification: false,
      postEditVerifier: null,
    });
    const events: string[] = [];
    for await (const ev of loop.run('system', 8000)) {
      events.push(ev.type);
    }
    expect(events).toContain('text');
    expect(events.at(-1)).toBe('done');
  });
});
```

- [ ] **Step 2: Run test to confirm it fails**

```bash
pnpm --filter @opencob/core test -- tests/tool-call-loop.test.ts
```

Expected: `FAIL` — module not found

- [ ] **Step 3: Create `packages/core/src/agent/tool-call-loop.ts`**

This module contains the inner `for await` loop that was in `processMessage` (roughly lines 300–580 of the original `agent-loop.ts`). Move that generator code here verbatim, replacing `this.*` references with constructor-injected fields:

```typescript
import type { LlmAdapter } from '../llm/types.js';
import type { ToolRegistry } from '../tools/tool-registry.js';
import type { ConversationManager } from '../conversation/conversation-manager.js';
import type { RedactionEngine } from '../security/redaction-engine.js';
import type { PostEditVerifier } from './post-edit-verifier.js';
import type { AgentEvent } from './agent-loop.js';
import { ChangeTracker } from './change-tracker.js';

export interface ToolCallLoopOpts {
  llm: LlmAdapter;
  toolRegistry: ToolRegistry;
  conversationManager: ConversationManager;
  redactionEngine: RedactionEngine;
  changeTracker: ChangeTracker;
  maxToolRounds: number;
  maxSelfCorrectionAttempts: number;
  enablePostEditVerification: boolean;
  postEditVerifier: PostEditVerifier | null;
  workspaceRoot?: string;
}

export class ToolCallLoop {
  private opts: ToolCallLoopOpts;

  constructor(opts: ToolCallLoopOpts) {
    this.opts = opts;
  }

  async *run(systemPrompt: string, maxContextTokens: number): AsyncIterable<AgentEvent> {
    const {
      llm,
      toolRegistry,
      conversationManager,
      redactionEngine,
      changeTracker,
      maxToolRounds,
      maxSelfCorrectionAttempts,
      postEditVerifier,
    } = this.opts;
    let toolRound = 0;
    let selfCorrectionAttempts = 0;
    let continueLoop = true;

    while (continueLoop && toolRound < maxToolRounds) {
      continueLoop = false;
      const messages = conversationManager.getContextWindow(systemPrompt, maxContextTokens);
      const redacted = redactionEngine.redactMessages(messages);
      const availableTools = toolRegistry.getToolDefinitions();

      let assistantText = '';
      const pendingToolCalls: Array<{ id: string; name: string; args: string }> = [];

      yield { type: 'phase_change', phase: 'reasoning' };

      try {
        for await (const chunk of llm.chat(redacted, { tools: availableTools })) {
          if (chunk.type === 'text' && chunk.text) {
            assistantText += chunk.text;
            yield { type: 'text', text: chunk.text };
          } else if (chunk.type === 'tool_call' && chunk.toolCall) {
            pendingToolCalls.push({
              id: chunk.toolCallId ?? `call_${Date.now()}`,
              name: chunk.toolCall.name,
              args: JSON.stringify(chunk.toolCall.parameters),
            });
          } else if (chunk.type === 'error') {
            yield { type: 'error', error: chunk.error };
            return;
          }
        }
      } catch (err) {
        if (selfCorrectionAttempts < maxSelfCorrectionAttempts) {
          selfCorrectionAttempts++;
          yield { type: 'self_correction', attempt: selfCorrectionAttempts };
          continueLoop = true;
          continue;
        }
        yield { type: 'error', error: err instanceof Error ? err.message : String(err) };
        return;
      }

      if (assistantText) {
        conversationManager.addMessage({ role: 'assistant', content: assistantText });
      }

      if (pendingToolCalls.length === 0) break;

      yield { type: 'phase_change', phase: 'processing' };
      continueLoop = true;
      toolRound++;

      for (const call of pendingToolCalls) {
        let params: Record<string, unknown>;
        try {
          params = JSON.parse(call.args);
        } catch {
          params = {};
        }

        yield { type: 'tool_call', toolCall: { name: call.name, parameters: params } };

        const result = await toolRegistry.execute({ toolName: call.name, parameters: params });
        yield { type: 'tool_result', toolResult: result };

        if (result.filePath && result.content) {
          changeTracker.track(result.filePath, result.content, call.name);
          if (postEditVerifier && this.opts.enablePostEditVerification) {
            const vResult = await postEditVerifier.verify(result.filePath);
            if (!vResult.passed) yield { type: 'verification', text: vResult.message };
          }
        }

        conversationManager.addMessage({
          role: 'tool',
          content: result.output ?? (result.error ? `Error: ${result.error}` : ''),
          toolCallId: call.id,
          name: call.name,
        });
      }
    }

    yield { type: 'done' };
  }
}
```

- [ ] **Step 4: Run tests**

```bash
pnpm --filter @opencob/core test -- tests/tool-call-loop.test.ts
```

Expected: 1 test PASS

- [ ] **Step 5: Wire into `agent-loop.ts`**

1. Import: `import { ToolCallLoop } from './tool-call-loop.js'`
2. Add field: `private toolCallLoop: ToolCallLoop`
3. In constructor: instantiate with the existing fields
4. In `processMessage`: replace the inner `while (continueLoop...)` loop with `yield* this.toolCallLoop.run(this.promptBuilder.build(), this.config.maxContextTokens)`
5. Delete the inlined loop code from `processMessage`

- [ ] **Step 6: Run all agent tests and verify line count**

```bash
pnpm --filter @opencob/core test -- tests/agent-loop.test.ts tests/tool-call-loop.test.ts
wc -l packages/core/src/agent/agent-loop.ts
```

Expected: all tests PASS; line count ≤ 350 (will drop further in Task 6)

- [ ] **Step 7: Commit**

```bash
git add packages/core/src/agent/tool-call-loop.ts packages/core/tests/tool-call-loop.test.ts packages/core/src/agent/agent-loop.ts
git commit -m "refactor(core): extract ToolCallLoop from AgentLoop"
```

---

### Task 6: Final cleanup — verify AgentLoop is ≤ 250 lines

**Files:**

- Modify: `packages/core/src/agent/agent-loop.ts` (remove any remaining dead code, tighten imports)

**Interfaces:**

- Produces: `agent-loop.ts` ≤ 250 lines; all existing tests pass; `pnpm build` succeeds

- [ ] **Step 1: Count remaining lines**

```bash
wc -l packages/core/src/agent/agent-loop.ts
```

If > 250, identify remaining large blocks with:

```bash
grep -n "private\|^  //" packages/core/src/agent/agent-loop.ts
```

- [ ] **Step 2: Remove any remaining dead private methods**

Any private method still in `agent-loop.ts` that is no longer called (verify with `grep`) should be deleted. Common candidates after Tasks 1–5: `loadCustomCommands` (move to `SlashCommandHandler` or `CustomizationLoader`), unused imports.

- [ ] **Step 3: Run full test suite**

```bash
pnpm --filter @opencob/core test
```

Expected: all tests PASS, no regressions

- [ ] **Step 4: Run typecheck and build**

```bash
pnpm typecheck && pnpm build
```

Expected: no errors

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/agent/agent-loop.ts
git commit -m "refactor(core): agent-loop cleanup — thin coordinator only"
```
