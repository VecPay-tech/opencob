export type ToolGroup = 'read' | 'edit' | 'command' | 'mcp' | 'browser';

export interface ToolParameter {
  name: string;
  type: 'string' | 'number' | 'boolean';
  description: string;
  required: boolean;
}

export interface Tool {
  name: string;
  group: ToolGroup;
  description: string;
  parameters: ToolParameter[];
  execute(params: Record<string, unknown>): Promise<ToolResult>;
}

export interface ToolResult {
  success: boolean;
  content: string;
  metadata?: Record<string, unknown>;
}
