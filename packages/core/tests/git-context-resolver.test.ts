import { describe, it, expect } from 'vitest';
import { GitContextResolver } from '../src/agent/git-context-resolver.js';

describe('GitContextResolver.looksLikeBranch', () => {
  const resolver = new GitContextResolver();

  it('accepts typical branch names', () => {
    expect(resolver.looksLikeBranch('main')).toBe(true);
    expect(resolver.looksLikeBranch('feat/my-feature')).toBe(true);
    expect(resolver.looksLikeBranch('release-1.2.3')).toBe(true);
  });

  it('rejects inputs with spaces', () => {
    expect(resolver.looksLikeBranch('not a branch')).toBe(false);
  });

  it('rejects file paths with extensions', () => {
    expect(resolver.looksLikeBranch('src/foo.ts')).toBe(false);
    expect(resolver.looksLikeBranch('file.cbl')).toBe(false);
  });

  it('rejects inputs starting with @', () => {
    expect(resolver.looksLikeBranch('@scope/pkg')).toBe(false);
  });

  it('rejects inputs starting with /', () => {
    expect(resolver.looksLikeBranch('/absolute/path')).toBe(false);
  });
});
