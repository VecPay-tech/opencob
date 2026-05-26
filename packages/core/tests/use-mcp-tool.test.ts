import { describe, it, expect, vi } from 'vitest';
import { createUseMcpTool } from '../src/tools/use-mcp-tool.js';
import type { MCPClient } from '../src/mcp/mcp-client.js';

function mockMCPClient(overrides: Partial<MCPClient> = {}): MCPClient {
  return {
    isConnected: vi.fn().mockReturnValue(false),
    listServers: vi.fn().mockReturnValue([]),
    callTool: vi.fn().mockResolvedValue({ content: [{ type: 'text', text: 'result' }] }),
    listTools: vi.fn().mockReturnValue([]),
    ...overrides,
  } as unknown as MCPClient;
}

describe('use_mcp_tool', () => {
  it('requires server_id', async () => {
    const tool = createUseMcpTool(mockMCPClient());
    const result = await tool.execute({ tool_name: 'x' });
    expect(result.success).toBe(false);
    expect(result.content).toContain('server_id is required');
  });

  it('requires tool_name', async () => {
    const tool = createUseMcpTool(mockMCPClient());
    const result = await tool.execute({ server_id: 's1' });
    expect(result.success).toBe(false);
    expect(result.content).toContain('tool_name is required');
  });

  it('reports disconnected server', async () => {
    const client = mockMCPClient({ isConnected: vi.fn().mockReturnValue(false) });
    const tool = createUseMcpTool(client);
    const result = await tool.execute({ server_id: 's1', tool_name: 'read' });
    expect(result.success).toBe(false);
    expect(result.content).toContain('not connected');
  });

  it('lists connected servers in error message', async () => {
    const client = mockMCPClient({
      isConnected: vi.fn().mockReturnValue(false),
      listServers: vi.fn().mockReturnValue([{ id: 'a' }, { id: 'b' }]),
    });
    const tool = createUseMcpTool(client);
    const result = await tool.execute({ server_id: 's1', tool_name: 'read' });
    expect(result.content).toContain('a, b');
  });

  it('calls tool successfully with no arguments', async () => {
    const client = mockMCPClient({
      isConnected: vi.fn().mockReturnValue(true),
      callTool: vi.fn().mockResolvedValue({
        content: [{ type: 'text', text: 'hello from tool' }],
        isError: false,
      }),
    });
    const tool = createUseMcpTool(client);
    const result = await tool.execute({ server_id: 's1', tool_name: 'greet' });
    expect(result.success).toBe(true);
    expect(result.content).toBe('hello from tool');
  });

  it('calls tool with parsed arguments', async () => {
    const callTool = vi.fn().mockResolvedValue({
      content: [{ type: 'text', text: 'done' }],
    });
    const client = mockMCPClient({
      isConnected: vi.fn().mockReturnValue(true),
      callTool,
    });
    const tool = createUseMcpTool(client);
    await tool.execute({
      server_id: 's1',
      tool_name: 'write',
      arguments: JSON.stringify({ path: 'a.txt', content: 'hi' }),
    });
    expect(callTool).toHaveBeenCalledWith('s1', 'write', { path: 'a.txt', content: 'hi' });
  });

  it('rejects invalid JSON arguments', async () => {
    const client = mockMCPClient({ isConnected: vi.fn().mockReturnValue(true) });
    const tool = createUseMcpTool(client);
    const result = await tool.execute({
      server_id: 's1',
      tool_name: 'x',
      arguments: 'not json!',
    });
    expect(result.success).toBe(false);
    expect(result.content).toContain('valid JSON');
  });

  it('handles callTool errors', async () => {
    const client = mockMCPClient({
      isConnected: vi.fn().mockReturnValue(true),
      callTool: vi.fn().mockRejectedValue(new Error('timeout')),
    });
    const tool = createUseMcpTool(client);
    const result = await tool.execute({ server_id: 's1', tool_name: 'slow' });
    expect(result.success).toBe(false);
    expect(result.content).toContain('timeout');
  });

  it('reports isError from tool result', async () => {
    const client = mockMCPClient({
      isConnected: vi.fn().mockReturnValue(true),
      callTool: vi.fn().mockResolvedValue({
        content: [{ type: 'text', text: 'error message' }],
        isError: true,
      }),
    });
    const tool = createUseMcpTool(client);
    const result = await tool.execute({ server_id: 's1', tool_name: 'fail' });
    expect(result.success).toBe(false);
    expect(result.content).toBe('error message');
  });

  it('handles non-text content items', async () => {
    const client = mockMCPClient({
      isConnected: vi.fn().mockReturnValue(true),
      callTool: vi.fn().mockResolvedValue({
        content: [{ type: 'image', data: 'base64...' }],
      }),
    });
    const tool = createUseMcpTool(client);
    const result = await tool.execute({ server_id: 's1', tool_name: 'img' });
    expect(result.success).toBe(true);
    // Non-text items are stringified
    expect(result.content).toContain('image');
  });
});
