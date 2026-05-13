import { describe, it, expect, beforeEach } from 'vitest';
import { ToolRegistry } from '../src/tools/tool-registry.js';
import { ModeEngine } from '../src/modes/mode-engine.js';
import type { Tool, ToolResult } from '../src/tools/types.js';

function makeTool(name: string, group: 'read' | 'edit' | 'command'): Tool {
  return {
    name,
    group,
    description: `Test tool: ${name}`,
    parameters: [],
    async execute(): Promise<ToolResult> {
      return { success: true, content: `${name} executed` };
    },
  };
}

describe('ToolRegistry', () => {
  let modeEngine: ModeEngine;
  let registry: ToolRegistry;

  beforeEach(() => {
    modeEngine = new ModeEngine();
    registry = new ToolRegistry(modeEngine, { autoApprove: { read: true, edit: true, command: true } });
    registry.registerAll([
      makeTool('read_file', 'read'),
      makeTool('write_to_file', 'edit'),
      makeTool('execute_command', 'command'),
    ]);
  });

  it('lists all registered tools', () => {
    expect(registry.listAll()).toHaveLength(3);
  });

  it('lists available tools based on mode', () => {
    // Code mode: read, edit, command
    modeEngine.setActive('code');
    expect(registry.listAvailable()).toHaveLength(3);

    // Ask mode: read only (no edit, no command)
    modeEngine.setActive('ask');
    const available = registry.listAvailable();
    expect(available).toHaveLength(1);
    expect(available[0].name).toBe('read_file');
  });

  it('executes a tool successfully', async () => {
    const result = await registry.execute({ toolName: 'read_file', parameters: {} });
    expect(result.success).toBe(true);
    expect(result.approved).toBe(true);
    expect(result.content).toBe('read_file executed');
  });

  it('blocks unknown tools', async () => {
    const result = await registry.execute({ toolName: 'unknown', parameters: {} });
    expect(result.success).toBe(false);
    expect(result.blockedReason).toBe('unknown_tool');
  });

  it('blocks tools not allowed in current mode', async () => {
    modeEngine.setActive('ask');
    const result = await registry.execute({ toolName: 'write_to_file', parameters: {} });
    expect(result.success).toBe(false);
    expect(result.blockedReason).toBe('mode_restriction');
  });

  it('enforces file edit restrictions', async () => {
    modeEngine.setActive('plan');
    const result = await registry.execute({
      toolName: 'write_to_file',
      parameters: { path: 'src/main.ts' },
    });
    expect(result.success).toBe(false);
    expect(result.blockedReason).toBe('file_restriction');
  });

  it('allows markdown edits in plan mode', async () => {
    modeEngine.setActive('plan');
    const result = await registry.execute({
      toolName: 'write_to_file',
      parameters: { path: 'notes.md' },
    });
    expect(result.success).toBe(true);
  });

  it('respects approval callback', async () => {
    const rejectingRegistry = new ToolRegistry(modeEngine, {
      autoApprove: { read: false, edit: false, command: false },
      approvalCallback: async () => false,
    });
    rejectingRegistry.register(makeTool('read_file', 'read'));

    const result = await rejectingRegistry.execute({ toolName: 'read_file', parameters: {} });
    expect(result.success).toBe(false);
    expect(result.blockedReason).toBe('user_rejected');
  });

  it('generates tool definitions for LLM', () => {
    const defs = registry.getToolDefinitions();
    expect(defs).toHaveLength(3);
    expect(defs[0]).toHaveProperty('name');
    expect(defs[0]).toHaveProperty('description');
    expect(defs[0]).toHaveProperty('parameters');
  });
});
