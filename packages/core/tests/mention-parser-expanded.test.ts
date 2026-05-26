import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { MentionParser } from '../src/context/mention-parser.js';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';

describe('MentionParser — expanded coverage', () => {
  let tmpDir: string;
  let parser: MentionParser;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mention-exp-'));
    parser = new MentionParser(tmpDir);

    await fs.mkdir(path.join(tmpDir, 'src'), { recursive: true });
    await fs.writeFile(path.join(tmpDir, 'hello.ts'), 'export const hello = "world";');
    await fs.writeFile(path.join(tmpDir, 'src', 'main.ts'), 'console.log("main");');
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  describe('@git-changes', () => {
    it('resolves git changes when not a git repo', async () => {
      const result = await parser.parse('Show me @git-changes{status}');
      expect(result.mentions).toHaveLength(1);
      expect(result.mentions[0].type).toBe('git-changes');
      // Not a git repo → error
      expect(result.mentions[0].resolvedContent).toContain('git');
    });

    it('builds context block for git-changes', async () => {
      const result = await parser.parse('@git-changes{status}');
      expect(result.contextBlock).toContain('<git-changes>');
    });
  });

  describe('@git-commit', () => {
    it('resolves a commit hash mention', async () => {
      const result = await parser.parse('Check @abc1234 for details');
      expect(result.mentions).toHaveLength(1);
      expect(result.mentions[0].type).toBe('git-commit');
      expect(result.mentions[0].value).toBe('abc1234');
      // Not a git repo → error
      expect(result.mentions[0].resolvedContent).toContain('Error');
    });

    it('rejects invalid commit hash format', async () => {
      // Create a parser in a git repo to test hash validation
      // hash with uppercase is not matched by regex [0-9a-f], so it won't be parsed
      const result = await parser.parse('Look at @ZZZZ123');
      expect(result.mentions).toHaveLength(0);
    });

    it('builds context block for git-commit', async () => {
      const result = await parser.parse('@abcdef1');
      expect(result.contextBlock).toContain('<git-commit hash="abcdef1">');
    });
  });

  describe('@terminal', () => {
    it('resolves terminal mention (placeholder in core)', async () => {
      const result = await parser.parse('@terminal{output}');
      expect(result.mentions).toHaveLength(1);
      expect(result.mentions[0].type).toBe('terminal');
      expect(result.mentions[0].resolvedContent).toContain('Terminal context');
    });

    it('builds context block for terminal', async () => {
      const result = await parser.parse('@terminal{last}');
      expect(result.contextBlock).toContain('<terminal>');
    });
  });

  describe('@problems', () => {
    it('resolves problems mention (placeholder in core)', async () => {
      const result = await parser.parse('@problems{all}');
      expect(result.mentions).toHaveLength(1);
      expect(result.mentions[0].type).toBe('problems');
      expect(result.mentions[0].resolvedContent).toContain('Problems context');
    });

    it('builds context block for problems', async () => {
      const result = await parser.parse('@problems{workspace}');
      expect(result.contextBlock).toContain('<problems>');
    });
  });

  describe('@url', () => {
    it('resolves a URL mention', async () => {
      // Mock fetch
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        text: () => Promise.resolve('<html>page content</html>'),
      }) as any;

      const result = await parser.parse('@url{https://example.com/docs}');
      expect(result.mentions).toHaveLength(1);
      expect(result.mentions[0].type).toBe('url');
      expect(result.mentions[0].resolvedContent).toContain('page content');
    });

    it('rejects non-http URLs', async () => {
      const result = await parser.parse('@url{ftp://example.com}');
      expect(result.mentions[0].resolvedContent).toContain('unsupported URL scheme');
    });

    it('handles fetch errors gracefully', async () => {
      globalThis.fetch = vi.fn().mockRejectedValue(new Error('Network error')) as any;

      const result = await parser.parse('@url{https://dead.example.com}');
      expect(result.mentions[0].resolvedContent).toContain('Error');
    });

    it('handles non-ok responses', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 404,
      }) as any;

      const result = await parser.parse('@url{https://example.com/missing}');
      expect(result.mentions[0].resolvedContent).toContain('404');
    });

    it('truncates large URL content', async () => {
      const largeContent = 'x'.repeat(25_000);
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        text: () => Promise.resolve(largeContent),
      }) as any;

      const result = await parser.parse('@url{https://example.com/big}');
      expect(result.mentions[0].resolvedContent!.length).toBeLessThan(25_000);
      expect(result.mentions[0].resolvedContent).toContain('truncated');
    });

    it('builds context block for url', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        text: () => Promise.resolve('content'),
      }) as any;

      const result = await parser.parse('@url{https://example.com}');
      expect(result.contextBlock).toContain('<url value="https://example.com">');
    });
  });

  describe('@folder', () => {
    it('resolves folder listing', async () => {
      const result = await parser.parse('@folder{src}');
      expect(result.mentions[0].resolvedContent).toContain('main.ts');
    });

    it('prevents path traversal for folders', async () => {
      const result = await parser.parse('@folder{../../etc}');
      expect(result.mentions[0].resolvedContent).toContain('outside workspace');
    });

    it('handles nonexistent folder', async () => {
      const result = await parser.parse('@folder{nonexistent}');
      expect(result.mentions[0].resolvedContent).toContain('Error');
    });

    it('builds context block for folder', async () => {
      const result = await parser.parse('@folder{src}');
      expect(result.contextBlock).toContain('<folder path="src">');
    });
  });

  describe('multiple & mixed mentions', () => {
    it('handles multiple mentions of different types', async () => {
      const result = await parser.parse('@file{hello.ts} and @folder{src} and @terminal{output}');
      expect(result.mentions).toHaveLength(3);
      expect(result.mentions[0].type).toBe('file');
      expect(result.mentions[1].type).toBe('folder');
      expect(result.mentions[2].type).toBe('terminal');
    });

    it('clean text replaces all mentions', async () => {
      const result = await parser.parse('See @file{hello.ts} and @folder{src}');
      expect(result.cleanText).toContain('[file: hello.ts]');
      expect(result.cleanText).toContain('[folder: src]');
      expect(result.cleanText).not.toContain('@file');
      expect(result.cleanText).not.toContain('@folder');
    });
  });
});
