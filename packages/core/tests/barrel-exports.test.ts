import { describe, it, expect } from 'vitest';
import * as core from '../src/index.js';

describe('Core barrel exports', () => {
  it('exports ModeEngine', () => {
    expect(core.ModeEngine).toBeDefined();
  });

  it('exports ToolRegistry', () => {
    expect(core.ToolRegistry).toBeDefined();
  });

  it('exports tool factories', () => {
    expect(core.createReadFileTool).toBeTypeOf('function');
    expect(core.createListFilesTool).toBeTypeOf('function');
    expect(core.createSearchFilesTool).toBeTypeOf('function');
    expect(core.createWriteFileTool).toBeTypeOf('function');
    expect(core.createMultiEditTool).toBeTypeOf('function');
    expect(core.createExecuteCommandTool).toBeTypeOf('function');
    expect(core.createManageTodoTool).toBeTypeOf('function');
    expect(core.createUndoLastTurnTool).toBeTypeOf('function');
    expect(core.createSemanticSearchTool).toBeTypeOf('function');
    expect(core.createInsertContentTool).toBeTypeOf('function');
    expect(core.createUseMcpTool).toBeTypeOf('function');
  });

  it('exports AgentLoop', () => {
    expect(core.AgentLoop).toBeDefined();
  });

  it('exports ConversationManager', () => {
    expect(core.ConversationManager).toBeDefined();
  });

  it('exports ConfigLoader', () => {
    expect(core.ConfigLoader).toBeDefined();
  });

  it('exports MCPClient', () => {
    expect(core.MCPClient).toBeDefined();
  });

  it('exports FindingsScanner', () => {
    expect(core.FindingsScanner).toBeDefined();
  });

  it('exports MentionParser', () => {
    expect(core.MentionParser).toBeDefined();
  });

  it('exports ModelRouter', () => {
    expect(core.ModelRouter).toBeDefined();
  });

  it('exports OllamaAdapter', () => {
    expect(core.OllamaAdapter).toBeDefined();
  });

  it('exports OpenAICompatibleAdapter', () => {
    expect(core.OpenAICompatibleAdapter).toBeDefined();
  });

  it('exports LiterateCodingEngine', () => {
    expect(core.LiterateCodingEngine).toBeDefined();
  });

  it('exports SnapshotManager', () => {
    expect(core.SnapshotManager).toBeDefined();
  });

  it('exports FileFilter', () => {
    expect(core.FileFilter).toBeDefined();
  });

  it('exports RedactionEngine', () => {
    expect(core.RedactionEngine).toBeDefined();
  });

  it('exports SkillsLoader', () => {
    expect(core.SkillsLoader).toBeDefined();
  });
});
