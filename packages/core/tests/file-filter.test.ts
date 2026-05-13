import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { writeFile, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { FileFilter } from '../src/security/file-filter.js';

let workspaceRoot: string;

beforeEach(async () => {
  workspaceRoot = join(tmpdir(), `OpenCob-filter-${Date.now()}`);
  await mkdir(workspaceRoot, { recursive: true });
});

afterEach(async () => {
  await rm(workspaceRoot, { recursive: true, force: true });
});

describe('FileFilter', () => {
  it('blocks .env files by default', () => {
    const filter = new FileFilter(workspaceRoot);
    expect(filter.isAllowed('.env')).toBe(false);
    expect(filter.isAllowed('.env.local')).toBe(false);
  });

  it('blocks key and pem files by default', () => {
    const filter = new FileFilter(workspaceRoot);
    expect(filter.isAllowed('server.key')).toBe(false);
    expect(filter.isAllowed('cert.pem')).toBe(false);
  });

  it('blocks node_modules by default', () => {
    const filter = new FileFilter(workspaceRoot);
    expect(filter.isAllowed('node_modules/pkg/index.js')).toBe(false);
  });

  it('allows normal source files', () => {
    const filter = new FileFilter(workspaceRoot);
    expect(filter.isAllowed('src/main.ts')).toBe(true);
    expect(filter.isAllowed('README.md')).toBe(true);
  });

  it('loads custom patterns from .OpenCobignore', async () => {
    await writeFile(join(workspaceRoot, '.OpenCobignore'), '*.log\ntemp/\n');
    const filter = new FileFilter(workspaceRoot);
    await filter.loadIgnoreFile();
    expect(filter.isAllowed('debug.log')).toBe(false);
    expect(filter.isAllowed('temp/data.txt')).toBe(false);
    expect(filter.isAllowed('src/main.ts')).toBe(true);
  });

  it('ignores comments in .OpenCobignore', async () => {
    await writeFile(join(workspaceRoot, '.OpenCobignore'), '# This is a comment\n*.log\n');
    const filter = new FileFilter(workspaceRoot);
    await filter.loadIgnoreFile();
    expect(filter.isAllowed('debug.log')).toBe(false);
  });

  it('provides filter function for ToolRegistry', () => {
    const filter = new FileFilter(workspaceRoot);
    const fn = filter.getFilterFn();
    expect(typeof fn).toBe('function');
    expect(fn('src/main.ts')).toBe(true);
    expect(fn('.env')).toBe(false);
  });
});
