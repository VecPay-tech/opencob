import { describe, it, expect } from 'vitest';
import { LiterateCodingEngine } from '../src/literate/literate-coding.js';

describe('LiterateCodingEngine', () => {
  const engine = new LiterateCodingEngine();

  describe('detectBlocks', () => {
    it('detects // @OpenCob: blocks in TypeScript', () => {
      const content = [
        'import { UserService } from "./user.js";',
        '',
        '// @OpenCob: Create a function that validates email addresses using regex',
        '',
        'export function main() {}',
      ].join('\n');

      const blocks = engine.detectBlocks(content, 'typescript');
      expect(blocks.length).toBe(1);
      expect(blocks[0].text).toContain('validates email addresses');
      expect(blocks[0].line).toBe(3);
    });

    it('detects # @OpenCob: blocks in Python', () => {
      const content = [
        'import os',
        '',
        '# @OpenCob: Create a function to read CSV files and return as list of dicts',
        '',
        'def main():',
        '    pass',
      ].join('\n');

      const blocks = engine.detectBlocks(content, 'python');
      expect(blocks.length).toBe(1);
      expect(blocks[0].text).toContain('CSV files');
    });

    it('detects -- @OpenCob: blocks in SQL', () => {
      const content = [
        'CREATE TABLE users (',
        '  id INT PRIMARY KEY',
        ');',
        '',
        '-- @OpenCob: Create an index on the email column',
        '',
      ].join('\n');

      const blocks = engine.detectBlocks(content, 'sql');
      expect(blocks.length).toBe(1);
    });

    it('merges consecutive literate lines', () => {
      const content = [
        '// @OpenCob: Create a class that',
        '// @OpenCob: handles user authentication',
        '// @OpenCob: with JWT tokens',
        '',
        'export class App {}',
      ].join('\n');

      const blocks = engine.detectBlocks(content, 'typescript');
      expect(blocks.length).toBe(1);
      expect(blocks[0].text).toContain('Create a class that');
      expect(blocks[0].text).toContain('handles user authentication');
      expect(blocks[0].text).toContain('JWT tokens');
      expect(blocks[0].line).toBe(1);
      expect(blocks[0].endLine).toBe(3);
    });

    it('returns empty for no literate blocks', () => {
      const content = '// normal comment\nconst x = 1;\n';
      const blocks = engine.detectBlocks(content, 'typescript');
      expect(blocks.length).toBe(0);
    });

    it('captures prefix and suffix context', () => {
      const content = [
        'const x = 1;',
        'const y = 2;',
        '// @OpenCob: Add a function here',
        'const z = 3;',
      ].join('\n');

      const blocks = engine.detectBlocks(content, 'typescript');
      expect(blocks[0].prefix).toContain('const x = 1');
      expect(blocks[0].suffix).toContain('const z = 3');
    });
  });

  describe('hasLiterateBlocks', () => {
    it('returns true when blocks exist', () => {
      expect(engine.hasLiterateBlocks('// @OpenCob: do something')).toBe(true);
    });

    it('returns false when no blocks', () => {
      expect(engine.hasLiterateBlocks('// normal comment\nconst x = 1;')).toBe(false);
    });
  });

  describe('buildPrompt', () => {
    it('builds a prompt for the LLM', () => {
      const block = {
        text: 'Create a hello world function',
        line: 5,
        endLine: 5,
        language: 'typescript',
        prefix: 'import * as fs from "fs";',
        suffix: 'export default main;',
      };

      const prompt = engine.buildPrompt(block);
      expect(prompt).toContain('typescript');
      expect(prompt).toContain('Create a hello world function');
      expect(prompt).toContain('import * as fs');
      expect(prompt).toContain('export default main');
    });
  });

  describe('applyResult', () => {
    it('replaces literate block with generated code', () => {
      const content = [
        'const a = 1;',
        '// @OpenCob: add b variable',
        'const c = 3;',
      ].join('\n');

      const result = engine.applyResult(content, {
        originalBlock: {
          text: 'add b variable',
          line: 2,
          endLine: 2,
          language: 'typescript',
          prefix: 'const a = 1;',
          suffix: 'const c = 3;',
        },
        generatedCode: 'const b = 2;',
      });

      const lines = result.split('\n');
      expect(lines[0]).toBe('const a = 1;');
      expect(lines[1]).toBe('const b = 2;');
      expect(lines[2]).toBe('const c = 3;');
    });
  });
});
