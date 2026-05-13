import type { Tool, ToolResult } from './types.js';
import type { MCPClient } from '../mcp/mcp-client.js';

/**
 * Tool that invokes an MCP server tool by name.
 */
export function createUseMcpTool(mcpClient: MCPClient): Tool {
  return {
    name: 'use_mcp_tool',
    group: 'mcp',
    description:
      'Invoke a tool provided by a connected MCP server. List available tools with server_id and tool_name.',
    parameters: [
      {
        name: 'server_id',
        type: 'string',
        description: 'MCP server ID (from mcp_servers.json config)',
        required: true,
      },
      {
        name: 'tool_name',
        type: 'string',
        description: 'Name of the tool to invoke',
        required: true,
      },
      {
        name: 'arguments',
        type: 'string',
        description: 'JSON string of arguments to pass to the tool',
        required: false,
      },
    ],
    async execute(params: Record<string, unknown>): Promise<ToolResult> {
      const serverId = params.server_id as string;
      const toolName = params.tool_name as string;
      const argsStr = params.arguments as string | undefined;

      if (!serverId) return { success: false, content: 'Error: server_id is required' };
      if (!toolName) return { success: false, content: 'Error: tool_name is required' };

      if (!mcpClient.isConnected(serverId)) {
        const servers = mcpClient.listServers().map((s) => s.id).join(', ');
        return {
          success: false,
          content: `Error: MCP server "${serverId}" is not connected. Connected servers: ${servers || 'none'}`,
        };
      }

      let args: Record<string, unknown> = {};
      if (argsStr) {
        try {
          args = JSON.parse(argsStr) as Record<string, unknown>;
        } catch {
          return { success: false, content: 'Error: arguments must be valid JSON' };
        }
      }

      try {
        const result = await mcpClient.callTool(serverId, toolName, args);

        const text = result.content
          .map((c) => c.text ?? JSON.stringify(c))
          .join('\n');

        return {
          success: !result.isError,
          content: text,
          metadata: { serverId, toolName },
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return {
          success: false,
          content: `Error calling MCP tool "${toolName}" on "${serverId}": ${msg}`,
        };
      }
    },
  };
}
