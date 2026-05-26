import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { OllamaAdapter } from '../src/llm/ollama-adapter.js';
import { OpenAICompatibleAdapter, PROVIDER_PRESETS } from '../src/llm/litellm-adapter.js';

// ─── Helper to mock fetch ────────────────────────────────────────────────

function mockFetch(response: unknown, options?: { ok?: boolean; status?: number }) {
  const ok = options?.ok ?? true;
  const status = options?.status ?? 200;
  return vi.fn().mockResolvedValue({
    ok,
    status,
    statusText: ok ? 'OK' : 'Error',
    text: () => Promise.resolve(JSON.stringify(response)),
    json: () => Promise.resolve(response),
    body: null,
  });
}

function mockStreamFetch(chunks: string[]) {
  const encoder = new TextEncoder();
  let index = 0;
  const reader = {
    read: vi.fn().mockImplementation(() => {
      if (index < chunks.length) {
        return Promise.resolve({ done: false, value: encoder.encode(chunks[index++]) });
      }
      return Promise.resolve({ done: true, value: undefined });
    }),
  };
  return vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    body: { getReader: () => reader },
  });
}

// ─── OllamaAdapter ──────────────────────────────────────────────────────

describe('OllamaAdapter', () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('creates with default config', () => {
    const adapter = new OllamaAdapter();
    expect(adapter.name).toBe('ollama');
  });

  it('creates with custom config', () => {
    const adapter = new OllamaAdapter({ baseUrl: 'http://localhost:9999', chatModel: 'llama3' });
    expect(adapter.getChatModel()).toBe('llama3');
  });

  it('streams chat responses', async () => {
    const lines = [
      JSON.stringify({ message: { content: 'Hello' }, done: false }) + '\n',
      JSON.stringify({ message: { content: ' World' }, done: false }) + '\n',
      JSON.stringify({ done: true }) + '\n',
    ];
    globalThis.fetch = mockStreamFetch(lines);

    const adapter = new OllamaAdapter();
    const chunks: string[] = [];
    for await (const chunk of adapter.chat([{ role: 'user', content: 'hi' }])) {
      if (chunk.type === 'text') chunks.push(chunk.text!);
    }
    expect(chunks.join('')).toBe('Hello World');
  });

  it('yields error on non-OK response', async () => {
    globalThis.fetch = mockFetch({}, { ok: false, status: 500 }) as any;
    // Need body: null for non-streaming error path
    (globalThis.fetch as any).mockResolvedValue({
      ok: false,
      status: 500,
      statusText: 'Internal Server Error',
      body: {
        getReader: () => ({ read: () => Promise.resolve({ done: true, value: undefined }) }),
      },
    });

    const adapter = new OllamaAdapter();
    const events: any[] = [];
    for await (const chunk of adapter.chat([{ role: 'user', content: 'hi' }])) {
      events.push(chunk);
    }
    expect(events.some((e) => e.type === 'error')).toBe(true);
  });

  it('yields error when no response body', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      body: null,
    }) as any;

    const adapter = new OllamaAdapter();
    const events: any[] = [];
    for await (const chunk of adapter.chat([{ role: 'user', content: 'hi' }])) {
      events.push(chunk);
    }
    expect(events.some((e) => e.type === 'error')).toBe(true);
  });

  it('completes with FIM format', async () => {
    globalThis.fetch = mockFetch({ response: 'completed code', done: true }) as any;

    const adapter = new OllamaAdapter();
    const result = await adapter.complete({ prompt: 'function hello(', suffix: ')' });
    expect(result.text).toBe('completed code');
    expect(result.finishReason).toBe('stop');
  });

  it('completes without suffix', async () => {
    globalThis.fetch = mockFetch({ response: 'more code', done: false }) as any;

    const adapter = new OllamaAdapter();
    const result = await adapter.complete({ prompt: 'const x = ' });
    expect(result.text).toBe('more code');
    expect(result.finishReason).toBe('length');
  });

  it('throws on completion error', async () => {
    globalThis.fetch = mockFetch({}, { ok: false, status: 503 }) as any;

    const adapter = new OllamaAdapter();
    await expect(adapter.complete({ prompt: 'x' })).rejects.toThrow();
  });

  it('lists models', async () => {
    globalThis.fetch = mockFetch({ models: [{ name: 'llama3' }, { name: 'qwen2.5' }] }) as any;

    const adapter = new OllamaAdapter();
    const models = await adapter.listModels();
    expect(models).toContain('llama3');
    expect(models).toContain('qwen2.5');
  });

  it('returns empty list on model fetch failure', async () => {
    globalThis.fetch = mockFetch({}, { ok: false, status: 404 }) as any;

    const adapter = new OllamaAdapter();
    const models = await adapter.listModels();
    expect(models).toEqual([]);
  });

  it('checks availability', async () => {
    globalThis.fetch = mockFetch({ version: '0.1.0' }) as any;

    const adapter = new OllamaAdapter();
    expect(await adapter.isAvailable()).toBe(true);
  });

  it('returns false when unavailable', async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new Error('ECONNREFUSED')) as any;

    const adapter = new OllamaAdapter();
    expect(await adapter.isAvailable()).toBe(false);
  });

  it('supports model hot-swap', () => {
    const adapter = new OllamaAdapter();
    adapter.setChatModel('mistral');
    expect(adapter.getChatModel()).toBe('mistral');
    adapter.setCompletionModel('codellama');
    expect(adapter.getCompletionModel()).toBe('codellama');
  });
});

// ─── OpenAICompatibleAdapter ─────────────────────────────────────────────

describe('OpenAICompatibleAdapter', () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('creates with default config', () => {
    const adapter = new OpenAICompatibleAdapter();
    expect(adapter.name).toBe('openai-compatible');
  });

  it('creates with custom provider name', () => {
    const adapter = new OpenAICompatibleAdapter({ providerName: 'azure' });
    expect(adapter.name).toBe('azure');
  });

  it('streams text response', async () => {
    const sseLines = [
      'data: {"choices":[{"delta":{"content":"Hello"}}]}\n\n',
      'data: {"choices":[{"delta":{"content":" World"}}]}\n\n',
      'data: [DONE]\n\n',
    ];
    globalThis.fetch = mockStreamFetch(sseLines);

    const adapter = new OpenAICompatibleAdapter({ apiKey: 'test-key' });
    const chunks: string[] = [];
    for await (const chunk of adapter.chat([{ role: 'user', content: 'hi' }])) {
      if (chunk.type === 'text') chunks.push(chunk.text!);
    }
    expect(chunks.join('')).toBe('Hello World');
  });

  it('handles finish_reason in stream', async () => {
    const sseLines = [
      'data: {"choices":[{"delta":{"content":"Done"},"finish_reason":"stop"}]}\n\n',
    ];
    globalThis.fetch = mockStreamFetch(sseLines);

    const adapter = new OpenAICompatibleAdapter();
    const events: any[] = [];
    for await (const chunk of adapter.chat([{ role: 'user', content: 'hi' }])) {
      events.push(chunk);
    }
    expect(events.some((e) => e.type === 'done')).toBe(true);
  });

  it('yields error on non-OK response', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 401,
      text: () => Promise.resolve('Unauthorized'),
      body: null,
    }) as any;

    const adapter = new OpenAICompatibleAdapter();
    const events: any[] = [];
    for await (const chunk of adapter.chat([{ role: 'user', content: 'hi' }])) {
      events.push(chunk);
    }
    expect(events.some((e) => e.type === 'error')).toBe(true);
    expect(events.find((e) => e.type === 'error').error).toContain('401');
  });

  it('yields error when no response body', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      body: null,
    }) as any;

    const adapter = new OpenAICompatibleAdapter();
    const events: any[] = [];
    for await (const chunk of adapter.chat([{ role: 'user', content: 'hi' }])) {
      events.push(chunk);
    }
    expect(events.some((e) => e.type === 'error')).toBe(true);
  });

  it('handles tool calls in non-streaming mode', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: () =>
        Promise.resolve({
          choices: [
            {
              message: {
                content: null,
                tool_calls: [
                  {
                    id: 'call_1',
                    type: 'function',
                    function: { name: 'read_file', arguments: '{"path":"src/index.ts"}' },
                  },
                ],
              },
              finish_reason: 'tool_calls',
            },
          ],
        }),
    }) as any;

    const adapter = new OpenAICompatibleAdapter();
    const events: any[] = [];
    for await (const chunk of adapter.chat([{ role: 'user', content: 'read the file' }], {
      tools: [{ type: 'function', function: { name: 'read_file', parameters: {} } }],
    })) {
      events.push(chunk);
    }
    expect(events.some((e) => e.type === 'tool_call')).toBe(true);
    const toolCall = events.find((e) => e.type === 'tool_call');
    expect(toolCall.toolCall.name).toBe('read_file');
  });

  it('handles text content with tools response', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: () =>
        Promise.resolve({
          choices: [
            {
              message: { content: 'I will help you', tool_calls: undefined },
              finish_reason: 'stop',
            },
          ],
        }),
    }) as any;

    const adapter = new OpenAICompatibleAdapter();
    const events: any[] = [];
    for await (const chunk of adapter.chat([{ role: 'user', content: 'help' }], {
      tools: [{ type: 'function', function: { name: 'test', parameters: {} } }],
    })) {
      events.push(chunk);
    }
    expect(events.some((e) => e.type === 'text')).toBe(true);
  });

  it('handles tools response error', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      text: () => Promise.resolve('Server Error'),
    }) as any;

    const adapter = new OpenAICompatibleAdapter();
    const events: any[] = [];
    for await (const chunk of adapter.chat([{ role: 'user', content: 'x' }], {
      tools: [{ type: 'function', function: { name: 'test', parameters: {} } }],
    })) {
      events.push(chunk);
    }
    expect(events.some((e) => e.type === 'error')).toBe(true);
  });

  it('maps assistant messages with tool_calls', async () => {
    const sseLines = ['data: {"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\n'];
    globalThis.fetch = mockStreamFetch(sseLines);

    const adapter = new OpenAICompatibleAdapter();
    const events: any[] = [];
    for await (const chunk of adapter.chat([
      { role: 'user', content: 'hi' },
      {
        role: 'assistant',
        content: '',
        toolCalls: [{ id: 'c1', type: 'function', function: { name: 'test', arguments: '{}' } }],
      },
      { role: 'tool', content: 'result', toolCallId: 'c1' },
    ])) {
      events.push(chunk);
    }
    expect(events.some((e) => e.type === 'text')).toBe(true);
  });

  it('completes with FIM', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: () =>
        Promise.resolve({
          choices: [{ message: { content: 'completed' }, finish_reason: 'stop' }],
        }),
    }) as any;

    const adapter = new OpenAICompatibleAdapter();
    const result = await adapter.complete({ prompt: 'function', suffix: ')' });
    expect(result.text).toBe('completed');
    expect(result.finishReason).toBe('stop');
  });

  it('handles completion error', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      text: () => Promise.resolve('error'),
    }) as any;

    const adapter = new OpenAICompatibleAdapter();
    await expect(adapter.complete({ prompt: 'x' })).rejects.toThrow();
  });
});

// ─── PROVIDER_PRESETS ────────────────────────────────────────────────────

describe('PROVIDER_PRESETS', () => {
  it('has presets for major providers', () => {
    expect(PROVIDER_PRESETS).toHaveProperty('openai');
    expect(PROVIDER_PRESETS).toHaveProperty('anthropic');
    expect(PROVIDER_PRESETS).toHaveProperty('azure');
    expect(PROVIDER_PRESETS).toHaveProperty('gemini');
    expect(PROVIDER_PRESETS).toHaveProperty('litellm');
    expect(PROVIDER_PRESETS).toHaveProperty('openai-compatible');
  });

  it('each preset has baseUrl and chatModel', () => {
    for (const [, preset] of Object.entries(PROVIDER_PRESETS)) {
      expect(preset.baseUrl).toBeDefined();
      expect(preset.chatModel).toBeDefined();
    }
  });
});
