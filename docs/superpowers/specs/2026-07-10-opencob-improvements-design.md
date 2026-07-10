# OpenCob Improvement Plan — Design Spec

**Date:** 2026-07-10  
**Approach:** Sequenced by stability (Infrastructure → Code Quality → Feature Completeness → UX/CLI)  
**Scope:** Four improvement phases, each independently releasable.

---

## 1. Infrastructure Hardening (Phase 1)

### 1.1 Current State

CI/CD is largely in place (`ci.yaml`, `release.yaml`, `codeql.yaml`, `dependency-review.yaml`). Three specific gaps remain:

| Gap                                      | Location                                                 | Impact                             |
| ---------------------------------------- | -------------------------------------------------------- | ---------------------------------- |
| Lint failures do not block CI            | `ci.yaml` line: `continue-on-error: true`                | Lint debt accumulates silently     |
| No test coverage reporting or thresholds | `ci.yaml` test job; no `vitest.config.ts` coverage block | Coverage regressions go undetected |
| No VSIX packaging workflow               | `.github/workflows/` — no extension packaging job        | Extension release is fully manual  |

### 1.2 Changes

**1.2.1 Fix lint gate**  
Remove `continue-on-error: true` from the Lint job in `ci.yaml`. Lint failures must block the `ci-ok` gate. Add `lint` to the `needs` list of the `ci-ok` job.

**1.2.2 Coverage reporting**  
Add a `vitest.config.ts` (or extend the existing one) at `packages/core/` with:

```ts
coverage: {
  provider: 'v8',
  reporter: ['text', 'lcov', 'json-summary'],
  thresholds: { lines: 70, functions: 70, branches: 60 },
  exclude: ['**/tests/**', '**/dist/**'],
}
```

Update the test job in `ci.yaml` to run `pnpm --filter @opencob/core test -- --coverage` and upload the `lcov` report as an artifact. Add a Codecov or equivalent summary step.

**1.2.3 VSIX packaging workflow**  
New file: `.github/workflows/package-extension.yaml`  
Triggers on: push to `main` (produces a pre-release VSIX artifact) and on version tags `v*.*.*` (attaches VSIX to the GitHub Release).  
Steps: checkout → install → build → `cd packages/extension && pnpm package` → upload artifact.

### 1.3 Files to Create / Modify

| File                                       | Action                                            |
| ------------------------------------------ | ------------------------------------------------- |
| `.github/workflows/ci.yaml`                | Fix lint gate; add coverage step                  |
| `packages/core/vitest.config.ts`           | Update — add coverage block (file already exists) |
| `.github/workflows/package-extension.yaml` | Create                                            |

---

## 2. Agent Loop Decomposition (Phase 2)

### 2.1 Current State

`packages/core/src/agent/agent-loop.ts` is 1,358 lines. It conflates six distinct responsibilities in a single class:

| Responsibility                                   | Lines (approx) |
| ------------------------------------------------ | -------------- |
| Slash command dispatch + prompt transforms       | 163–580        |
| Git context resolution (`/review`, `/create-pr`) | 751–852        |
| System prompt assembly + repo tree               | 852–985        |
| Text-format tool call parsing fallback           | 986–1016       |
| File change tracking + changes summary           | 1062–1118      |
| Multi-step orchestrator execution                | 1119–1358      |
| Core tool-call loop (remaining)                  | 250–580        |

This violates the project convention ("one class/module per file") and makes the agent loop hard to test, extend, or reason about.

### 2.2 Decomposition Design

Extract five focused modules. `AgentLoop` becomes a thin coordinator.

**`src/agent/slash-command-handler.ts`** — `SlashCommandHandler`  
Handles all `/command` routing: mode switches, prompt-prefix commands (`/explain`, `/fix`, `/test`, `/review`, `/diagram`), custom commands loaded from `.opencob/commands/`, and the `/create-pr` flow. Depends on: `ModeEngine`, `CustomizationLoader`. Returns either a transformed message string or a terminal `AgentEvent`.

**`src/agent/git-context-resolver.ts`** — `GitContextResolver`  
Encapsulates `looksLikeBranch`, `resolveGitBranchDiff`, `resolveGitPrContext`. Pure file-system/shell operations, no LLM dependency. Easily unit-tested in isolation.

**`src/agent/system-prompt-builder.ts`** — `SystemPromptBuilder`  
Builds the system prompt from mode, customizations, skills, and repo tree. Owns `buildSystemPrompt()` and `buildCompactRepoTree()`. Depends on: `ModeEngine`, `CustomizationLoader`, `SkillsLoader`.

**`src/agent/tool-call-loop.ts`** — `ToolCallLoop`  
The inner async generator that sends messages to the LLM, parses tool calls (including the text-format fallback), dispatches to `ToolRegistry`, handles approval, emits `tool_call`/`tool_result` events, and drives self-correction retries. This is the hot path and deserves its own module.

**`src/agent/change-tracker.ts`** — `ChangeTracker`  
Tracks file writes during a turn (`trackFileChange`) and emits the `changes_summary` event. Stateful per-turn, reset at the start of each `processMessage` call.

**`AgentLoop`** — reduced to ~200 lines  
Constructor wires up the five modules. `processMessage` orchestrates: slash-command check → context gathering → RAG → compaction check → `ToolCallLoop` → `ChangeTracker` summary → `done`. No business logic.

### 2.3 Interface Contracts

All extracted modules communicate through the existing `AgentEvent` type and the shared `LlmAdapter` / `ToolRegistry` interfaces — no new public API surface required. `AgentLoop` remains the only exported class; the five modules are internal (`src/agent/` directory, not re-exported from `index.ts`).

### 2.4 Test Strategy

Each extracted module gets its own test file in `packages/core/tests/`. The existing `agent-loop.test.ts` continues to cover end-to-end behaviour via the `AgentLoop` public API — no changes needed to passing tests. New unit tests cover:

- `SlashCommandHandler`: each command variant, unknown commands, custom commands
- `GitContextResolver`: branch detection heuristic, diff output shape
- `SystemPromptBuilder`: prompt includes mode/skills/customization blocks
- `ToolCallLoop`: tool approval flow, self-correction retry, text-format fallback parsing
- `ChangeTracker`: per-turn reset, summary event shape

### 2.5 Files to Create / Modify

| File                                                | Action                 |
| --------------------------------------------------- | ---------------------- |
| `packages/core/src/agent/slash-command-handler.ts`  | Create                 |
| `packages/core/src/agent/git-context-resolver.ts`   | Create                 |
| `packages/core/src/agent/system-prompt-builder.ts`  | Create                 |
| `packages/core/src/agent/tool-call-loop.ts`         | Create                 |
| `packages/core/src/agent/change-tracker.ts`         | Create                 |
| `packages/core/src/agent/agent-loop.ts`             | Refactor to ~200 lines |
| `packages/core/tests/slash-command-handler.test.ts` | Create                 |
| `packages/core/tests/git-context-resolver.test.ts`  | Create                 |
| `packages/core/tests/system-prompt-builder.test.ts` | Create                 |
| `packages/core/tests/tool-call-loop.test.ts`        | Create                 |
| `packages/core/tests/change-tracker.test.ts`        | Create                 |

---

## 3. Feature Completeness (Phase 3)

### 3.1 LLM Adapters

The `LlmAdapter` interface in `src/llm/types.ts` is already well-defined. Implementing the three missing adapters is additive — no changes to existing code.

**`src/llm/openai-adapter.ts`** — `OpenAiAdapter`  
Implements `LlmAdapter` against the OpenAI Chat Completions API (streaming via SSE). Configurable `baseURL` and `apiKey` so Azure OpenAI is covered by the same class with a different base URL. Supports tool-call streaming (OpenAI `tool_calls` delta chunks → `StreamChunk`). Models: configurable, defaults to `gpt-4o` for chat, `gpt-3.5-turbo` for completion.

**`src/llm/anthropic-adapter.ts`** — `AnthropicAdapter`  
Implements `LlmAdapter` against the Anthropic Messages API (streaming). Maps Anthropic `content_block_delta` events to `StreamChunk`. Tool use via Anthropic's native tool format, mapped to the shared `ToolDefinition` schema. Models: configurable, defaults to `claude-sonnet-4-6` for chat.

**`src/llm/gemini-adapter.ts`** — `GeminiAdapter`  
Implements `LlmAdapter` against the Google Gemini API (via `@google/generative-ai` or the REST streaming endpoint). Maps `GenerateContentStreamResult` to `StreamChunk`. Models: configurable, defaults to `gemini-2.0-flash` for chat.

**Configuration:** Each adapter reads credentials from environment variables (`OPENAI_API_KEY`, `OPENAI_BASE_URL`, `ANTHROPIC_API_KEY`, `GOOGLE_API_KEY`). The `ModelRouter` gains a factory method `ModelRouter.fromEnv()` that auto-detects which adapters are available and registers them. The `.env.example` is updated with the new variables.

**No new dependencies beyond what's already used:** All three adapters use `node:https` / `fetch` directly (Node 22 has `fetch` built in) — no SDK packages added, keeping the bundle lean and avoiding supply-chain surface.

### 3.2 Legacy Language Parsers

Four parsers to add to `packages/core/src/legacy/`. Each follows the same pattern as `cobol-parser.ts`: regex/structural parsing (no Tree-sitter grammar required for initial pass), exports a typed AST, and exposes a `parse(content: string): ParseResult` function.

**`jcl-parser.ts`**  
Parses IBM JCL. Extracts: `JOB` statement (jobname, accounting), `EXEC` steps (PGM or PROC name, step name), `DD` statements (DSNAME, DISP, DCB parameters), `PROC`/`PEND` boundaries, `IF`/`THEN`/`ELSE`/`ENDIF` conditional flows, `SET` symbol definitions, and `INCLUDE` members. Output: `JclJob { jobName, steps: JclStep[], symbols: Map<string,string> }`.

**`rexx-parser.ts`**  
Parses Classic REXX and Object REXX scripts. Extracts: procedure labels, `CALL` targets (internal and external), `SIGNAL` targets, `INTERPRET` usage (flags dynamic execution), `SAY` statements, `DO`/`END` block nesting, and `PARSE` variable assignments. Output: `RexxProgram { labels: string[], calls: RexxCall[], signals: string[], hasDynamicExec: boolean }`.

**`natural-parser.ts`**  
Parses Software AG NATURAL programs. Extracts: program/subprogram/function header, `DEFINE DATA` block (LOCAL/GLOBAL/PARAMETER variables with types), `CALLNAT` / `FETCH` / `INCLUDE` references, `READ` / `FIND` / `HISTOGRAM` database access statements (with DDM name), `FORMAT` and `WRITE` output statements. Output: `NaturalProgram { type, name, dataArea: NaturalVariable[], externalCalls: string[], dbAccess: NaturalDbAccess[] }`.

**`assembler-parser.ts`**  
Parses IBM High Level Assembler (HLASM) source. Extracts: `CSECT`/`DSECT`/`RSECT` section boundaries, `USING`/`DROP` register assignments, `CALL`/`BALR`/`BAL`/`BAS` branch-and-link targets, `DC`/`DS` data definitions, `MACRO` / `MEND` boundaries, `COPY` members, and `END` statement. Output: `AssemblerProgram { sections: AsmSection[], macros: string[], copies: string[], entryPoint?: string }`.

Each parser ships with:

- A test file in `packages/core/tests/` with representative fixture snippets inline
- Registration in `packages/core/src/legacy/index.ts` (new barrel file)
- Extension detection in `packages/core/src/tools/diagram-types.ts` (`JCL_EXTS`, `REXX_EXTS`, `NATURAL_EXTS`, `ASM_EXTS`)
- A corresponding entry in `FindingsScanner` for language-appropriate rules

### 3.3 Files to Create / Modify

| File                                             | Action                                                                         |
| ------------------------------------------------ | ------------------------------------------------------------------------------ |
| `packages/core/src/llm/openai-adapter.ts`        | Create                                                                         |
| `packages/core/src/llm/anthropic-adapter.ts`     | Create                                                                         |
| `packages/core/src/llm/gemini-adapter.ts`        | Create                                                                         |
| `packages/core/src/llm/model-router.ts`          | Add `fromEnv()` factory                                                        |
| `packages/core/src/legacy/jcl-parser.ts`         | Create                                                                         |
| `packages/core/src/legacy/rexx-parser.ts`        | Create                                                                         |
| `packages/core/src/legacy/natural-parser.ts`     | Create                                                                         |
| `packages/core/src/legacy/assembler-parser.ts`   | Create                                                                         |
| `packages/core/src/legacy/index.ts`              | Create (barrel)                                                                |
| `packages/core/src/tools/diagram-types.ts`       | Add new extension sets                                                         |
| `packages/core/src/findings/findings-scanner.ts` | Add rules for new languages                                                    |
| `packages/core/src/index.ts`                     | Export new adapters and parsers                                                |
| `.env.example`                                   | Add `OPENAI_API_KEY`, `OPENAI_BASE_URL`, `ANTHROPIC_API_KEY`, `GOOGLE_API_KEY` |
| `packages/core/tests/openai-adapter.test.ts`     | Create                                                                         |
| `packages/core/tests/anthropic-adapter.test.ts`  | Create                                                                         |
| `packages/core/tests/gemini-adapter.test.ts`     | Create                                                                         |
| `packages/core/tests/jcl-parser.test.ts`         | Create                                                                         |
| `packages/core/tests/rexx-parser.test.ts`        | Create                                                                         |
| `packages/core/tests/natural-parser.test.ts`     | Create                                                                         |
| `packages/core/tests/assembler-parser.test.ts`   | Create                                                                         |

---

## 4. CLI UX (Phase 4)

### 4.1 Current State

`packages/cli/src/index.ts` is a minimal `readline`-based REPL. It does not:

- Render streaming tokens progressively (it buffers and prints at turn end)
- Display tool calls / tool results as they happen
- Support `#file.cob` mention syntax on the command line
- Show a spinner or phase indicator during long operations
- Support mode-switching commands (`/mode legacy-review`)

### 4.2 Design

**4.2.1 Streaming terminal renderer**  
The agent loop already emits `AgentEvent` objects as an async iterable. The CLI needs to consume them as they arrive. Replace the current buffered `for await` with an event-driven renderer:

- `text` events → `process.stdout.write(chunk.text)` (progressive token output)
- `phase_change` events → update a single-line spinner using ANSI escape codes (no external dependency; `\r\x1b[K` + spinner frame + phase label)
- `tool_call` events → print `  ⚙ <tool_name>(<args summary>)` on its own line in dim colour (`\x1b[2m`)
- `tool_result` events → print `  ✓ done` or `  ✗ error: <msg>` in dim colour
- `done` event → clear spinner, print newline

**4.2.2 Mention expansion in CLI**  
Before passing user input to the agent loop, scan for `#<path>` tokens. Resolve each token relative to `process.cwd()`. If the file exists, replace the token with a fenced code block:

```
--- file: relative/path/to/file.cob ---
<file content>
```

This mirrors what the VS Code extension already does via `MentionParser`. The CLI gains a thin `expandMentions(input: string, cwd: string): string` helper in `packages/cli/src/mentions.ts`.

**4.2.3 Mode commands in the REPL**  
The agent loop already handles `/mode <slug>` via `SlashCommandHandler` (after Phase 2 refactor) or the existing slash command handling. The CLI only needs to display the mode-switch confirmation event: when a `mode_switch` event arrives, print `  → Switched to <mode> mode`.

**4.2.4 Spinner / phase display**  
A lightweight `Spinner` class in `packages/cli/src/spinner.ts` manages a single line of terminal output. It uses `setInterval` at 80ms to cycle through `['⠋','⠙','⠹','⠸','⠼','⠴','⠦','⠧','⠇','⠏']` + current phase label. On `stop()`, it clears the line. No external dependencies.

### 4.3 Files to Create / Modify

| File                           | Action                                                            |
| ------------------------------ | ----------------------------------------------------------------- |
| `packages/cli/src/index.ts`    | Refactor: streaming render loop, mention expansion, mode display  |
| `packages/cli/src/renderer.ts` | Create: `CliRenderer` class consuming `AsyncIterable<AgentEvent>` |
| `packages/cli/src/spinner.ts`  | Create: `Spinner` (ANSI, no deps)                                 |
| `packages/cli/src/mentions.ts` | Create: `expandMentions()`                                        |

---

## 5. Sequencing & Dependencies

```
Phase 1 (Infrastructure)
  └─ Unlocks: coverage gate catches regressions from all later phases

Phase 2 (Agent Loop Decomposition)
  └─ Unlocks: new adapters/parsers integrate cleanly into extracted modules
             CLI renderer integrates with the refactored event stream

Phase 3 (Feature Completeness)
  ├─ LLM Adapters: independent of parser work, can parallel with parsers
  └─ Legacy Parsers: independent of adapter work, can parallel with adapters

Phase 4 (CLI UX)
  └─ Depends on Phase 2 (streaming event loop is cleaner after decomposition)
     Depends on Phase 3 (new parsers surfaced via CLI mention expansion)
```

Phases 3a (adapters) and 3b (parsers) are fully independent and can be developed in parallel within Phase 3.

---

## 6. Success Criteria

| Phase | Done When                                                                                                                                                                   |
| ----- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1     | `pnpm lint` failure blocks `ci-ok`; coverage report appears in CI artifacts; VSIX is built on every push to `main`                                                          |
| 2     | `agent-loop.ts` is ≤ 250 lines; all existing agent-loop tests pass; five new unit test files pass                                                                           |
| 3a    | `OPENAI_API_KEY` set → `ModelRouter.fromEnv()` returns an `OpenAiAdapter`; adapter tests pass with mocked HTTP                                                              |
| 3b    | `jcl-parser`, `rexx-parser`, `natural-parser`, `assembler-parser` each parse representative fixtures without error; findings scanner detects at least one rule per language |
| 4     | `pnpm --filter @opencob/cli start` streams tokens progressively; `#somefile.cob` expands file content; phase spinner visible during tool execution                          |

---

## 7. Out of Scope

- COBOL-aware RAG chunking (separate initiative; requires Tree-sitter grammar extensions)
- Extension UI changes (handled separately per VS Code extension conventions)
- Documentation site updates (Nextra, separate stream)
- Removing unused plugins (`vercel`, `pyright-lsp`) from global settings — user preference
