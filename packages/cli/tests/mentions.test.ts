import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { expandMentions } from '../src/mentions.js';

const TMP = join(import.meta.dirname ?? '.', '__test_fixtures__');

beforeAll(() => {
  mkdirSync(TMP, { recursive: true });
  writeFileSync(join(TMP, 'hello.cob'), '       IDENTIFICATION DIVISION.\n');
});

afterAll(() => {
  rmSync(TMP, { recursive: true, force: true });
});

describe('expandMentions', () => {
  it('expands a #file token to a fenced code block', () => {
    const result = expandMentions('explain #hello.cob please', TMP);
    expect(result).toContain('--- file: hello.cob ---');
    expect(result).toContain('IDENTIFICATION DIVISION');
  });

  it('leaves input unchanged when no #token present', () => {
    const input = 'what does this code do?';
    expect(expandMentions(input, TMP)).toBe(input);
  });

  it('leaves unresolved #token unchanged', () => {
    const input = 'explain #nonexistent.cob';
    expect(expandMentions(input, TMP)).toBe(input);
  });

  it('expands multiple tokens in one input', () => {
    writeFileSync(join(TMP, 'other.jcl'), '//JOB1 JOB\n');
    const result = expandMentions('compare #hello.cob with #other.jcl', TMP);
    expect(result).toContain('--- file: hello.cob ---');
    expect(result).toContain('--- file: other.jcl ---');
  });
});
