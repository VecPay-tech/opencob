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
