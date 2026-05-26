import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { createManageTodoTool } from '../src/tools/manage-todo.js';
import { createMultiEditTool } from '../src/tools/multi-edit.js';
import { createSemanticSearchTool } from '../src/tools/semantic-search.js';
import { createUndoLastTurnTool } from '../src/tools/undo-last-turn.js';
import { createExecuteCommandTool } from '../src/tools/execute-command.js';
import { createInsertContentTool } from '../src/tools/insert-content.js';
import { SnapshotManager } from '../src/checkpoints/snapshot-manager.js';
import { RAGPipeline, VectorStore } from '../src/indexer/rag-pipeline.js';
import type { CodeChunk } from '../src/indexer/workspace-indexer.js';

// ─── manage_todo ─────────────────────────────────────────────────────────

describe('manage_todo tool', () => {
  it('adds a todo item', async () => {
    const tool = createManageTodoTool();
    const result = await tool.execute({ action: 'add', title: 'Write tests' });
    expect(result.success).toBe(true);
    expect(result.content).toContain('#1');
    expect(result.content).toContain('Write tests');
  });

  it('lists todo items', async () => {
    const tool = createManageTodoTool();
    await tool.execute({ action: 'add', title: 'Task A' });
    await tool.execute({ action: 'add', title: 'Task B' });
    const result = await tool.execute({ action: 'list' });
    expect(result.success).toBe(true);
    expect(result.content).toContain('Task A');
    expect(result.content).toContain('Task B');
    expect(result.content).toContain('not-started');
  });

  it('updates a todo status', async () => {
    const tool = createManageTodoTool();
    await tool.execute({ action: 'add', title: 'Do thing' });
    const result = await tool.execute({ action: 'update', id: 1, status: 'completed' });
    expect(result.success).toBe(true);
    expect(result.content).toContain('completed');
  });

  it('returns empty list message', async () => {
    const tool = createManageTodoTool();
    const result = await tool.execute({ action: 'list' });
    expect(result.success).toBe(true);
    expect(result.content).toContain('No todo items');
  });

  it('rejects add without title', async () => {
    const tool = createManageTodoTool();
    const result = await tool.execute({ action: 'add' });
    expect(result.success).toBe(false);
    expect(result.content).toContain('title');
  });

  it('rejects update without id', async () => {
    const tool = createManageTodoTool();
    const result = await tool.execute({ action: 'update', status: 'completed' });
    expect(result.success).toBe(false);
  });

  it('rejects update without status', async () => {
    const tool = createManageTodoTool();
    await tool.execute({ action: 'add', title: 'X' });
    const result = await tool.execute({ action: 'update', id: 1 });
    expect(result.success).toBe(false);
  });

  it('rejects update for non-existent id', async () => {
    const tool = createManageTodoTool();
    const result = await tool.execute({ action: 'update', id: 99, status: 'completed' });
    expect(result.success).toBe(false);
    expect(result.content).toContain('not found');
  });

  it('rejects unknown action', async () => {
    const tool = createManageTodoTool();
    const result = await tool.execute({ action: 'delete' });
    expect(result.success).toBe(false);
    expect(result.content).toContain('Unknown action');
  });
});

// ─── undo_last_turn ──────────────────────────────────────────────────────

describe('undo_last_turn tool', () => {
  let tmpDir: string;
  let snapshotManager: SnapshotManager;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'undo-test-'));
    snapshotManager = new SnapshotManager(tmpDir);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns error when no snapshots available', async () => {
    const tool = createUndoLastTurnTool(snapshotManager);
    const result = await tool.execute({});
    expect(result.success).toBe(false);
    expect(result.content).toContain('No snapshots');
  });

  it('undoes a turn with file modifications', async () => {
    // Create a file, start turn, snapshot, modify, then undo
    const filePath = 'test.txt';
    const fullPath = path.join(tmpDir, filePath);
    fs.writeFileSync(fullPath, 'original', 'utf-8');

    snapshotManager.startTurn();
    snapshotManager.captureFile(filePath);
    fs.writeFileSync(fullPath, 'modified', 'utf-8');

    const tool = createUndoLastTurnTool(snapshotManager);
    const result = await tool.execute({});
    expect(result.success).toBe(true);
    expect(result.content).toContain('Undid turn');
    expect(result.content).toContain('restored');
    expect(fs.readFileSync(fullPath, 'utf-8')).toBe('original');
  });

  it('handles turn with no file modifications', async () => {
    snapshotManager.startTurn();
    const tool = createUndoLastTurnTool(snapshotManager);
    const result = await tool.execute({});
    expect(result.success).toBe(true);
    expect(result.content).toContain('no file modifications');
  });
});

// ─── semantic_search ─────────────────────────────────────────────────────

describe('semantic_search tool', () => {
  it('returns results from RAG pipeline', async () => {
    const ragPipeline = new RAGPipeline();
    const chunks: CodeChunk[] = [
      {
        id: 'c1',
        filePath: 'src/auth.ts',
        startLine: 1,
        endLine: 10,
        content: 'function authenticate(user, pass) { return checkDb(user, pass); }',
        language: 'typescript',
      },
      {
        id: 'c2',
        filePath: 'src/db.ts',
        startLine: 1,
        endLine: 5,
        content: 'function connectDatabase(host, port) { return new Pool(); }',
        language: 'typescript',
      },
    ];
    ragPipeline.indexChunks(chunks);

    const tool = createSemanticSearchTool(ragPipeline);
    const result = await tool.execute({ query: 'authenticate user password' });
    expect(result.success).toBe(true);
    expect(result.content).toContain('auth.ts');
  });

  it('returns empty message when no results', async () => {
    const ragPipeline = new RAGPipeline();
    const tool = createSemanticSearchTool(ragPipeline);
    const result = await tool.execute({ query: 'nonexistent concept' });
    expect(result.success).toBe(true);
    expect(result.content).toContain('No relevant code found');
  });

  it('requires query parameter', async () => {
    const ragPipeline = new RAGPipeline();
    const tool = createSemanticSearchTool(ragPipeline);
    const result = await tool.execute({});
    expect(result.success).toBe(false);
    expect(result.content).toContain('query');
  });

  it('respects topK parameter', async () => {
    const ragPipeline = new RAGPipeline();
    const chunks: CodeChunk[] = Array.from({ length: 20 }, (_, i) => ({
      id: `c${i}`,
      filePath: `src/file${i}.ts`,
      startLine: 1,
      endLine: 5,
      content: `function handler${i}(request) { return response${i}; }`,
      language: 'typescript',
    }));
    ragPipeline.indexChunks(chunks);

    const tool = createSemanticSearchTool(ragPipeline);
    const result = await tool.execute({ query: 'function handler request response', topK: 3 });
    expect(result.success).toBe(true);
    // Count results
    const resultCount = (result.content.match(/### Result/g) || []).length;
    expect(resultCount).toBeLessThanOrEqual(3);
  });
});

// ─── multi_edit ──────────────────────────────────────────────────────────

describe('multi_edit tool', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'multi-edit-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('edits multiple files atomically', async () => {
    const tool = createMultiEditTool(tmpDir);
    const edits = JSON.stringify([
      { filePath: 'a.txt', content: 'file A' },
      { filePath: 'b.txt', content: 'file B' },
    ]);
    const result = await tool.execute({ edits });
    expect(result.success).toBe(true);
    expect(result.content).toContain('2 file(s)');
    expect(fs.readFileSync(path.join(tmpDir, 'a.txt'), 'utf-8')).toBe('file A');
    expect(fs.readFileSync(path.join(tmpDir, 'b.txt'), 'utf-8')).toBe('file B');
  });

  it('creates directories as needed', async () => {
    const tool = createMultiEditTool(tmpDir);
    const edits = JSON.stringify([{ filePath: 'sub/dir/file.ts', content: 'export {}' }]);
    const result = await tool.execute({ edits });
    expect(result.success).toBe(true);
    expect(fs.existsSync(path.join(tmpDir, 'sub/dir/file.ts'))).toBe(true);
  });

  it('rejects invalid JSON', async () => {
    const tool = createMultiEditTool(tmpDir);
    const result = await tool.execute({ edits: 'not json' });
    expect(result.success).toBe(false);
    expect(result.content).toContain('Invalid edits');
  });

  it('rejects empty array', async () => {
    const tool = createMultiEditTool(tmpDir);
    const result = await tool.execute({ edits: '[]' });
    expect(result.success).toBe(false);
    expect(result.content).toContain('non-empty');
  });

  it('rejects entries without filePath', async () => {
    const tool = createMultiEditTool(tmpDir);
    const edits = JSON.stringify([{ content: 'hello' }]);
    const result = await tool.execute({ edits });
    expect(result.success).toBe(false);
    expect(result.content).toContain('filePath');
  });

  it('uses snapshot manager when provided', async () => {
    const snapshotManager = new SnapshotManager(tmpDir);
    snapshotManager.startTurn();
    fs.writeFileSync(path.join(tmpDir, 'existing.ts'), 'old content');

    const tool = createMultiEditTool(tmpDir, snapshotManager);
    const edits = JSON.stringify([{ filePath: 'existing.ts', content: 'new content' }]);
    const result = await tool.execute({ edits });
    expect(result.success).toBe(true);
    expect(fs.readFileSync(path.join(tmpDir, 'existing.ts'), 'utf-8')).toBe('new content');
  });
});

// ─── execute_command ─────────────────────────────────────────────────────

describe('execute_command tool', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'exec-cmd-'));
  });

  afterEach(() => {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    } catch {
      /* orphan process may hold cwd */
    }
  });

  it('executes a simple command', async () => {
    const tool = createExecuteCommandTool(tmpDir);
    const result = await tool.execute({ command: 'echo hello' });
    expect(result.success).toBe(true);
    expect(result.content).toContain('hello');
  });

  it('captures exit code for failing commands', async () => {
    const tool = createExecuteCommandTool(tmpDir);
    const result = await tool.execute({ command: 'false' });
    expect(result.success).toBe(false);
  });

  it('requires command parameter', async () => {
    const tool = createExecuteCommandTool(tmpDir);
    const result = await tool.execute({});
    expect(result.success).toBe(false);
    expect(result.content).toContain('command');
  });

  it('captures stderr', async () => {
    const tool = createExecuteCommandTool(tmpDir);
    const result = await tool.execute({ command: 'echo error >&2' });
    expect(result.content).toContain('error');
  });

  it('times out long-running commands', async () => {
    const tool = createExecuteCommandTool(tmpDir);
    const cmd = process.platform === 'win32' ? 'ping -n 100 127.0.0.1' : 'sleep 10';
    const result = await tool.execute({ command: cmd, timeout: 200 });
    expect(result.content).toContain('timed out');
  }, 10000);

  it('runs in workspace directory', async () => {
    const tool = createExecuteCommandTool(tmpDir);
    const cmd = process.platform === 'win32' ? 'cd' : 'pwd';
    const result = await tool.execute({ command: cmd });
    expect(result.success).toBe(true);
    expect(result.content).toContain(tmpDir);
  });
});

// ─── insert_content ──────────────────────────────────────────────────────

describe('insert_content tool', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'insert-'));
    fs.writeFileSync(path.join(tmpDir, 'target.ts'), 'line1\nline2\nline3\n');
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('inserts content at specified position', async () => {
    const tool = createInsertContentTool(tmpDir);
    const result = await tool.execute({ path: 'target.ts', position: 1, content: 'inserted' });
    expect(result.success).toBe(true);
    const content = fs.readFileSync(path.join(tmpDir, 'target.ts'), 'utf-8');
    expect(content).toContain('inserted');
    const lines = content.split('\n');
    expect(lines[1]).toBe('inserted');
  });

  it('inserts at beginning with position 0', async () => {
    const tool = createInsertContentTool(tmpDir);
    const result = await tool.execute({ path: 'target.ts', position: 0, content: 'first' });
    expect(result.success).toBe(true);
    const content = fs.readFileSync(path.join(tmpDir, 'target.ts'), 'utf-8');
    expect(content.startsWith('first')).toBe(true);
  });

  it('requires all parameters', async () => {
    const tool = createInsertContentTool(tmpDir);
    expect((await tool.execute({})).success).toBe(false);
    expect((await tool.execute({ path: 'x' })).success).toBe(false);
    expect((await tool.execute({ path: 'x', position: 0 })).success).toBe(false);
  });

  it('rejects path traversal', async () => {
    const tool = createInsertContentTool(tmpDir);
    const result = await tool.execute({ path: '../../etc/passwd', position: 0, content: 'x' });
    expect(result.success).toBe(false);
  });

  it('rejects non-existent file', async () => {
    const tool = createInsertContentTool(tmpDir);
    const result = await tool.execute({ path: 'nope.ts', position: 0, content: 'x' });
    expect(result.success).toBe(false);
  });
});
