import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { writeFile, mkdir, rm, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createReadFileTool } from '../src/tools/read-file.js';
import { createListFilesTool } from '../src/tools/list-files.js';
import { createSearchFilesTool } from '../src/tools/search-files.js';
import { createWriteFileTool } from '../src/tools/write-file.js';
import { createApplyDiffTool } from '../src/tools/apply-diff.js';

let workspaceRoot: string;

beforeEach(async () => {
  workspaceRoot = join(tmpdir(), `OpenCob-test-${Date.now()}`);
  await mkdir(workspaceRoot, { recursive: true });
  await mkdir(join(workspaceRoot, 'src'), { recursive: true });
  await writeFile(join(workspaceRoot, 'hello.txt'), 'line 1\nline 2\nline 3\nline 4\nline 5\n');
  await writeFile(join(workspaceRoot, 'src', 'main.ts'), 'const x = 1;\nconst y = 2;\nexport { x, y };\n');
});

afterEach(async () => {
  await rm(workspaceRoot, { recursive: true, force: true });
});

describe('read_file', () => {
  it('reads full file with line numbers', async () => {
    const tool = createReadFileTool(workspaceRoot);
    const result = await tool.execute({ path: 'hello.txt' });
    expect(result.success).toBe(true);
    expect(result.content).toContain('1 | line 1');
    expect(result.content).toContain('5 | line 5');
  });

  it('reads a line range', async () => {
    const tool = createReadFileTool(workspaceRoot);
    const result = await tool.execute({ path: 'hello.txt', startLine: 2, endLine: 4 });
    expect(result.success).toBe(true);
    expect(result.content).toContain('2 | line 2');
    expect(result.content).toContain('4 | line 4');
    expect(result.content).not.toContain('1 | line 1');
  });

  it('fails for non-existent file', async () => {
    const tool = createReadFileTool(workspaceRoot);
    const result = await tool.execute({ path: 'nope.txt' });
    expect(result.success).toBe(false);
  });

  it('rejects path traversal', async () => {
    const tool = createReadFileTool(workspaceRoot);
    const result = await tool.execute({ path: '../../etc/passwd' });
    expect(result.success).toBe(false);
    expect(result.content).toContain('outside the workspace');
  });
});

describe('list_files', () => {
  it('lists top-level entries', async () => {
    const tool = createListFilesTool(workspaceRoot);
    const result = await tool.execute({});
    expect(result.success).toBe(true);
    expect(result.content).toContain('hello.txt');
    expect(result.content).toContain('src/');
  });

  it('lists subdirectory', async () => {
    const tool = createListFilesTool(workspaceRoot);
    const result = await tool.execute({ path: 'src' });
    expect(result.success).toBe(true);
    expect(result.content).toContain('main.ts');
  });

  it('lists recursively', async () => {
    const tool = createListFilesTool(workspaceRoot);
    const result = await tool.execute({ recursive: true });
    expect(result.success).toBe(true);
    expect(result.content).toContain('src/');
    expect(result.content).toMatch(/main\.ts/);
  });
});

describe('search_files', () => {
  it('finds matches by regex', async () => {
    const tool = createSearchFilesTool(workspaceRoot);
    const result = await tool.execute({ pattern: 'const' });
    expect(result.success).toBe(true);
    expect(result.content).toContain('main.ts');
    expect(result.content).toContain('const x');
  });

  it('returns no matches gracefully', async () => {
    const tool = createSearchFilesTool(workspaceRoot);
    const result = await tool.execute({ pattern: 'zzzznothere' });
    expect(result.success).toBe(true);
    expect(result.content).toBe('No matches found.');
  });

  it('rejects invalid regex', async () => {
    const tool = createSearchFilesTool(workspaceRoot);
    const result = await tool.execute({ pattern: '[invalid' });
    expect(result.success).toBe(false);
    expect(result.content).toContain('invalid regex');
  });
});

describe('write_to_file', () => {
  it('creates a new file', async () => {
    const tool = createWriteFileTool(workspaceRoot);
    const result = await tool.execute({ path: 'new.txt', content: 'hello world' });
    expect(result.success).toBe(true);
    const content = await readFile(join(workspaceRoot, 'new.txt'), 'utf-8');
    expect(content).toBe('hello world');
  });

  it('creates nested directories', async () => {
    const tool = createWriteFileTool(workspaceRoot);
    const result = await tool.execute({ path: 'deep/nested/file.txt', content: 'deep' });
    expect(result.success).toBe(true);
    const content = await readFile(join(workspaceRoot, 'deep', 'nested', 'file.txt'), 'utf-8');
    expect(content).toBe('deep');
  });

  it('overwrites existing file', async () => {
    const tool = createWriteFileTool(workspaceRoot);
    const result = await tool.execute({ path: 'hello.txt', content: 'overwritten' });
    expect(result.success).toBe(true);
    const content = await readFile(join(workspaceRoot, 'hello.txt'), 'utf-8');
    expect(content).toBe('overwritten');
  });
});

describe('apply_diff', () => {
  it('replaces matching text', async () => {
    const tool = createApplyDiffTool(workspaceRoot);
    const result = await tool.execute({
      path: 'src/main.ts',
      oldString: 'const x = 1;',
      newString: 'const x = 42;',
    });
    expect(result.success).toBe(true);
    const content = await readFile(join(workspaceRoot, 'src', 'main.ts'), 'utf-8');
    expect(content).toContain('const x = 42;');
  });

  it('fails when oldString not found', async () => {
    const tool = createApplyDiffTool(workspaceRoot);
    const result = await tool.execute({
      path: 'src/main.ts',
      oldString: 'not in file',
      newString: 'replacement',
    });
    expect(result.success).toBe(false);
    expect(result.content).toContain('not found');
  });

  it('fails when oldString matches multiple locations', async () => {
    await writeFile(join(workspaceRoot, 'dupe.txt'), 'foo\nfoo\n');
    const tool = createApplyDiffTool(workspaceRoot);
    const result = await tool.execute({
      path: 'dupe.txt',
      oldString: 'foo',
      newString: 'bar',
    });
    expect(result.success).toBe(false);
    expect(result.content).toContain('matches 2 locations');
  });
});
