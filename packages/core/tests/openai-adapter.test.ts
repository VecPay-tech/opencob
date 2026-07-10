import { describe, it, expect, vi, afterEach } from 'vitest';
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
