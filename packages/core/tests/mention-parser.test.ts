import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { MentionParser } from '../src/context/mention-parser.js';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';

describe('MentionParser', () => {
  let tmpDir: string;
  let parser: MentionParser;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mention-'));
    parser = new MentionParser(tmpDir);

    // Create test files
    await fs.writeFile(path.join(tmpDir, 'hello.ts'), 'export const hello = "world";');
    await fs.mkdir(path.join(tmpDir, 'src'), { recursive: true });
    await fs.writeFile(path.join(tmpDir, 'src', 'main.ts'), 'console.log("main");');
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('should parse @file{path} mentions', async () => {
    const result = await parser.parse('Look at @file{hello.ts} please');
    expect(result.mentions).toHaveLength(1);
    expect(result.mentions[0].type).toBe('file');
    expect(result.mentions[0].value).toBe('hello.ts');
    expect(result.mentions[0].resolvedContent).toContain('export const hello');
  });

  it('should parse @file(path) mentions', async () => {
    const result = await parser.parse('Check @file(src/main.ts)');
    expect(result.mentions).toHaveLength(1);
    expect(result.mentions[0].type).toBe('file');
    expect(result.mentions[0].value).toBe('src/main.ts');
    expect(result.mentions[0].resolvedContent).toContain('console.log');
  });

  it('should parse bare file mentions like @hello.ts', async () => {
    const result = await parser.parse('See @hello.ts for details');
    expect(result.mentions).toHaveLength(1);
    expect(result.mentions[0].type).toBe('file');
    expect(result.mentions[0].value).toBe('hello.ts');
  });

  it('should parse @folder{path} mentions', async () => {
    const result = await parser.parse('List @folder{src}');
    expect(result.mentions).toHaveLength(1);
    expect(result.mentions[0].type).toBe('folder');
    expect(result.mentions[0].value).toBe('src');
    expect(result.mentions[0].resolvedContent).toContain('main.ts');
  });

  it('should handle multiple mentions', async () => {
    const result = await parser.parse('@file{hello.ts} and @file{src/main.ts}');
    expect(result.mentions).toHaveLength(2);
  });

  it('should build context block with file contents', async () => {
    const result = await parser.parse('Look at @file{hello.ts}');
    expect(result.contextBlock).toContain('<file path="hello.ts">');
    expect(result.contextBlock).toContain('export const hello');
    expect(result.contextBlock).toContain('</file>');
  });

  it('should replace mentions in clean text', async () => {
    const result = await parser.parse('Look at @file{hello.ts} please');
    expect(result.cleanText).toContain('[file: hello.ts]');
    expect(result.cleanText).not.toContain('@file{hello.ts}');
  });

  it('should handle non-existent files gracefully', async () => {
    const result = await parser.parse('See @file{nonexistent.ts}');
    expect(result.mentions).toHaveLength(1);
    expect(result.mentions[0].resolvedContent).toContain('Error');
  });

  it('should prevent path traversal', async () => {
    const result = await parser.parse('See @file{../../etc/passwd}');
    expect(result.mentions).toHaveLength(1);
    expect(result.mentions[0].resolvedContent).toContain('outside workspace');
  });

  it('should return empty context block when no mentions', async () => {
    const result = await parser.parse('Just a normal message');
    expect(result.mentions).toHaveLength(0);
    expect(result.contextBlock).toBe('');
    expect(result.cleanText).toBe('Just a normal message');
  });

  it('should truncate large files', async () => {
    const largeContent = 'x'.repeat(25_000);
    await fs.writeFile(path.join(tmpDir, 'big.txt'), largeContent);
    const result = await parser.parse('@file{big.txt}');
    expect(result.mentions[0].resolvedContent!.length).toBeLessThan(25_000);
    expect(result.mentions[0].resolvedContent).toContain('truncated');
  });
});
