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
