import { spawn, type ChildProcess } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

export interface MCPServerConfig {
  id: string;
  name: string;
  transport: 'stdio' | 'sse';
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
}

export interface MCPTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  serverId: string;
}

export interface MCPToolResult {
  content: Array<{ type: string; text?: string }>;
  isError?: boolean;
}

interface JsonRpcRequest {
  jsonrpc: '2.0';
  id: number;
  method: string;
  params?: Record<string, unknown>;
}

interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: number;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

/**
 * MCP (Model Context Protocol) Client implementing stdio transport.
 * Manages server lifecycle, tool discovery, and tool invocation.
 */
export class MCPClient {
  private servers: Map<string, MCPServerConfig> = new Map();
  private processes: Map<string, ChildProcess> = new Map();
  private tools: Map<string, MCPTool> = new Map();
  private requestId: number = 0;
  private pendingRequests: Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }> = new Map();
  private buffers: Map<string, string> = new Map();
  // SSE transport state
  private sseEndpoints: Map<string, string> = new Map(); // serverId → POST endpoint URL
  private sseAbortControllers: Map<string, AbortController> = new Map();

  /** Load MCP server configurations from .OpenCob/mcp_servers.json */
  async loadConfig(workspaceRoot: string): Promise<MCPServerConfig[]> {
    const candidatePaths = [
      path.join(workspaceRoot, '.OpenCob', 'mcp_servers.json'),
      path.join(workspaceRoot, '.opencob', 'mcp_servers.json'),
    ];
    const configPath = candidatePaths.find((p) => fs.existsSync(p));
    if (!configPath) return [];

    const raw = fs.readFileSync(configPath, 'utf-8');
    const config = JSON.parse(raw) as { mcpServers?: Record<string, Omit<MCPServerConfig, 'id'>> };

    const servers: MCPServerConfig[] = [];
    if (config.mcpServers) {
      for (const [id, serverConfig] of Object.entries(config.mcpServers)) {
        const resolved = this.resolveEnvVars(serverConfig);
        servers.push({ id, ...resolved } as MCPServerConfig);
      }
    }
    return servers;
  }

  /** Connect to an MCP server via stdio or SSE transport */
  async connect(config: MCPServerConfig): Promise<void> {
    if (config.transport === 'sse') {
      return this.connectSse(config);
    }

    if (config.transport !== 'stdio') {
      throw new Error(`Transport "${config.transport}" not supported. Use "stdio" or "sse".`);
    }

    if (!config.command) {
      throw new Error(`MCP server "${config.id}" requires a "command" for stdio transport.`);
    }

    this.servers.set(config.id, config);

    const env = { ...process.env, ...config.env };
    const child = spawn(config.command, config.args ?? [], {
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    this.processes.set(config.id, child);
    this.buffers.set(config.id, '');

    // Handle stdout — JSON-RPC responses
    child.stdout?.on('data', (data: Buffer) => {
      const buffer = (this.buffers.get(config.id) ?? '') + data.toString();
      this.buffers.set(config.id, buffer);
      this.processBuffer(config.id);
    });

    child.stderr?.on('data', (data: Buffer) => {
      // Log stderr for debugging
      const msg = data.toString().trim();
      if (msg) {
        console.error(`[MCP:${config.id}] ${msg}`);
      }
    });

    child.on('exit', (code) => {
      this.processes.delete(config.id);
      this.buffers.delete(config.id);
      console.error(`[MCP:${config.id}] Process exited with code ${code}`);
    });

    // Initialize the MCP protocol
    await this.sendRequest(config.id, 'initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'OpenCob', version: '0.1.0' },
    });

    // Send initialized notification
    this.sendNotification(config.id, 'notifications/initialized', {});

    // Discover tools
    await this.discoverTools(config.id);
  }

  /**
   * Connect to an MCP server via SSE (Server-Sent Events) transport.
   * The server exposes an SSE endpoint for receiving responses and a
   * POST endpoint for sending requests.
   */
  private async connectSse(config: MCPServerConfig): Promise<void> {
    if (!config.url) {
      throw new Error(`MCP server "${config.id}" requires a "url" for SSE transport.`);
    }

    this.servers.set(config.id, config);

    const sseUrl = config.url.endsWith('/sse') ? config.url : `${config.url}/sse`;
    const headers: Record<string, string> = { ...config.headers };
    const abortController = new AbortController();
    this.sseAbortControllers.set(config.id, abortController);

    // Connect to SSE endpoint to receive server messages
    const response = await fetch(sseUrl, {
      headers,
      signal: abortController.signal,
    });

    if (!response.ok) {
      throw new Error(`SSE connection to "${config.id}" failed: ${response.status} ${response.statusText}`);
    }

    if (!response.body) {
      throw new Error(`SSE connection to "${config.id}" returned no body`);
    }

    // Read the SSE stream to find the POST endpoint
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let sseBuffer = '';
    let postEndpoint: string | null = null;

    // Read initial messages to discover the POST endpoint
    const readInitial = async (): Promise<void> => {
      const timeout = setTimeout(() => {
        throw new Error(`SSE endpoint discovery timed out for "${config.id}"`);
      }, 10_000);

      while (!postEndpoint) {
        const { done, value } = await reader.read();
        if (done) break;

        sseBuffer += decoder.decode(value, { stream: true });
        const lines = sseBuffer.split('\n');
        sseBuffer = lines.pop() ?? '';

        for (const line of lines) {
          if (line.startsWith('event: endpoint')) {
            // Next data line contains the POST URL
          } else if (line.startsWith('data: ') && !postEndpoint) {
            const data = line.slice(6).trim();
            // Check if it's a URL (endpoint message) or JSON-RPC response
            if (data.startsWith('/') || data.startsWith('http')) {
              const baseUrl = new URL(config.url!);
              postEndpoint = data.startsWith('http') ? data : `${baseUrl.origin}${data}`;
            } else {
              // Try parsing as JSON-RPC
              try {
                const parsed = JSON.parse(data) as JsonRpcResponse;
                if (parsed.id !== undefined) {
                  const pending = this.pendingRequests.get(parsed.id);
                  if (pending) {
                    this.pendingRequests.delete(parsed.id);
                    if (parsed.error) {
                      pending.reject(new Error(`MCP error: ${parsed.error.message}`));
                    } else {
                      pending.resolve(parsed.result);
                    }
                  }
                }
              } catch {
                // Not JSON, might be the endpoint path
                if (data.match(/^[\w/.-]+$/)) {
                  const baseUrl = new URL(config.url!);
                  postEndpoint = `${baseUrl.origin}${data}`;
                }
              }
            }
          }
        }
      }

      clearTimeout(timeout);
    };

    await readInitial();

    if (!postEndpoint) {
      throw new Error(`Failed to discover POST endpoint for SSE server "${config.id}"`);
    }

    this.sseEndpoints.set(config.id, postEndpoint);

    // Continue reading SSE stream in the background for responses
    this.readSseStream(config.id, reader, decoder, sseBuffer);

    // Initialize MCP protocol over SSE
    await this.sendRequest(config.id, 'initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'OpenCob', version: '0.1.0' },
    });

    this.sendNotification(config.id, 'notifications/initialized', {});
    await this.discoverTools(config.id);
  }

  /**
   * Background reader for SSE response stream.
   */
  private readSseStream(
    serverId: string,
    reader: ReadableStreamDefaultReader<Uint8Array>,
    decoder: TextDecoder,
    initialBuffer: string,
  ): void {
    let buffer = initialBuffer;

    const processStream = async (): Promise<void> => {
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split('\n');
          buffer = lines.pop() ?? '';

          for (const line of lines) {
            if (line.startsWith('data: ')) {
              const data = line.slice(6).trim();
              try {
                const parsed = JSON.parse(data) as JsonRpcResponse;
                if (parsed.id !== undefined) {
                  const pending = this.pendingRequests.get(parsed.id);
                  if (pending) {
                    this.pendingRequests.delete(parsed.id);
                    if (parsed.error) {
                      pending.reject(new Error(`MCP error: ${parsed.error.message}`));
                    } else {
                      pending.resolve(parsed.result);
                    }
                  }
                }
              } catch {
                // Non-JSON SSE data, skip
              }
            }
          }
        }
      } catch (err: unknown) {
        if (err instanceof Error && err.name === 'AbortError') return;
        console.error(`[MCP:${serverId}] SSE stream error:`, err);
      }
    };

    processStream().catch(() => {});
  }

  /** Discover tools from a connected MCP server */
  async discoverTools(serverId: string): Promise<MCPTool[]> {
    const response = await this.sendRequest(serverId, 'tools/list', {}) as {
      tools?: Array<{ name: string; description: string; inputSchema: Record<string, unknown> }>;
    };

    const serverTools: MCPTool[] = [];
    if (response?.tools) {
      for (const tool of response.tools) {
        const mcpTool: MCPTool = {
          name: tool.name,
          description: tool.description,
          inputSchema: tool.inputSchema,
          serverId,
        };
        this.tools.set(`${serverId}:${tool.name}`, mcpTool);
        serverTools.push(mcpTool);
      }
    }
    return serverTools;
  }

  /** Call a tool on an MCP server */
  async callTool(serverId: string, toolName: string, args: Record<string, unknown>): Promise<MCPToolResult> {
    const response = await this.sendRequest(serverId, 'tools/call', {
      name: toolName,
      arguments: args,
    }) as MCPToolResult;

    return response ?? { content: [{ type: 'text', text: 'No result' }] };
  }

  /** Get all discovered tools across all servers */
  listTools(): MCPTool[] {
    return Array.from(this.tools.values());
  }

  /** Get tools for a specific server */
  getServerTools(serverId: string): MCPTool[] {
    return Array.from(this.tools.values()).filter((t) => t.serverId === serverId);
  }

  /** Check if a server is connected */
  isConnected(serverId: string): boolean {
    return this.processes.has(serverId) || this.sseEndpoints.has(serverId);
  }

  /** List connected servers */
  listServers(): MCPServerConfig[] {
    return Array.from(this.servers.values());
  }

  /** Disconnect from an MCP server */
  disconnect(serverId: string): void {
    const proc = this.processes.get(serverId);
    if (proc) {
      proc.kill('SIGTERM');
      this.processes.delete(serverId);
    }

    // Clean up SSE transport
    const abortCtrl = this.sseAbortControllers.get(serverId);
    if (abortCtrl) {
      abortCtrl.abort();
      this.sseAbortControllers.delete(serverId);
    }
    this.sseEndpoints.delete(serverId);

    this.servers.delete(serverId);
    this.buffers.delete(serverId);

    // Remove tools for this server
    for (const [key, tool] of this.tools.entries()) {
      if (tool.serverId === serverId) {
        this.tools.delete(key);
      }
    }
  }

  /** Disconnect from all servers */
  disconnectAll(): void {
    for (const serverId of Array.from(this.servers.keys())) {
      this.disconnect(serverId);
    }
  }

  // --- Internal methods ---

  private async sendRequest(serverId: string, method: string, params: Record<string, unknown>): Promise<unknown> {
    const id = ++this.requestId;
    const request: JsonRpcRequest = {
      jsonrpc: '2.0',
      id,
      method,
      params,
    };

    // SSE transport — send via HTTP POST
    const sseEndpoint = this.sseEndpoints.get(serverId);
    if (sseEndpoint) {
      const config = this.servers.get(serverId);
      return new Promise((resolve, reject) => {
        this.pendingRequests.set(id, { resolve, reject });

        fetch(sseEndpoint, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...config?.headers,
          },
          body: JSON.stringify(request),
        }).catch((err: Error) => {
          this.pendingRequests.delete(id);
          reject(new Error(`Failed to POST to MCP server "${serverId}": ${err.message}`));
        });

        setTimeout(() => {
          if (this.pendingRequests.has(id)) {
            this.pendingRequests.delete(id);
            reject(new Error(`MCP request to "${serverId}" timed out (30s)`));
          }
        }, 30_000);
      });
    }

    // Stdio transport — write to stdin
    const proc = this.processes.get(serverId);
    if (!proc?.stdin) {
      throw new Error(`MCP server "${serverId}" is not connected.`);
    }

    return new Promise((resolve, reject) => {
      this.pendingRequests.set(id, { resolve, reject });

      const data = JSON.stringify(request) + '\n';
      proc.stdin!.write(data, (err) => {
        if (err) {
          this.pendingRequests.delete(id);
          reject(new Error(`Failed to write to MCP server "${serverId}": ${err.message}`));
        }
      });

      // Timeout after 30 seconds
      setTimeout(() => {
        if (this.pendingRequests.has(id)) {
          this.pendingRequests.delete(id);
          reject(new Error(`MCP request to "${serverId}" timed out (30s)`));
        }
      }, 30_000);
    });
  }

  private sendNotification(serverId: string, method: string, params: Record<string, unknown>): void {
    const notification = JSON.stringify({
      jsonrpc: '2.0',
      method,
      params,
    }) + '\n';

    // SSE transport — POST notification
    const sseEndpoint = this.sseEndpoints.get(serverId);
    if (sseEndpoint) {
      const config = this.servers.get(serverId);
      fetch(sseEndpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...config?.headers },
        body: notification.trim(),
      }).catch(() => {});
      return;
    }

    // Stdio transport
    const proc = this.processes.get(serverId);
    if (!proc?.stdin) return;
    proc.stdin.write(notification);
  }

  private processBuffer(serverId: string): void {
    const buffer = this.buffers.get(serverId) ?? '';
    const lines = buffer.split('\n');

    // Process complete lines
    for (let i = 0; i < lines.length - 1; i++) {
      const line = lines[i].trim();
      if (!line) continue;

      try {
        const response = JSON.parse(line) as JsonRpcResponse;
        if (response.id !== undefined) {
          const pending = this.pendingRequests.get(response.id);
          if (pending) {
            this.pendingRequests.delete(response.id);
            if (response.error) {
              pending.reject(new Error(`MCP error: ${response.error.message}`));
            } else {
              pending.resolve(response.result);
            }
          }
        }
      } catch {
        // Not valid JSON, skip
      }
    }

    // Keep the last incomplete line in the buffer
    this.buffers.set(serverId, lines[lines.length - 1]);
  }

  private resolveEnvVars(config: Record<string, unknown>): Record<string, unknown> {
    const resolved: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(config)) {
      if (typeof value === 'string') {
        resolved[key] = value.replace(/\$\{env:(\w+)\}/g, (_, varName) => {
          return process.env[varName] ?? '';
        });
      } else if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
        resolved[key] = this.resolveEnvVars(value as Record<string, unknown>);
      } else {
        resolved[key] = value;
      }
    }
    return resolved;
  }
}
