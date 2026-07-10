# Phase 3a: LLM Adapters Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `OpenAiAdapter`, `AnthropicAdapter`, and `GeminiAdapter` so the three missing providers work out of the box when their respective API keys are set.

**Architecture:** Each adapter implements the existing `LlmAdapter` interface from `src/llm/types.ts` using Node 22 built-in `fetch` (no new SDK dependencies). `ModelRouter` gains a `fromEnv()` factory that auto-detects available providers. Tests mock `fetch` via `vi.stubGlobal`.

**Tech Stack:** TypeScript ESM, Vitest, Node 22 `fetch`, existing `LlmAdapter` interface.

## Global Constraints

- No new `node_modules` dependencies — use `globalThis.fetch` (Node 22 built-in)
- Implement `LlmAdapter` from `packages/core/src/llm/types.ts` exactly — do not change the interface
- Credentials read from environment variables only (never hardcoded)
- Tests use `vi.stubGlobal('fetch', ...)` — no real HTTP calls
- Named exports only; add new adapters to `packages/core/src/index.ts`
- Run `pnpm --filter @opencob/core test` before each commit

---

### Task 1: `OpenAiAdapter` (covers Azure via `baseUrl` override)

**Files:**

- Create: `packages/core/src/llm/openai-adapter.ts`
- Create: `packages/core/tests/openai-adapter.test.ts`

**Interfaces:**

- Produces:

  ```typescript
  export interface OpenAiAdapterOpts {
    apiKey: string
    baseUrl?: string        // defaults to 'https://api.openai.com/v1'; set to Azure endpoint for Azure
    chatModel?: string      // defaults to 'gpt-4o'
    completionModel?: string // defaults to 'gpt-3.5-turbo'
  }
  export class OpenAiAdapter implements LlmAdapter { ... }
  ```

- [ ] **Step 1: Write the failing test**

Create `packages/core/tests/openai-adapter.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { OpenAiAdapter } from '../src/llm/openai-adapter.js';

function mockFetch(chunks: string[], status = 200) {
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
  return vi
    .fn()
    .mockResolvedValue({ ok: status === 200, status, body: stream, json: async () => ({}) });
}

describe('OpenAiAdapter', () => {
  afterEach(() => vi.restoreAllMocks());

  it('getChatModel returns configured model', () => {
    const a = new OpenAiAdapter({ apiKey: 'test', chatModel: 'gpt-4o-mini' });
    expect(a.getChatModel()).toBe('gpt-4o-mini');
  });

  it('isAvailable returns true when fetch succeeds', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true }));
    const a = new OpenAiAdapter({ apiKey: 'test' });
    expect(await a.isAvailable()).toBe(true);
  });

  it('isAvailable returns false on fetch error', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network error')));
    const a = new OpenAiAdapter({ apiKey: 'test' });
    expect(await a.isAvailable()).toBe(false);
  });

  it('chat yields text events from SSE stream', async () => {
    const sseChunks = [
      'data: {"choices":[{"delta":{"content":"Hello"}}]}\n\n',
      'data: {"choices":[{"delta":{"content":" world"}}]}\n\n',
      'data: [DONE]\n\n',
    ];
    vi.stubGlobal('fetch', mockFetch(sseChunks));
    const a = new OpenAiAdapter({ apiKey: 'test' });
    const events = [];
    for await (const ev of a.chat([{ role: 'user', content: 'hi' }])) events.push(ev);
    expect(
      events
        .filter((e) => e.type === 'text')
        .map((e) => e.text)
        .join(''),
    ).toBe('Hello world');
    expect(events.at(-1)?.type).toBe('done');
  });

  it('chat yields error event on non-200 response', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 401, body: null }));
    const a = new OpenAiAdapter({ apiKey: 'test' });
    const events = [];
    for await (const ev of a.chat([{ role: 'user', content: 'hi' }])) events.push(ev);
    expect(events[0].type).toBe('error');
  });

  it('uses custom baseUrl for Azure', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal('fetch', fetchMock);
    const a = new OpenAiAdapter({
      apiKey: 'azure-key',
      baseUrl: 'https://my.openai.azure.com/openai/deployments/gpt4/v1',
    });
    await a.isAvailable();
    expect(fetchMock.mock.calls[0][0]).toContain('my.openai.azure.com');
  });
});
```

- [ ] **Step 2: Run test to confirm it fails**

```bash
pnpm --filter @opencob/core test -- tests/openai-adapter.test.ts
```

Expected: `FAIL` — module not found

- [ ] **Step 3: Create `packages/core/src/llm/openai-adapter.ts`**

```typescript
import type {
  LlmAdapter,
  ChatMessage,
  ChatOptions,
  StreamChunk,
  CompletionRequest,
  CompletionResponse,
} from './types.js';

export interface OpenAiAdapterOpts {
  apiKey: string;
  baseUrl?: string;
  chatModel?: string;
  completionModel?: string;
}

export class OpenAiAdapter implements LlmAdapter {
  readonly name = 'openai';
  private apiKey: string;
  private baseUrl: string;
  private chatModel_: string;
  private completionModel_: string;

  constructor(opts: OpenAiAdapterOpts) {
    this.apiKey = opts.apiKey;
    this.baseUrl = (opts.baseUrl ?? 'https://api.openai.com/v1').replace(/\/$/, '');
    this.chatModel_ = opts.chatModel ?? 'gpt-4o';
    this.completionModel_ = opts.completionModel ?? 'gpt-3.5-turbo';
  }

  getChatModel(): string {
    return this.chatModel_;
  }
  getCompletionModel(): string {
    return this.completionModel_;
  }
  setChatModel(m: string): void {
    this.chatModel_ = m;
  }
  setCompletionModel(m: string): void {
    this.completionModel_ = m;
  }

  async isAvailable(): Promise<boolean> {
    try {
      const r = await fetch(`${this.baseUrl}/models`, {
        headers: { Authorization: `Bearer ${this.apiKey}` },
      });
      return r.ok;
    } catch {
      return false;
    }
  }

  async listModels(): Promise<string[]> {
    try {
      const r = await fetch(`${this.baseUrl}/models`, {
        headers: { Authorization: `Bearer ${this.apiKey}` },
      });
      if (!r.ok) return [];
      const data = (await r.json()) as { data: Array<{ id: string }> };
      return data.data.map((m) => m.id);
    } catch {
      return [];
    }
  }

  async *chat(messages: ChatMessage[], opts?: ChatOptions): AsyncIterable<StreamChunk> {
    const body = {
      model: this.chatModel_,
      messages: messages.map((m) => ({
        role: m.role,
        content: m.content,
        tool_call_id: m.toolCallId,
        name: m.name,
      })),
      stream: true,
      temperature: opts?.temperature,
      max_tokens: opts?.maxTokens,
      tools: opts?.tools?.map((t) => ({
        type: 'function' as const,
        function: { name: t.name, description: t.description, parameters: t.parameters },
      })),
    };
    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${this.apiKey}` },
        body: JSON.stringify(body),
      });
    } catch (err) {
      yield { type: 'error', error: err instanceof Error ? err.message : String(err) };
      return;
    }
    if (!response.ok || !response.body) {
      yield { type: 'error', error: `OpenAI API error: ${response.status}` };
      return;
    }
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    const toolArgs: Record<string, string> = {};
    const toolNames: Record<string, string> = {};
    const toolIds: Record<string, string> = {};
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        const data = line.slice(6).trim();
        if (data === '[DONE]') {
          yield { type: 'done' };
          return;
        }
        try {
          const chunk = JSON.parse(data);
          const delta = chunk.choices?.[0]?.delta;
          if (!delta) continue;
          if (delta.content) yield { type: 'text', text: delta.content };
          if (delta.tool_calls) {
            for (const tc of delta.tool_calls) {
              const idx = String(tc.index ?? 0);
              if (tc.id) toolIds[idx] = tc.id;
              if (tc.function?.name) toolNames[idx] = tc.function.name;
              if (tc.function?.arguments)
                toolArgs[idx] = (toolArgs[idx] ?? '') + tc.function.arguments;
            }
          }
        } catch {
          /* skip malformed */
        }
      }
    }
    for (const idx of Object.keys(toolNames)) {
      try {
        yield {
          type: 'tool_call',
          toolCallId: toolIds[idx],
          toolCall: { name: toolNames[idx], parameters: JSON.parse(toolArgs[idx] ?? '{}') },
        };
      } catch {
        /* skip malformed tool args */
      }
    }
    yield { type: 'done' };
  }

  async complete(req: CompletionRequest): Promise<CompletionResponse> {
    const body = {
      model: this.completionModel_,
      prompt: req.prompt,
      suffix: req.suffix,
      max_tokens: req.maxTokens ?? 256,
      temperature: req.temperature ?? 0,
      stop: req.stop,
    };
    const r = await fetch(`${this.baseUrl}/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${this.apiKey}` },
      body: JSON.stringify(body),
    });
    const data = (await r.json()) as { choices: Array<{ text: string; finish_reason: string }> };
    return {
      text: data.choices[0]?.text ?? '',
      finishReason: data.choices[0]?.finish_reason === 'length' ? 'length' : 'stop',
    };
  }
}
```

- [ ] **Step 4: Run tests**

```bash
pnpm --filter @opencob/core test -- tests/openai-adapter.test.ts
```

Expected: all 5 tests PASS

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/llm/openai-adapter.ts packages/core/tests/openai-adapter.test.ts
git commit -m "feat(core): add OpenAiAdapter with Azure support"
```

---

### Task 2: `AnthropicAdapter`

**Files:**

- Create: `packages/core/src/llm/anthropic-adapter.ts`
- Create: `packages/core/tests/anthropic-adapter.test.ts`

**Interfaces:**

- Produces:

  ```typescript
  export interface AnthropicAdapterOpts {
    apiKey: string
    chatModel?: string       // defaults to 'claude-sonnet-4-6'
    completionModel?: string // defaults to 'claude-haiku-4-5'
  }
  export class AnthropicAdapter implements LlmAdapter { ... }
  ```

- [ ] **Step 1: Write the failing test**

Create `packages/core/tests/anthropic-adapter.test.ts`:

```typescript
import { describe, it, expect, vi, afterEach } from 'vitest';
import { AnthropicAdapter } from '../src/llm/anthropic-adapter.js';

function makeSseStream(lines: string[]) {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(c) {
      for (const l of lines) c.enqueue(encoder.encode(l));
      c.close();
    },
  });
}

describe('AnthropicAdapter', () => {
  afterEach(() => vi.restoreAllMocks());

  it('getChatModel returns default', () => {
    expect(new AnthropicAdapter({ apiKey: 'x' }).getChatModel()).toBe('claude-sonnet-4-6');
  });

  it('isAvailable returns true on 200', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true }));
    expect(await new AnthropicAdapter({ apiKey: 'x' }).isAvailable()).toBe(true);
  });

  it('chat yields text from content_block_delta events', async () => {
    const sseLines = [
      'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"Hi"}}\n\n',
      'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"!"}}\n\n',
      'event: message_stop\ndata: {"type":"message_stop"}\n\n',
    ];
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, body: makeSseStream(sseLines) }));
    const events = [];
    for await (const ev of new AnthropicAdapter({ apiKey: 'x' }).chat([
      { role: 'user', content: 'hi' },
    ]))
      events.push(ev);
    expect(
      events
        .filter((e) => e.type === 'text')
        .map((e) => e.text)
        .join(''),
    ).toBe('Hi!');
    expect(events.at(-1)?.type).toBe('done');
  });

  it('chat yields error on non-200', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 529, body: null }));
    const events = [];
    for await (const ev of new AnthropicAdapter({ apiKey: 'x' }).chat([
      { role: 'user', content: 'hi' },
    ]))
      events.push(ev);
    expect(events[0].type).toBe('error');
  });
});
```

- [ ] **Step 2: Run test to confirm it fails**

```bash
pnpm --filter @opencob/core test -- tests/anthropic-adapter.test.ts
```

Expected: `FAIL` — module not found

- [ ] **Step 3: Create `packages/core/src/llm/anthropic-adapter.ts`**

```typescript
import type {
  LlmAdapter,
  ChatMessage,
  ChatOptions,
  StreamChunk,
  CompletionRequest,
  CompletionResponse,
} from './types.js';

export interface AnthropicAdapterOpts {
  apiKey: string;
  chatModel?: string;
  completionModel?: string;
}

export class AnthropicAdapter implements LlmAdapter {
  readonly name = 'anthropic';
  private apiKey: string;
  private chatModel_: string;
  private completionModel_: string;
  private readonly baseUrl = 'https://api.anthropic.com/v1';
  private readonly version = '2023-06-01';

  constructor(opts: AnthropicAdapterOpts) {
    this.apiKey = opts.apiKey;
    this.chatModel_ = opts.chatModel ?? 'claude-sonnet-4-6';
    this.completionModel_ = opts.completionModel ?? 'claude-haiku-4-5';
  }

  getChatModel(): string {
    return this.chatModel_;
  }
  getCompletionModel(): string {
    return this.completionModel_;
  }
  setChatModel(m: string): void {
    this.chatModel_ = m;
  }
  setCompletionModel(m: string): void {
    this.completionModel_ = m;
  }

  async isAvailable(): Promise<boolean> {
    try {
      const r = await fetch(`${this.baseUrl}/models`, {
        headers: { 'x-api-key': this.apiKey, 'anthropic-version': this.version },
      });
      return r.ok;
    } catch {
      return false;
    }
  }

  async listModels(): Promise<string[]> {
    try {
      const r = await fetch(`${this.baseUrl}/models`, {
        headers: { 'x-api-key': this.apiKey, 'anthropic-version': this.version },
      });
      if (!r.ok) return [];
      const data = (await r.json()) as { data: Array<{ id: string }> };
      return data.data.map((m) => m.id);
    } catch {
      return [];
    }
  }

  async *chat(messages: ChatMessage[], opts?: ChatOptions): AsyncIterable<StreamChunk> {
    // Anthropic separates system messages from conversation messages
    const systemMsgs = messages
      .filter((m) => m.role === 'system')
      .map((m) => m.content)
      .join('\n');
    const convMsgs = messages
      .filter((m) => m.role !== 'system')
      .map((m) => ({ role: m.role === 'tool' ? 'user' : m.role, content: m.content }));

    const body = {
      model: this.chatModel_,
      messages: convMsgs,
      system: systemMsgs || undefined,
      max_tokens: opts?.maxTokens ?? 4096,
      temperature: opts?.temperature,
      stream: true,
      tools: opts?.tools?.map((t) => ({
        name: t.name,
        description: t.description,
        input_schema: t.parameters,
      })),
    };

    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}/messages`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': this.apiKey,
          'anthropic-version': this.version,
        },
        body: JSON.stringify(body),
      });
    } catch (err) {
      yield { type: 'error', error: err instanceof Error ? err.message : String(err) };
      return;
    }

    if (!response.ok || !response.body) {
      yield { type: 'error', error: `Anthropic API error: ${response.status}` };
      return;
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let currentToolName = '';
    let currentToolId = '';
    let currentToolInput = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const blocks = buffer.split('\n\n');
      buffer = blocks.pop() ?? '';
      for (const block of blocks) {
        const dataLine = block.split('\n').find((l) => l.startsWith('data: '));
        if (!dataLine) continue;
        try {
          const ev = JSON.parse(dataLine.slice(6));
          if (ev.type === 'content_block_delta') {
            if (ev.delta?.type === 'text_delta') yield { type: 'text', text: ev.delta.text };
            if (ev.delta?.type === 'input_json_delta')
              currentToolInput += ev.delta.partial_json ?? '';
          } else if (ev.type === 'content_block_start' && ev.content_block?.type === 'tool_use') {
            currentToolName = ev.content_block.name;
            currentToolId = ev.content_block.id;
            currentToolInput = '';
          } else if (ev.type === 'content_block_stop' && currentToolName) {
            try {
              yield {
                type: 'tool_call',
                toolCallId: currentToolId,
                toolCall: {
                  name: currentToolName,
                  parameters: JSON.parse(currentToolInput || '{}'),
                },
              };
            } catch {
              /* skip */
            }
            currentToolName = '';
          } else if (ev.type === 'message_stop') {
            yield { type: 'done' };
            return;
          }
        } catch {
          /* skip malformed */
        }
      }
    }
    yield { type: 'done' };
  }

  async complete(req: CompletionRequest): Promise<CompletionResponse> {
    // Anthropic doesn't have a completion endpoint; use chat with a single user message
    const msgs = [
      { role: 'user' as const, content: req.prompt + (req.suffix ? '\n' + req.suffix : '') },
    ];
    let text = '';
    for await (const chunk of this.chat(msgs, { maxTokens: req.maxTokens })) {
      if (chunk.type === 'text' && chunk.text) text += chunk.text;
    }
    return { text, finishReason: 'stop' };
  }
}
```

- [ ] **Step 4: Run tests**

```bash
pnpm --filter @opencob/core test -- tests/anthropic-adapter.test.ts
```

Expected: all 4 tests PASS

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/llm/anthropic-adapter.ts packages/core/tests/anthropic-adapter.test.ts
git commit -m "feat(core): add AnthropicAdapter"
```

---

### Task 3: `GeminiAdapter`

**Files:**

- Create: `packages/core/src/llm/gemini-adapter.ts`
- Create: `packages/core/tests/gemini-adapter.test.ts`

**Interfaces:**

- Produces:

  ```typescript
  export interface GeminiAdapterOpts {
    apiKey: string
    chatModel?: string       // defaults to 'gemini-2.0-flash'
    completionModel?: string // defaults to 'gemini-2.0-flash'
  }
  export class GeminiAdapter implements LlmAdapter { ... }
  ```

- [ ] **Step 1: Write the failing test**

Create `packages/core/tests/gemini-adapter.test.ts`:

```typescript
import { describe, it, expect, vi, afterEach } from 'vitest';
import { GeminiAdapter } from '../src/llm/gemini-adapter.js';

function makeNdJsonStream(objects: unknown[]) {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(c) {
      for (const obj of objects) c.enqueue(encoder.encode(JSON.stringify(obj) + '\n'));
      c.close();
    },
  });
}

describe('GeminiAdapter', () => {
  afterEach(() => vi.restoreAllMocks());

  it('getChatModel returns default', () => {
    expect(new GeminiAdapter({ apiKey: 'x' }).getChatModel()).toBe('gemini-2.0-flash');
  });

  it('isAvailable returns true on 200', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true }));
    expect(await new GeminiAdapter({ apiKey: 'x' }).isAvailable()).toBe(true);
  });

  it('chat yields text from streaming response', async () => {
    const chunks = [
      { candidates: [{ content: { parts: [{ text: 'Hello' }] } }] },
      { candidates: [{ content: { parts: [{ text: ' Gemini' }] }, finishReason: 'STOP' }] },
    ];
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, body: makeNdJsonStream(chunks) }));
    const events = [];
    for await (const ev of new GeminiAdapter({ apiKey: 'x' }).chat([
      { role: 'user', content: 'hi' },
    ]))
      events.push(ev);
    expect(
      events
        .filter((e) => e.type === 'text')
        .map((e) => e.text)
        .join(''),
    ).toBe('Hello Gemini');
    expect(events.at(-1)?.type).toBe('done');
  });

  it('chat yields error on non-200', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 400, body: null }));
    const events = [];
    for await (const ev of new GeminiAdapter({ apiKey: 'x' }).chat([
      { role: 'user', content: 'hi' },
    ]))
      events.push(ev);
    expect(events[0].type).toBe('error');
  });
});
```

- [ ] **Step 2: Run test to confirm it fails**

```bash
pnpm --filter @opencob/core test -- tests/gemini-adapter.test.ts
```

Expected: `FAIL` — module not found

- [ ] **Step 3: Create `packages/core/src/llm/gemini-adapter.ts`**

```typescript
import type {
  LlmAdapter,
  ChatMessage,
  ChatOptions,
  StreamChunk,
  CompletionRequest,
  CompletionResponse,
} from './types.js';

export interface GeminiAdapterOpts {
  apiKey: string;
  chatModel?: string;
  completionModel?: string;
}

export class GeminiAdapter implements LlmAdapter {
  readonly name = 'gemini';
  private apiKey: string;
  private chatModel_: string;
  private completionModel_: string;
  private readonly baseUrl = 'https://generativelanguage.googleapis.com/v1beta';

  constructor(opts: GeminiAdapterOpts) {
    this.apiKey = opts.apiKey;
    this.chatModel_ = opts.chatModel ?? 'gemini-2.0-flash';
    this.completionModel_ = opts.completionModel ?? 'gemini-2.0-flash';
  }

  getChatModel(): string {
    return this.chatModel_;
  }
  getCompletionModel(): string {
    return this.completionModel_;
  }
  setChatModel(m: string): void {
    this.chatModel_ = m;
  }
  setCompletionModel(m: string): void {
    this.completionModel_ = m;
  }

  async isAvailable(): Promise<boolean> {
    try {
      const r = await fetch(`${this.baseUrl}/models?key=${this.apiKey}`);
      return r.ok;
    } catch {
      return false;
    }
  }

  async listModels(): Promise<string[]> {
    try {
      const r = await fetch(`${this.baseUrl}/models?key=${this.apiKey}`);
      if (!r.ok) return [];
      const data = (await r.json()) as { models: Array<{ name: string }> };
      return data.models.map((m) => m.name.replace('models/', ''));
    } catch {
      return [];
    }
  }

  async *chat(messages: ChatMessage[], opts?: ChatOptions): AsyncIterable<StreamChunk> {
    const contents = messages
      .filter((m) => m.role !== 'system')
      .map((m) => ({
        role: m.role === 'assistant' ? 'model' : 'user',
        parts: [{ text: m.content }],
      }));
    const systemInstruction = messages.find((m) => m.role === 'system')?.content;

    const body = {
      contents,
      systemInstruction: systemInstruction ? { parts: [{ text: systemInstruction }] } : undefined,
      generationConfig: { maxOutputTokens: opts?.maxTokens, temperature: opts?.temperature },
    };

    let response: Response;
    try {
      response = await fetch(
        `${this.baseUrl}/models/${this.chatModel_}:streamGenerateContent?alt=sse&key=${this.apiKey}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        },
      );
    } catch (err) {
      yield { type: 'error', error: err instanceof Error ? err.message : String(err) };
      return;
    }

    if (!response.ok || !response.body) {
      yield { type: 'error', error: `Gemini API error: ${response.status}` };
      return;
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith(':')) continue;
        const data = trimmed.startsWith('data: ') ? trimmed.slice(6) : trimmed;
        try {
          const chunk = JSON.parse(data);
          const parts = chunk.candidates?.[0]?.content?.parts ?? [];
          for (const part of parts) {
            if (part.text) yield { type: 'text', text: part.text };
            if (part.functionCall)
              yield {
                type: 'tool_call',
                toolCall: {
                  name: part.functionCall.name,
                  parameters: part.functionCall.args ?? {},
                },
              };
          }
        } catch {
          /* skip */
        }
      }
    }
    yield { type: 'done' };
  }

  async complete(req: CompletionRequest): Promise<CompletionResponse> {
    let text = '';
    for await (const chunk of this.chat([{ role: 'user', content: req.prompt }], {
      maxTokens: req.maxTokens,
    })) {
      if (chunk.type === 'text' && chunk.text) text += chunk.text;
    }
    return { text, finishReason: 'stop' };
  }
}
```

- [ ] **Step 4: Run tests**

```bash
pnpm --filter @opencob/core test -- tests/gemini-adapter.test.ts
```

Expected: all 4 tests PASS

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/llm/gemini-adapter.ts packages/core/tests/gemini-adapter.test.ts
git commit -m "feat(core): add GeminiAdapter"
```

---

### Task 4: `ModelRouter.fromEnv()` + `.env.example` + barrel exports

**Files:**

- Modify: `packages/core/src/llm/model-router.ts`
- Modify: `packages/core/src/index.ts`
- Modify: `.env.example`

**Interfaces:**

- Consumes: `OpenAiAdapter`, `AnthropicAdapter`, `GeminiAdapter` from Tasks 1–3
- Produces: `ModelRouter.fromEnv(): ModelRouter` — returns a router with all available adapters registered based on env vars; `OPENAI_API_KEY` → OpenAI registered; `ANTHROPIC_API_KEY` → Anthropic registered; `GOOGLE_API_KEY` → Gemini registered; falls back to Ollama if none set

- [ ] **Step 1: Write the failing test**

Add to `packages/core/tests/model-router.test.ts` (append, don't replace):

```typescript
import { describe, it, expect, vi, afterEach } from 'vitest';
import { ModelRouter } from '../src/llm/model-router.js';
import { OllamaAdapter } from '../src/llm/ollama-adapter.js';

describe('ModelRouter.fromEnv', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('returns a ModelRouter instance', () => {
    const router = ModelRouter.fromEnv();
    expect(router).toBeInstanceOf(ModelRouter);
  });

  it('registers OpenAiAdapter when OPENAI_API_KEY is set', () => {
    vi.stubEnv('OPENAI_API_KEY', 'test-key');
    const router = ModelRouter.fromEnv();
    const adapter = router.getAdapterForTask('chat');
    expect(adapter.name).toBe('openai');
  });

  it('registers AnthropicAdapter when ANTHROPIC_API_KEY is set', () => {
    vi.stubEnv('ANTHROPIC_API_KEY', 'test-key');
    const router = ModelRouter.fromEnv();
    const adapter = router.getAdapterForTask('chat');
    expect(adapter.name).toBe('anthropic');
  });

  it('falls back to OllamaAdapter when no API key is set', () => {
    vi.stubEnv('OPENAI_API_KEY', '');
    vi.stubEnv('ANTHROPIC_API_KEY', '');
    vi.stubEnv('GOOGLE_API_KEY', '');
    const router = ModelRouter.fromEnv();
    expect(router.getAdapterForTask('chat')).toBeInstanceOf(OllamaAdapter);
  });
});
```

- [ ] **Step 2: Run test to confirm it fails**

```bash
pnpm --filter @opencob/core test -- tests/model-router.test.ts
```

Expected: `FAIL` — `ModelRouter.fromEnv is not a function`

- [ ] **Step 3: Add `fromEnv()` to `packages/core/src/llm/model-router.ts`**

Add after the class closing brace (or as a static method inside):

```typescript
import { OpenAiAdapter } from './openai-adapter.js'
import { AnthropicAdapter } from './anthropic-adapter.js'
import { GeminiAdapter } from './gemini-adapter.js'
import { OllamaAdapter } from './ollama-adapter.js'

// Add this static method inside ModelRouter class:
static fromEnv(): ModelRouter {
  const openaiKey = process.env.OPENAI_API_KEY
  const anthropicKey = process.env.ANTHROPIC_API_KEY
  const googleKey = process.env.GOOGLE_API_KEY
  const ollamaUrl = process.env.OLLAMA_BASE_URL

  // Priority: OpenAI > Anthropic > Gemini > Ollama (fallback)
  let defaultAdapter: LlmAdapter
  if (openaiKey) {
    defaultAdapter = new OpenAiAdapter({ apiKey: openaiKey, baseUrl: process.env.OPENAI_BASE_URL })
  } else if (anthropicKey) {
    defaultAdapter = new AnthropicAdapter({ apiKey: anthropicKey })
  } else if (googleKey) {
    defaultAdapter = new GeminiAdapter({ apiKey: googleKey })
  } else {
    defaultAdapter = new OllamaAdapter({ baseUrl: ollamaUrl })
  }

  const router = new ModelRouter(defaultAdapter)

  if (openaiKey) router.registerAdapter('openai', new OpenAiAdapter({ apiKey: openaiKey, baseUrl: process.env.OPENAI_BASE_URL }))
  if (anthropicKey) router.registerAdapter('anthropic', new AnthropicAdapter({ apiKey: anthropicKey }))
  if (googleKey) router.registerAdapter('gemini', new GeminiAdapter({ apiKey: googleKey }))

  return router
}
```

- [ ] **Step 4: Run tests**

```bash
pnpm --filter @opencob/core test -- tests/model-router.test.ts
```

Expected: all new tests PASS, existing tests still PASS

- [ ] **Step 5: Update barrel exports in `packages/core/src/index.ts`**

Add to the LLM adapters section:

```typescript
export { OpenAiAdapter, type OpenAiAdapterOpts } from './llm/openai-adapter.js';
export { AnthropicAdapter, type AnthropicAdapterOpts } from './llm/anthropic-adapter.js';
export { GeminiAdapter, type GeminiAdapterOpts } from './llm/gemini-adapter.js';
```

- [ ] **Step 6: Update `.env.example`**

Add after the existing `OLLAMA_*` section:

```bash
# ─── OpenAI / Azure OpenAI ────────────────────────────────────────────────────
# OPENAI_API_KEY=sk-...
# OPENAI_BASE_URL=https://api.openai.com/v1   # Override for Azure: https://<name>.openai.azure.com/openai/deployments/<model>/v1

# ─── Anthropic ────────────────────────────────────────────────────────────────
# ANTHROPIC_API_KEY=sk-ant-...

# ─── Google Gemini ────────────────────────────────────────────────────────────
# GOOGLE_API_KEY=AIza...
```

- [ ] **Step 7: Run full test suite and build**

```bash
pnpm --filter @opencob/core test && pnpm build
```

Expected: all tests PASS, build succeeds

- [ ] **Step 8: Commit**

```bash
git add packages/core/src/llm/model-router.ts packages/core/src/index.ts .env.example
git commit -m "feat(core): add ModelRouter.fromEnv() and export new adapters"
```
