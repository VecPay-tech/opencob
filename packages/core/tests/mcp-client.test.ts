import { describe, it, expect } from 'vitest';
import { MCPClient } from '../src/mcp/mcp-client.js';

describe('MCPClient', () => {
  it('initializes with no servers', () => {
    const client = new MCPClient();
    expect(client.listServers()).toHaveLength(0);
    expect(client.listTools()).toHaveLength(0);
  });

  it('reports disconnected for unknown server', () => {
    const client = new MCPClient();
    expect(client.isConnected('unknown')).toBe(false);
  });

  it('throws for unsupported transport', async () => {
    const client = new MCPClient();
    await expect(
      client.connect({
        id: 'test',
        name: 'Test',
        transport: 'grpc' as any,
      }),
    ).rejects.toThrow('not supported');
  });

  it('throws for SSE without url', async () => {
    const client = new MCPClient();
    await expect(
      client.connect({
        id: 'test',
        name: 'Test',
        transport: 'sse',
      }),
    ).rejects.toThrow('requires a "url"');
  });

  it('throws for stdio without command', async () => {
    const client = new MCPClient();
    await expect(
      client.connect({
        id: 'test',
        name: 'Test',
        transport: 'stdio',
      }),
    ).rejects.toThrow('requires a "command"');
  });

  it('returns empty config from nonexistent workspace', async () => {
    const client = new MCPClient();
    const servers = await client.loadConfig('/nonexistent/path');
    expect(servers).toHaveLength(0);
  });

  it('disconnectAll is safe with no connections', () => {
    const client = new MCPClient();
    expect(() => client.disconnectAll()).not.toThrow();
  });
});
