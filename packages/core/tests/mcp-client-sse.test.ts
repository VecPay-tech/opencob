import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { MCPClient } from '../src/mcp/mcp-client.js';

// We need to mock global fetch for SSE transport tests
const originalFetch = globalThis.fetch;
const encoder = new TextEncoder();

/**
 * Create a controllable SSE stream. Returns the stream and a push function.
 * Data pushed via push() is immediately available to readers.
 */
function createControllableStream() {
  let controller: ReadableStreamDefaultController<Uint8Array>;
  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c;
    },
  });
  const push = (data: string) => controller.enqueue(encoder.encode(data));
  const close = () => controller.close();
  return { stream, push, close };
}

/**
 * Helper: create a fetch mock that intercepts SSE GET and POST requests.
 * - On GET: returns the SSE stream
 * - On POST: calls onPost callback with the parsed body, returns { ok: true }
 */
function createSSEFetchMock(opts: {
  stream: ReadableStream<Uint8Array>;
  onPost?: (body: any, url: string) => void;
}) {
  return vi.fn().mockImplementation(async (url: string, init?: RequestInit) => {
    if (init?.method === 'POST') {
      const body = JSON.parse(init.body as string);
      opts.onPost?.(body, url);
      return { ok: true };
    }
    return { ok: true, body: opts.stream };
  });
}

describe('MCPClient — SSE transport', () => {
  let client: MCPClient;

  beforeEach(() => {
    client = new MCPClient();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it('should throw if SSE connection fails (non-200)', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 502,
      statusText: 'Bad Gateway',
    });

    await expect(
      client.connect({
        id: 'bad-sse',
        name: 'Bad',
        transport: 'sse',
        url: 'http://localhost:3000',
      }),
    ).rejects.toThrow('SSE connection to "bad-sse" failed: 502 Bad Gateway');
  });

  it('should throw if SSE response has no body', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      body: null,
    });

    await expect(
      client.connect({
        id: 'nobody-sse',
        name: 'No',
        transport: 'sse',
        url: 'http://localhost:3000',
      }),
    ).rejects.toThrow('returned no body');
  });

  it('should connect via SSE and discover tools', async () => {
    const { stream, push } = createControllableStream();

    globalThis.fetch = createSSEFetchMock({
      stream,
      onPost(body) {
        // Respond to initialize
        if (body.method === 'initialize') {
          setTimeout(
            () =>
              push(
                `data: ${JSON.stringify({ jsonrpc: '2.0', id: body.id, result: { protocolVersion: '2024-11-05' } })}\n\n`,
              ),
            5,
          );
        }
        // Respond to tools/list
        if (body.method === 'tools/list') {
          setTimeout(
            () =>
              push(
                `data: ${JSON.stringify({ jsonrpc: '2.0', id: body.id, result: { tools: [{ name: 'sse_tool', description: 'A tool', inputSchema: { type: 'object' } }] } })}\n\n`,
              ),
            5,
          );
        }
      },
    });

    // Push endpoint immediately
    push('event: endpoint\ndata: /messages\n\n');

    await client.connect({
      id: 'sse1',
      name: 'SSE',
      transport: 'sse',
      url: 'http://localhost:3000',
    });
    expect(client.isConnected('sse1')).toBe(true);
    const tools = client.listTools();
    expect(tools).toHaveLength(1);
    expect(tools[0].name).toBe('sse_tool');
  });

  it('should call tool via SSE POST and receive response via stream', async () => {
    const { stream, push } = createControllableStream();

    globalThis.fetch = createSSEFetchMock({
      stream,
      onPost(body) {
        if (body.method === 'initialize') {
          setTimeout(
            () =>
              push(
                `data: ${JSON.stringify({ jsonrpc: '2.0', id: body.id, result: { protocolVersion: '2024-11-05' } })}\n\n`,
              ),
            5,
          );
        } else if (body.method === 'tools/list') {
          setTimeout(
            () =>
              push(
                `data: ${JSON.stringify({ jsonrpc: '2.0', id: body.id, result: { tools: [] } })}\n\n`,
              ),
            5,
          );
        } else if (body.method === 'tools/call') {
          setTimeout(
            () =>
              push(
                `data: ${JSON.stringify({ jsonrpc: '2.0', id: body.id, result: { content: [{ type: 'text', text: 'sse result' }] } })}\n\n`,
              ),
            5,
          );
        }
      },
    });

    push('event: endpoint\ndata: /msg\n\n');
    await client.connect({
      id: 'call-sse',
      name: 'C',
      transport: 'sse',
      url: 'http://localhost:3000',
    });

    const result = await client.callTool('call-sse', 'my_tool', { x: 1 });
    expect(result.content[0].text).toBe('sse result');
  });

  it('should handle JSON-RPC error via SSE', async () => {
    const { stream, push } = createControllableStream();

    globalThis.fetch = createSSEFetchMock({
      stream,
      onPost(body) {
        if (body.method === 'initialize') {
          setTimeout(
            () =>
              push(
                `data: ${JSON.stringify({ jsonrpc: '2.0', id: body.id, result: { protocolVersion: '2024-11-05' } })}\n\n`,
              ),
            5,
          );
        } else if (body.method === 'tools/list') {
          setTimeout(
            () =>
              push(
                `data: ${JSON.stringify({ jsonrpc: '2.0', id: body.id, result: { tools: [] } })}\n\n`,
              ),
            5,
          );
        } else if (body.method === 'tools/call') {
          setTimeout(
            () =>
              push(
                `data: ${JSON.stringify({ jsonrpc: '2.0', id: body.id, error: { code: -32600, message: 'Invalid request' } })}\n\n`,
              ),
            5,
          );
        }
      },
    });

    push('event: endpoint\ndata: /msg\n\n');
    await client.connect({
      id: 'err-sse',
      name: 'E',
      transport: 'sse',
      url: 'http://localhost:3000',
    });

    await expect(client.callTool('err-sse', 'bad', {})).rejects.toThrow(
      'MCP error: Invalid request',
    );
  });

  it('should disconnect SSE server', async () => {
    const { stream, push } = createControllableStream();

    globalThis.fetch = createSSEFetchMock({
      stream,
      onPost(body) {
        if (body.method === 'initialize') {
          setTimeout(
            () =>
              push(
                `data: ${JSON.stringify({ jsonrpc: '2.0', id: body.id, result: { protocolVersion: '2024-11-05' } })}\n\n`,
              ),
            5,
          );
        } else if (body.method === 'tools/list') {
          setTimeout(
            () =>
              push(
                `data: ${JSON.stringify({ jsonrpc: '2.0', id: body.id, result: { tools: [] } })}\n\n`,
              ),
            5,
          );
        }
      },
    });

    push('event: endpoint\ndata: /msg\n\n');
    await client.connect({ id: 'disc', name: 'D', transport: 'sse', url: 'http://localhost:3000' });
    expect(client.isConnected('disc')).toBe(true);

    client.disconnect('disc');
    expect(client.isConnected('disc')).toBe(false);
  });

  it('should append /sse to URL if not present', async () => {
    const { stream, push } = createControllableStream();
    let capturedUrl = '';

    globalThis.fetch = vi.fn().mockImplementation(async (url: string, init?: RequestInit) => {
      if (init?.method === 'POST') {
        const body = JSON.parse(init.body as string);
        if (body.method === 'initialize') {
          setTimeout(
            () =>
              push(
                `data: ${JSON.stringify({ jsonrpc: '2.0', id: body.id, result: { protocolVersion: '2024-11-05' } })}\n\n`,
              ),
            5,
          );
        } else if (body.method === 'tools/list') {
          setTimeout(
            () =>
              push(
                `data: ${JSON.stringify({ jsonrpc: '2.0', id: body.id, result: { tools: [] } })}\n\n`,
              ),
            5,
          );
        }
        return { ok: true };
      }
      capturedUrl = url;
      return { ok: true, body: stream };
    });

    push('event: endpoint\ndata: /msg\n\n');
    await client.connect({ id: 'u1', name: 'U', transport: 'sse', url: 'http://localhost:3000' });
    expect(capturedUrl).toBe('http://localhost:3000/sse');
  });

  it('should not double-append /sse', async () => {
    const { stream, push } = createControllableStream();
    let capturedUrl = '';

    globalThis.fetch = vi.fn().mockImplementation(async (url: string, init?: RequestInit) => {
      if (init?.method === 'POST') {
        const body = JSON.parse(init.body as string);
        if (body.method === 'initialize') {
          setTimeout(
            () =>
              push(
                `data: ${JSON.stringify({ jsonrpc: '2.0', id: body.id, result: { protocolVersion: '2024-11-05' } })}\n\n`,
              ),
            5,
          );
        } else if (body.method === 'tools/list') {
          setTimeout(
            () =>
              push(
                `data: ${JSON.stringify({ jsonrpc: '2.0', id: body.id, result: { tools: [] } })}\n\n`,
              ),
            5,
          );
        }
        return { ok: true };
      }
      capturedUrl = url;
      return { ok: true, body: stream };
    });

    push('event: endpoint\ndata: /msg\n\n');
    await client.connect({
      id: 'u2',
      name: 'U2',
      transport: 'sse',
      url: 'http://localhost:3000/sse',
    });
    expect(capturedUrl).toBe('http://localhost:3000/sse');
  });

  it('should handle absolute URL endpoint in stream', async () => {
    const { stream, push } = createControllableStream();
    let postUrl = '';

    globalThis.fetch = vi.fn().mockImplementation(async (url: string, init?: RequestInit) => {
      if (init?.method === 'POST') {
        postUrl = url;
        const body = JSON.parse(init.body as string);
        if (body.method === 'initialize') {
          setTimeout(
            () =>
              push(
                `data: ${JSON.stringify({ jsonrpc: '2.0', id: body.id, result: { protocolVersion: '2024-11-05' } })}\n\n`,
              ),
            5,
          );
        } else if (body.method === 'tools/list') {
          setTimeout(
            () =>
              push(
                `data: ${JSON.stringify({ jsonrpc: '2.0', id: body.id, result: { tools: [] } })}\n\n`,
              ),
            5,
          );
        }
        return { ok: true };
      }
      return { ok: true, body: stream };
    });

    push('event: endpoint\ndata: http://other-host:4000/api/messages\n\n');
    await client.connect({ id: 'abs', name: 'A', transport: 'sse', url: 'http://localhost:3000' });
    expect(postUrl).toBe('http://other-host:4000/api/messages');
  });

  it('should send notifications/initialized after connect', async () => {
    const { stream, push } = createControllableStream();
    const postBodies: any[] = [];

    globalThis.fetch = createSSEFetchMock({
      stream,
      onPost(body) {
        postBodies.push(body);
        if (body.method === 'initialize') {
          setTimeout(
            () =>
              push(
                `data: ${JSON.stringify({ jsonrpc: '2.0', id: body.id, result: { protocolVersion: '2024-11-05' } })}\n\n`,
              ),
            5,
          );
        } else if (body.method === 'tools/list') {
          setTimeout(
            () =>
              push(
                `data: ${JSON.stringify({ jsonrpc: '2.0', id: body.id, result: { tools: [] } })}\n\n`,
              ),
            5,
          );
        }
      },
    });

    push('event: endpoint\ndata: /msg\n\n');
    await client.connect({
      id: 'notif',
      name: 'N',
      transport: 'sse',
      url: 'http://localhost:3000',
    });

    const notif = postBodies.find((b) => b.method === 'notifications/initialized');
    expect(notif).toBeDefined();
  });

  it('should pass custom headers to SSE connection', async () => {
    const { stream, push } = createControllableStream();
    let capturedHeaders: any;

    globalThis.fetch = vi.fn().mockImplementation(async (_url: string, init?: RequestInit) => {
      if (init?.method === 'POST') {
        const body = JSON.parse(init.body as string);
        if (body.method === 'initialize') {
          setTimeout(
            () =>
              push(
                `data: ${JSON.stringify({ jsonrpc: '2.0', id: body.id, result: { protocolVersion: '2024-11-05' } })}\n\n`,
              ),
            5,
          );
        } else if (body.method === 'tools/list') {
          setTimeout(
            () =>
              push(
                `data: ${JSON.stringify({ jsonrpc: '2.0', id: body.id, result: { tools: [] } })}\n\n`,
              ),
            5,
          );
        }
        return { ok: true };
      }
      capturedHeaders = init?.headers;
      return { ok: true, body: stream };
    });

    push('event: endpoint\ndata: /msg\n\n');
    await client.connect({
      id: 'hdr',
      name: 'H',
      transport: 'sse',
      url: 'http://localhost:3000',
      headers: { Authorization: 'Bearer abc' },
    });
    expect(capturedHeaders?.Authorization).toBe('Bearer abc');
  });

  it('should handle POST failure for tool call', async () => {
    const { stream, push } = createControllableStream();
    let callCount = 0;

    globalThis.fetch = vi.fn().mockImplementation(async (_url: string, init?: RequestInit) => {
      if (init?.method === 'POST') {
        callCount++;
        const body = JSON.parse(init.body as string);
        if (body.method === 'initialize') {
          setTimeout(
            () =>
              push(
                `data: ${JSON.stringify({ jsonrpc: '2.0', id: body.id, result: { protocolVersion: '2024-11-05' } })}\n\n`,
              ),
            5,
          );
          return { ok: true };
        } else if (body.method === 'tools/list') {
          setTimeout(
            () =>
              push(
                `data: ${JSON.stringify({ jsonrpc: '2.0', id: body.id, result: { tools: [] } })}\n\n`,
              ),
            5,
          );
          return { ok: true };
        } else if (body.method === 'notifications/initialized') {
          return { ok: true };
        }
        // tools/call — throw network error
        throw new Error('Network error');
      }
      return { ok: true, body: stream };
    });

    push('event: endpoint\ndata: /msg\n\n');
    await client.connect({
      id: 'pfail',
      name: 'PF',
      transport: 'sse',
      url: 'http://localhost:3000',
    });

    await expect(client.callTool('pfail', 'tool', {})).rejects.toThrow(
      'Failed to POST to MCP server',
    );
  });

  it('should throw if no URL provided for SSE', async () => {
    await expect(
      client.connect({ id: 'no-url', name: 'X', transport: 'sse' } as any),
    ).rejects.toThrow('requires a "url"');
  });
});
