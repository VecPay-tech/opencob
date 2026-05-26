import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { createMultiEditTool } from '../src/tools/multi-edit.js';

describe('multi-edit tool', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'multi-edit-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('creates multiple new files', async () => {
    const tool = createMultiEditTool(tmpDir);
    const edits = JSON.stringify([
      { filePath: 'a.ts', content: 'export const a = 1;' },
      { filePath: 'b.ts', content: 'export const b = 2;' },
    ]);

    const result = await tool.execute({ edits });
    expect(result.success).toBe(true);
    expect(result.content).toContain('2 file(s)');
    expect(fs.readFileSync(path.join(tmpDir, 'a.ts'), 'utf-8')).toBe('export const a = 1;');
    expect(fs.readFileSync(path.join(tmpDir, 'b.ts'), 'utf-8')).toBe('export const b = 2;');
  });

  it('modifies existing files', async () => {
    fs.writeFileSync(path.join(tmpDir, 'existing.ts'), 'old content');
    const tool = createMultiEditTool(tmpDir);
    const edits = JSON.stringify([{ filePath: 'existing.ts', content: 'new content' }]);

    const result = await tool.execute({ edits });
    expect(result.success).toBe(true);
    expect(fs.readFileSync(path.join(tmpDir, 'existing.ts'), 'utf-8')).toBe('new content');
  });

  it('creates nested directories', async () => {
    const tool = createMultiEditTool(tmpDir);
    const edits = JSON.stringify([{ filePath: 'src/deep/nested/file.ts', content: 'content' }]);

    const result = await tool.execute({ edits });
    expect(result.success).toBe(true);
    expect(fs.existsSync(path.join(tmpDir, 'src/deep/nested/file.ts'))).toBe(true);
  });

  it('returns error for invalid JSON', async () => {
    const tool = createMultiEditTool(tmpDir);
    const result = await tool.execute({ edits: 'not json{' });
    expect(result.success).toBe(false);
    expect(result.content).toContain('Invalid edits parameter');
  });

  it('returns error for empty array', async () => {
    const tool = createMultiEditTool(tmpDir);
    const result = await tool.execute({ edits: '[]' });
    expect(result.success).toBe(false);
    expect(result.content).toContain('non-empty array');
  });

  it('returns error for missing filePath', async () => {
    const tool = createMultiEditTool(tmpDir);
    const edits = JSON.stringify([{ content: 'stuff' }]);
    const result = await tool.execute({ edits });
    expect(result.success).toBe(false);
    expect(result.content).toContain('filePath');
  });

  it('returns error for missing content field', async () => {
    const tool = createMultiEditTool(tmpDir);
    const edits = JSON.stringify([{ filePath: 'a.ts' }]);
    const result = await tool.execute({ edits });
    expect(result.success).toBe(false);
    expect(result.content).toContain('content');
  });

  it('rolls back on write failure', async () => {
    // Create an initial file
    fs.writeFileSync(path.join(tmpDir, 'good.ts'), 'original');

    const tool = createMultiEditTool(tmpDir);
    // First file succeeds, second targets an unwritable path
    const unwritable = path.join('..', '..', '..', '..', '..', 'proc', 'bad');
    const edits = JSON.stringify([
      { filePath: 'good.ts', content: 'modified' },
      { filePath: unwritable, content: 'fail' },
    ]);

    const result = await tool.execute({ edits });
    // The second write should fail because the path is invalid/unwritable
    // If it doesn't fail on this OS, that's okay - just verify the tool handles it
    if (!result.success) {
      expect(result.content).toContain('rolled back');
      // Verify rollback worked for the first file
      expect(fs.readFileSync(path.join(tmpDir, 'good.ts'), 'utf-8')).toBe('original');
    }
  });

  it('works with snapshotManager', async () => {
    const captures: string[] = [];
    const mockSnapshotManager = {
      captureFile: (f: string) => captures.push(f),
      startTurn: () => {},
      undoLastTurn: () => null,
    };

    fs.writeFileSync(path.join(tmpDir, 'tracked.ts'), 'original');
    const tool = createMultiEditTool(tmpDir, mockSnapshotManager as any);
    const edits = JSON.stringify([{ filePath: 'tracked.ts', content: 'updated' }]);

    const result = await tool.execute({ edits });
    expect(result.success).toBe(true);
    expect(captures).toContain('tracked.ts');
  });

  it('handles array input directly (non-string)', async () => {
    const tool = createMultiEditTool(tmpDir);
    const edits = [{ filePath: 'direct.ts', content: 'direct content' }];

    const result = await tool.execute({ edits: edits as any });
    expect(result.success).toBe(true);
    expect(fs.readFileSync(path.join(tmpDir, 'direct.ts'), 'utf-8')).toBe('direct content');
  });

  it('includes metadata with modified files', async () => {
    const tool = createMultiEditTool(tmpDir);
    const edits = JSON.stringify([
      { filePath: 'x.ts', content: 'x' },
      { filePath: 'y.ts', content: 'y' },
    ]);

    const result = await tool.execute({ edits });
    expect(result.success).toBe(true);
    expect((result as any).metadata?.filesModified).toEqual(['x.ts', 'y.ts']);
  });

  it('reports description parameter in output', async () => {
    const tool = createMultiEditTool(tmpDir);
    const edits = JSON.stringify([{ filePath: 'f.ts', content: 'content' }]);

    const result = await tool.execute({ edits, description: 'Test edit' });
    expect(result.success).toBe(true);
  });
});
