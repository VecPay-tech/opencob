# Phase 4: CLI UX Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the buffered readline REPL in `packages/cli/src/index.ts` with a streaming renderer that shows tokens progressively, displays tool calls as they happen, supports `#file` mention expansion, and shows a spinner during long operations.

**Architecture:** Three new focused modules (`Spinner`, `expandMentions`, `CliRenderer`) extracted from what becomes a thin `index.ts` coordinator. No external dependencies — ANSI escape codes and Node 22 built-ins only.

**Tech Stack:** TypeScript (strict, ESM), Node 22 `readline`/`fs`/`path`, Vitest globals.

## Global Constraints

- Node 22, pnpm >= 10
- TypeScript strict — no `any`
- No new npm dependencies — ANSI codes only for terminal rendering
- Spinner frame interval: exactly 80ms, frames: `['⠋','⠙','⠹','⠸','⠼','⠴','⠦','⠧','⠇','⠏']`
- All new files in `packages/cli/src/`; tests in `packages/cli/tests/`

---

### Task 1: Spinner class

**Files:**

- Create: `packages/cli/src/spinner.ts`
- Create: `packages/cli/tests/spinner.test.ts`
- Possibly create: `packages/cli/vitest.config.ts` (if it does not already exist)
- Possibly modify: `packages/cli/package.json` (add `test` script if missing)

**Interfaces:**

- Produces:

  ```typescript
  export class Spinner {
    start(label: string): void;
    update(label: string): void;
    stop(): void;
  }
  ```

- [ ] **Step 1: Check CLI test infrastructure**

```bash
ls packages/cli/
cat packages/cli/package.json
```

If there is no `tests/` directory, create it:

```bash
mkdir -p packages/cli/tests
```

If `packages/cli/vitest.config.ts` does not exist, create it:

```typescript
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
  },
});
```

If `packages/cli/package.json` has no `"test"` script in `scripts`, add:

```json
"test": "vitest run"
```

- [ ] **Step 2: Write the failing test**

Create `packages/cli/tests/spinner.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Spinner } from '../src/spinner.js';

describe('Spinner', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('writes to stdout after one interval tick', () => {
    const spinner = new Spinner();
    spinner.start('Loading');
    vi.advanceTimersByTime(80);
    expect(process.stdout.write).toHaveBeenCalled();
  });

  it('clears the line on stop', () => {
    const spinner = new Spinner();
    spinner.start('Loading');
    spinner.stop();
    const calls = (process.stdout.write as ReturnType<typeof vi.fn>).mock.calls;
    const lastCall = calls[calls.length - 1][0] as string;
    expect(lastCall).toContain('\r\x1b[K');
  });

  it('does not throw if stopped before started', () => {
    const spinner = new Spinner();
    expect(() => spinner.stop()).not.toThrow();
  });

  it('updates the label without restarting the timer', () => {
    const spinner = new Spinner();
    spinner.start('Step 1');
    spinner.update('Step 2');
    vi.advanceTimersByTime(80);
    const calls = (process.stdout.write as ReturnType<typeof vi.fn>).mock.calls;
    const lastWritten = calls[calls.length - 1][0] as string;
    expect(lastWritten).toContain('Step 2');
    spinner.stop();
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

```bash
pnpm --filter opencob-cli test
```

Expected: `Error: Cannot find module '../src/spinner.js'`

- [ ] **Step 4: Implement Spinner**

Create `packages/cli/src/spinner.ts`:

```typescript
const FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
const INTERVAL_MS = 80;

export class Spinner {
  private timer: ReturnType<typeof setInterval> | null = null;
  private frame = 0;
  private label = '';

  start(label: string): void {
    this.label = label;
    this.frame = 0;
    this.timer = setInterval(() => this.tick(), INTERVAL_MS);
  }

  update(label: string): void {
    this.label = label;
  }

  stop(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
    process.stdout.write('\r\x1b[K');
  }

  private tick(): void {
    const icon = FRAMES[this.frame % FRAMES.length];
    this.frame++;
    process.stdout.write(`\r\x1b[K\x1b[2m${icon} ${this.label}\x1b[0m`);
  }
}
```

- [ ] **Step 5: Run tests to verify they pass**

```bash
pnpm --filter opencob-cli test
```

Expected: `4 tests passed`

- [ ] **Step 6: Commit**

```bash
git add packages/cli/src/spinner.ts packages/cli/tests/spinner.test.ts
git commit -m "feat(cli): add Spinner class with ANSI terminal output"
```

---

### Task 2: Mention expansion

**Files:**

- Create: `packages/cli/src/mentions.ts`
- Create: `packages/cli/tests/mentions.test.ts`

**Interfaces:**

- Produces:

  ```typescript
  export function expandMentions(input: string, cwd: string): string;
  ```

- [ ] **Step 1: Write the failing test**

Create `packages/cli/tests/mentions.test.ts`:

```typescript
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { expandMentions } from '../src/mentions.js';

const TMP = join(import.meta.dirname ?? '.', '__test_fixtures__');

beforeAll(() => {
  mkdirSync(TMP, { recursive: true });
  writeFileSync(join(TMP, 'hello.cob'), '       IDENTIFICATION DIVISION.\n');
});

afterAll(() => {
  rmSync(TMP, { recursive: true, force: true });
});

describe('expandMentions', () => {
  it('expands a #file token to a fenced code block', () => {
    const result = expandMentions('explain #hello.cob please', TMP);
    expect(result).toContain('--- file: hello.cob ---');
    expect(result).toContain('IDENTIFICATION DIVISION');
  });

  it('leaves input unchanged when no #token present', () => {
    const input = 'what does this code do?';
    expect(expandMentions(input, TMP)).toBe(input);
  });

  it('leaves unresolved #token unchanged', () => {
    const input = 'explain #nonexistent.cob';
    expect(expandMentions(input, TMP)).toBe(input);
  });

  it('expands multiple tokens in one input', () => {
    writeFileSync(join(TMP, 'other.jcl'), '//JOB1 JOB\n');
    const result = expandMentions('compare #hello.cob with #other.jcl', TMP);
    expect(result).toContain('--- file: hello.cob ---');
    expect(result).toContain('--- file: other.jcl ---');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
pnpm --filter opencob-cli test -- tests/mentions.test.ts
```

Expected: `Error: Cannot find module '../src/mentions.js'`

- [ ] **Step 3: Implement expandMentions**

Create `packages/cli/src/mentions.ts`:

```typescript
import { readFileSync, existsSync } from 'node:fs';
import { resolve, relative } from 'node:path';

export function expandMentions(input: string, cwd: string): string {
  return input.replace(/#([\w./\\-]+)/g, (_match, token: string) => {
    const fullPath = resolve(cwd, token);
    if (!existsSync(fullPath)) return _match;
    const content = readFileSync(fullPath, 'utf8');
    const rel = relative(cwd, fullPath);
    return `\n--- file: ${rel} ---\n${content}\n---\n`;
  });
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
pnpm --filter opencob-cli test -- tests/mentions.test.ts
```

Expected: `4 tests passed`

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/mentions.ts packages/cli/tests/mentions.test.ts
git commit -m "feat(cli): add #file mention expansion"
```

---

### Task 3: CliRenderer

**Files:**

- Create: `packages/cli/src/renderer.ts`
- Create: `packages/cli/tests/renderer.test.ts`

**Interfaces:**

- Consumes: `Spinner` from Task 1; `AgentEvent` from `@opencob/core`
- Produces:

  ```typescript
  export class CliRenderer {
    constructor(spinner: Spinner);
    async render(events: AsyncIterable<AgentEvent>): Promise<void>;
  }
  ```

- [ ] **Step 1: Discover the AgentEvent type**

```bash
grep -n 'AgentEvent\|export.*Event\|type.*Event' packages/core/src/agent/agent-loop.ts | head -20
grep -rn "export.*AgentEvent\|export type.*Event" packages/core/src/ | head -20
```

Open the file that defines `AgentEvent` and note the exact discriminated union. The renderer must handle every variant present.

- [ ] **Step 2: Write the failing test**

The test below uses a mock iterable and assumes the common event shape. Adjust field names if the actual `AgentEvent` type uses different property names (e.g., `content` instead of `text`).

Create `packages/cli/tests/renderer.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { CliRenderer } from '../src/renderer.js';
import { Spinner } from '../src/spinner.js';

async function* makeEvents(events: object[]) {
  for (const e of events) yield e as never;
}

describe('CliRenderer', () => {
  let stdoutSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function makeSpinner(): Spinner {
    const s = new Spinner();
    vi.spyOn(s, 'start').mockImplementation(() => {});
    vi.spyOn(s, 'update').mockImplementation(() => {});
    vi.spyOn(s, 'stop').mockImplementation(() => {});
    return s;
  }

  it('writes text events to stdout', async () => {
    const renderer = new CliRenderer(makeSpinner());
    await renderer.render(
      makeEvents([
        { type: 'text', text: 'Hello ' },
        { type: 'text', text: 'world' },
        { type: 'done' },
      ]),
    );
    const written = stdoutSpy.mock.calls.map((c) => c[0]).join('');
    expect(written).toContain('Hello ');
    expect(written).toContain('world');
  });

  it('prints tool_call events in dim colour', async () => {
    const renderer = new CliRenderer(makeSpinner());
    await renderer.render(
      makeEvents([
        { type: 'tool_call', name: 'read_file', args: { path: 'foo.ts' } },
        { type: 'done' },
      ]),
    );
    const written = stdoutSpy.mock.calls.map((c) => c[0]).join('');
    expect(written).toContain('read_file');
    expect(written).toContain('\x1b[2m');
  });

  it('stops spinner on done event', async () => {
    const spinner = makeSpinner();
    const renderer = new CliRenderer(spinner);
    await renderer.render(makeEvents([{ type: 'done' }]));
    expect(spinner.stop).toHaveBeenCalled();
  });

  it('writes error message to stderr on error event', async () => {
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const renderer = new CliRenderer(makeSpinner());
    await renderer.render(
      makeEvents([{ type: 'error', message: 'something went wrong' }, { type: 'done' }]),
    );
    const written = stderrSpy.mock.calls.map((c) => c[0]).join('');
    expect(written).toContain('something went wrong');
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

```bash
pnpm --filter opencob-cli test -- tests/renderer.test.ts
```

Expected: `Error: Cannot find module '../src/renderer.js'`

- [ ] **Step 4: Implement CliRenderer**

Create `packages/cli/src/renderer.ts`. After Step 1, adjust the `AgentEvent` import path and field names to match the actual type:

```typescript
import type { AgentEvent } from '@opencob/core';
import { Spinner } from './spinner.js';

const DIM = '\x1b[2m';
const RESET = '\x1b[0m';
const GREEN = '\x1b[32m';
const RED = '\x1b[31m';

export class CliRenderer {
  constructor(private readonly spinner: Spinner) {}

  async render(events: AsyncIterable<AgentEvent>): Promise<void> {
    this.spinner.start('Thinking…');

    for await (const event of events) {
      switch (event.type) {
        case 'text':
          this.spinner.stop();
          process.stdout.write(event.text);
          break;

        case 'tool_call': {
          this.spinner.stop();
          const argsSummary = JSON.stringify(event.args ?? {}).slice(0, 60);
          process.stdout.write(`\n${DIM}  ⚙ ${event.name}(${argsSummary})${RESET}\n`);
          this.spinner.start(`Running ${event.name}…`);
          break;
        }

        case 'tool_result': {
          this.spinner.stop();
          if (event.isError) {
            process.stdout.write(
              `${DIM}  ${RED}✗ error: ${String(event.content).slice(0, 80)}${RESET}\n`,
            );
          } else {
            process.stdout.write(`${DIM}  ${GREEN}✓ done${RESET}\n`);
          }
          break;
        }

        case 'phase_change':
          this.spinner.update((event as { label?: string }).label ?? 'Working…');
          break;

        case 'mode_switch':
          this.spinner.stop();
          process.stdout.write(`  → Switched to ${(event as { mode: string }).mode} mode\n`);
          break;

        case 'error':
          this.spinner.stop();
          process.stderr.write(`Error: ${(event as { message: string }).message}\n`);
          break;

        case 'done':
          this.spinner.stop();
          process.stdout.write('\n');
          break;
      }
    }
  }
}
```

Note: The casts `(event as { ... })` are only needed if `AgentEvent` does not yet include `phase_change` or `mode_switch` variants. Run `pnpm typecheck` and remove unnecessary casts once the actual type is confirmed.

- [ ] **Step 5: Run typecheck**

```bash
pnpm --filter opencob-cli typecheck
```

Fix any `AgentEvent` field-name mismatches by comparing with the actual type found in Step 1.

- [ ] **Step 6: Run tests to verify they pass**

```bash
pnpm --filter opencob-cli test -- tests/renderer.test.ts
```

Expected: `4 tests passed`

- [ ] **Step 7: Commit**

```bash
git add packages/cli/src/renderer.ts packages/cli/tests/renderer.test.ts
git commit -m "feat(cli): add CliRenderer for streaming event display"
```

---

### Task 4: Refactor CLI index.ts

**Files:**

- Modify: `packages/cli/src/index.ts`

**Interfaces:**

- Consumes: `Spinner` (Task 1), `expandMentions` (Task 2), `CliRenderer` (Task 3)
- Produces: a streaming REPL where tokens appear progressively, `#file` mentions expand before the agent call, tool calls display inline as they happen

- [ ] **Step 1: Read the current index.ts**

```bash
cat packages/cli/src/index.ts
```

Note: identify the existing readline setup, environment loading, and `AgentLoop` initialization. The rewrite keeps these; only the render loop changes.

- [ ] **Step 2: Discover the AgentLoop processMessage signature**

```bash
grep -n 'processMessage\|async.*processMessage' packages/core/src/agent/agent-loop.ts | head -10
```

Note the exact return type (should be `AsyncIterable<AgentEvent>` or `AsyncGenerator<AgentEvent>`).

- [ ] **Step 3: Rewrite `packages/cli/src/index.ts`**

Replace the entire file. Keep the existing dotenv setup and any CLI argument parsing that was already present. If the existing `index.ts` used different constructor arguments for `AgentLoop`, preserve them.

```typescript
import { createInterface } from 'node:readline';
import { config } from 'dotenv';

config();

import { AgentLoop, ModelRouter } from '@opencob/core';
import { Spinner } from './spinner.js';
import { CliRenderer } from './renderer.js';
import { expandMentions } from './mentions.js';

async function main(): Promise<void> {
  const router = ModelRouter.fromEnv();
  const agent = new AgentLoop({ llm: router });

  const spinner = new Spinner();
  const renderer = new CliRenderer(spinner);
  const cwd = process.cwd();

  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: '\nYou: ',
    terminal: process.stdin.isTTY,
  });

  if (process.stdin.isTTY) {
    console.log('OpenCob CLI — type your question or /help. Ctrl+C to exit.\n');
    rl.prompt();
  }

  rl.on('line', async (rawInput: string) => {
    const input = rawInput.trim();
    if (!input) {
      rl.prompt();
      return;
    }

    const expanded = expandMentions(input, cwd);

    try {
      const events = agent.processMessage(expanded);
      if (process.stdin.isTTY) process.stdout.write('\nAssistant: ');
      await renderer.render(events);
    } catch (err) {
      console.error('Error:', err instanceof Error ? err.message : String(err));
    }

    rl.prompt();
  });

  rl.on('close', () => {
    spinner.stop();
    if (process.stdin.isTTY) console.log('\nGoodbye.');
    process.exit(0);
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
```

Note: If `ModelRouter.fromEnv()` does not yet exist (it is added in Phase 3a), replace those two lines with the adapter construction that was in the original `index.ts`.

- [ ] **Step 4: Run typecheck**

```bash
pnpm --filter opencob-cli typecheck
```

Fix any mismatches. Common ones:

- `AgentLoop` constructor signature — check `packages/core/src/agent/agent-loop.ts` and mirror its options type
- `processMessage` return type — ensure it is assignable to `AsyncIterable<AgentEvent>`
- `ModelRouter.fromEnv` not yet available — use the fallback noted above

- [ ] **Step 5: Run full CLI test suite**

```bash
pnpm --filter opencob-cli test
```

Expected: All 12 tests pass (Spinner × 4 + mentions × 4 + renderer × 4).

- [ ] **Step 6: Build the CLI**

```bash
pnpm --filter opencob-cli build
```

Expected: No build errors. A bundle is emitted to `packages/cli/dist/`.

- [ ] **Step 7: Smoke test (non-interactive)**

```bash
echo "What is 1+1?" | node packages/cli/dist/index.js
```

Expected: The CLI reads from stdin, sends the message to the agent, and either streams a response (if LLM is configured) or prints a meaningful error (e.g., "no LLM configured"). It must not crash or hang.

- [ ] **Step 8: Commit**

```bash
git add packages/cli/src/index.ts
git commit -m "feat(cli): streaming render loop with mention expansion and spinner"
```

---

## Self-Review Checklist

- [x] `Spinner` uses only ANSI escape codes, no external deps — spec requirement met
- [x] Spinner interval is exactly 80ms with the 10-frame braille sequence — spec requirement met
- [x] `expandMentions` leaves unresolved `#token` unchanged (no crash on missing files)
- [x] `expandMentions` handles multiple tokens in one input
- [x] `CliRenderer` handles all event types from the design spec (`text`, `tool_call`, `tool_result`, `phase_change`, `mode_switch`, `error`, `done`)
- [x] `index.ts` calls `expandMentions` before passing input to the agent
- [x] Non-TTY mode supported (piped input, no prompts printed)
- [x] Typecheck step in Task 4 catches field-name mismatches after refactor
- [x] No new npm dependencies — confirmed, all using Node 22 built-ins and ANSI codes
