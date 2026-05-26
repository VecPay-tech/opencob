import { describe, it, expect, vi } from 'vitest';
import { ToolRegistry } from '../src/tools/tool-registry.js';
import { ModeEngine } from '../src/modes/mode-engine.js';
import type { Tool, ToolResult } from '../src/tools/types.js';

function makeTool(name: string, group: string = 'read'): Tool {
  return {
    name,
    group: group as any,
    description: `Test tool: ${name}`,
    parameters: [{ name: 'path', type: 'string', description: 'path', required: false }],
    execute: vi.fn().mockResolvedValue({ success: true, content: `${name} executed` }),
  };
}

describe('ToolRegistry — execution paths', () => {
  it('executes a tool successfully', async () => {
    const modeEngine = new ModeEngine();
    modeEngine.setActive('code'); // code mode allows read, edit, command
    const registry = new ToolRegistry(modeEngine, {
      autoApprove: { read: true, edit: true, command: true, mcp: true, browser: true },
    });
    const tool = makeTool('read_file', 'read');
    registry.register(tool);

    const result = await registry.execute({ toolName: 'read_file', parameters: { path: 'x.ts' } });
    expect(result.success).toBe(true);
    expect(result.approved).toBe(true);
    expect(result.toolName).toBe('read_file');
  });

  it('rejects unknown tools', async () => {
    const modeEngine = new ModeEngine();
    const registry = new ToolRegistry(modeEngine);
    const result = await registry.execute({ toolName: 'nonexistent', parameters: {} });
    expect(result.success).toBe(false);
    expect(result.blockedReason).toBe('unknown_tool');
  });

  it('blocks tools not allowed in current mode', async () => {
    const modeEngine = new ModeEngine();
    modeEngine.setActive('ask'); // ask mode only allows 'read' and 'mcp'
    const registry = new ToolRegistry(modeEngine, {
      autoApprove: { read: true, edit: true, command: true, mcp: true, browser: true },
    });
    registry.register(makeTool('write_file', 'edit'));

    const result = await registry.execute({ toolName: 'write_file', parameters: {} });
    expect(result.success).toBe(false);
    expect(result.blockedReason).toBe('mode_restriction');
  });

  it('enforces file edit restrictions in plan mode', async () => {
    const modeEngine = new ModeEngine();
    modeEngine.setActive('plan'); // plan mode: edit only \.md$ files
    const registry = new ToolRegistry(modeEngine, {
      autoApprove: { read: true, edit: true, command: true, mcp: true, browser: true },
    });
    registry.register(makeTool('write_file', 'edit'));

    const result = await registry.execute({
      toolName: 'write_file',
      parameters: { path: 'src/index.ts' },
    });
    expect(result.success).toBe(false);
    expect(result.blockedReason).toBe('file_restriction');

    // .md file should pass
    const result2 = await registry.execute({
      toolName: 'write_file',
      parameters: { path: 'README.md' },
    });
    expect(result2.success).toBe(true);
  });

  it('blocks files excluded by file filter', async () => {
    const modeEngine = new ModeEngine();
    modeEngine.setActive('code');
    const registry = new ToolRegistry(modeEngine, {
      autoApprove: { read: true, edit: true, command: true, mcp: true, browser: true },
      fileFilter: (p: string) => !p.includes('.env'),
    });
    registry.register(makeTool('read_file', 'read'));

    const result = await registry.execute({
      toolName: 'read_file',
      parameters: { path: '.env.local' },
    });
    expect(result.success).toBe(false);
    expect(result.blockedReason).toBe('ignored_file');
  });

  it('requires approval when not auto-approved', async () => {
    const modeEngine = new ModeEngine();
    modeEngine.setActive('code');
    const approvalCallback = vi.fn().mockResolvedValue(true);
    const registry = new ToolRegistry(modeEngine, {
      autoApprove: { read: true, edit: false, command: false, mcp: false, browser: false },
      approvalCallback,
    });
    registry.register(makeTool('write_file', 'edit'));

    const result = await registry.execute({ toolName: 'write_file', parameters: { path: 'a.ts' } });
    expect(result.success).toBe(true);
    expect(approvalCallback).toHaveBeenCalled();
  });

  it('blocks when user rejects approval', async () => {
    const modeEngine = new ModeEngine();
    modeEngine.setActive('code');
    const registry = new ToolRegistry(modeEngine, {
      autoApprove: { read: true, edit: false, command: false, mcp: false, browser: false },
      approvalCallback: vi.fn().mockResolvedValue(false),
    });
    registry.register(makeTool('write_file', 'edit'));

    const result = await registry.execute({ toolName: 'write_file', parameters: { path: 'a.ts' } });
    expect(result.success).toBe(false);
    expect(result.blockedReason).toBe('user_rejected');
  });

  it('blocks when approval required but no callback configured', async () => {
    const modeEngine = new ModeEngine();
    modeEngine.setActive('code');
    const registry = new ToolRegistry(modeEngine, {
      autoApprove: { read: true, edit: false, command: false, mcp: false, browser: false },
    });
    registry.register(makeTool('write_file', 'edit'));

    const result = await registry.execute({ toolName: 'write_file', parameters: { path: 'x' } });
    expect(result.success).toBe(false);
    expect(result.blockedReason).toBe('approval_unavailable');
  });

  it('handles tool execution errors', async () => {
    const modeEngine = new ModeEngine();
    modeEngine.setActive('code');
    const registry = new ToolRegistry(modeEngine, {
      autoApprove: { read: true, edit: true, command: true, mcp: true, browser: true },
    });
    const failingTool: Tool = {
      ...makeTool('bad_tool', 'read'),
      execute: vi.fn().mockRejectedValue(new Error('Tool crashed')),
    };
    registry.register(failingTool);

    const result = await registry.execute({ toolName: 'bad_tool', parameters: {} });
    expect(result.success).toBe(false);
    expect(result.content).toContain('Tool crashed');
  });

  it('validates commands with two-stage approval', async () => {
    const modeEngine = new ModeEngine();
    modeEngine.setActive('code');
    const approvalCallback = vi.fn().mockResolvedValue(true);
    const registry = new ToolRegistry(modeEngine, {
      autoApprove: { read: true, edit: false, command: false, mcp: false, browser: false },
      approvalCallback,
      enableCommandValidation: true,
      commandAllowlist: [{ pattern: '^npm test$' }],
    });
    registry.register(makeTool('execute_command', 'command'));

    // Command not in allowlist → gets risk warning
    const result = await registry.execute({
      toolName: 'execute_command',
      parameters: { command: 'rm -rf /' },
    });
    expect(result.success).toBe(true); // approved by callback
    expect(approvalCallback).toHaveBeenCalled();
    // The params passed to callback should include _riskWarning
    const callParams = approvalCallback.mock.calls[0][1];
    expect(callParams._riskWarning).toBeDefined();
  });

  it('validates dangerous command operators', () => {
    const modeEngine = new ModeEngine();
    const registry = new ToolRegistry(modeEngine);
    expect(registry.validateCommand('rm -rf /')).toContain('dangerous');
    expect(registry.validateCommand('echo hello && echo world')).toContain('chaining');
    expect(registry.validateCommand('$(whoami)')).toContain('subshell');
    expect(registry.validateCommand('> /etc/passwd')).toContain('system directory');
    expect(registry.validateCommand('echo hello')).toBeNull();
  });

  it('assesses command risk levels', () => {
    const modeEngine = new ModeEngine();
    const registry = new ToolRegistry(modeEngine);
    expect(registry.assessCommandRisk('rm -rf /').level).toBe('high');
    expect(registry.assessCommandRisk('sudo apt install vim').level).toBe('high');
    expect(registry.assessCommandRisk('git push --force').level).toBe('high');
    expect(registry.assessCommandRisk('ls -la').level).toBe('low');
    expect(registry.assessCommandRisk('cat file.txt').level).toBe('low');
    expect(registry.assessCommandRisk('git status').level).toBe('low');
    expect(registry.assessCommandRisk('npm install something').level).toBe('medium');
  });

  it('lists available tools filtered by mode', () => {
    const modeEngine = new ModeEngine();
    modeEngine.setActive('ask'); // read + mcp only
    const registry = new ToolRegistry(modeEngine);
    registry.register(makeTool('read_file', 'read'));
    registry.register(makeTool('write_file', 'edit'));

    const available = registry.listAvailable();
    expect(available.map((t) => t.name)).toContain('read_file');
    expect(available.map((t) => t.name)).not.toContain('write_file');
  });

  it('lists all tools regardless of mode', () => {
    const modeEngine = new ModeEngine();
    modeEngine.setActive('ask');
    const registry = new ToolRegistry(modeEngine);
    registry.register(makeTool('read_file', 'read'));
    registry.register(makeTool('write_file', 'edit'));

    const all = registry.listAll();
    expect(all.length).toBe(2);
  });

  it('gets tool definitions for LLM', () => {
    const modeEngine = new ModeEngine();
    modeEngine.setActive('code');
    const registry = new ToolRegistry(modeEngine);
    registry.register(makeTool('read_file', 'read'));

    const defs = registry.getToolDefinitions();
    expect(defs.length).toBe(1);
    expect(defs[0].name).toBe('read_file');
    expect(defs[0].parameters).toBeDefined();
  });

  it('registerAll adds multiple tools', () => {
    const modeEngine = new ModeEngine();
    const registry = new ToolRegistry(modeEngine);
    registry.registerAll([makeTool('a', 'read'), makeTool('b', 'read')]);
    expect(registry.listAll().length).toBe(2);
  });

  it('setAutoApprove updates config', async () => {
    const modeEngine = new ModeEngine();
    modeEngine.setActive('code');
    const registry = new ToolRegistry(modeEngine);
    registry.register(makeTool('write_file', 'edit'));

    // Initially needs approval → no callback → blocked
    let result = await registry.execute({ toolName: 'write_file', parameters: {} });
    expect(result.blockedReason).toBe('approval_unavailable');

    // Enable auto-approve for edit
    registry.setAutoApprove({ edit: true });
    result = await registry.execute({ toolName: 'write_file', parameters: {} });
    expect(result.success).toBe(true);
  });

  it('setApprovalCallback updates callback', async () => {
    const modeEngine = new ModeEngine();
    modeEngine.setActive('code');
    const registry = new ToolRegistry(modeEngine);
    registry.register(makeTool('write_file', 'edit'));
    registry.setApprovalCallback(async () => true);

    const result = await registry.execute({ toolName: 'write_file', parameters: {} });
    expect(result.success).toBe(true);
  });
});
