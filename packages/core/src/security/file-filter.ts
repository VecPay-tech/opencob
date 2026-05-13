import { readFile } from 'node:fs/promises';
import { resolve, relative } from 'node:path';

/** Default file patterns that are always excluded */
const DEFAULT_EXCLUDES = [
  '.env',
  '.env.*',
  '*.key',
  '*.pem',
  '*.p12',
  '*.pfx',
  'secrets/',
  'node_modules/',
  '.git/',
  'dist/',
];

export class FileFilter {
  private patterns: string[] = [];
  private workspaceRoot: string;

  constructor(workspaceRoot: string) {
    this.workspaceRoot = workspaceRoot;
    this.patterns = [...DEFAULT_EXCLUDES];
  }

  /** Load patterns from .OpenCobignore file */
  async loadIgnoreFile(): Promise<void> {
    const candidatePaths = [
      resolve(this.workspaceRoot, '.opencobignore'),
      resolve(this.workspaceRoot, '.OpenCobignore'),
    ];

    for (const ignorePath of candidatePaths) {
      try {
        const content = await readFile(ignorePath, 'utf-8');
        const lines = content
          .split('\n')
          .map((l: string) => l.trim())
          .filter((l: string) => l && !l.startsWith('#'));
        this.patterns = [...DEFAULT_EXCLUDES, ...lines];
        return;
      } catch {
        // Try next candidate
      }
    }

    // No ignore file — keep defaults.
  }

  /** Check if a file path is allowed (not excluded) */
  isAllowed(filePath: string): boolean {
    const relPath = filePath.startsWith(this.workspaceRoot)
      ? relative(this.workspaceRoot, filePath)
      : filePath;

    const normalized = relPath.replace(/\\/g, '/');

    for (const pattern of this.patterns) {
      if (matchPattern(normalized, pattern)) {
        return false;
      }
    }
    return true;
  }

  /** Get the filter function for use with ToolRegistry */
  getFilterFn(): (path: string) => boolean {
    return (path: string) => this.isAllowed(path);
  }
}

/** Simple gitignore-style pattern matching */
function matchPattern(filePath: string, pattern: string): boolean {
  // Exact filename match (e.g., ".env")
  const fileName = filePath.split('/').pop() || '';

  if (!pattern.includes('/') && !pattern.includes('*')) {
    return fileName === pattern;
  }

  // Directory match (e.g., "node_modules/")
  if (pattern.endsWith('/')) {
    const dir = pattern.slice(0, -1);
    return filePath.startsWith(dir + '/') || filePath.includes('/' + dir + '/') || filePath === dir;
  }

  // Glob match (e.g., "*.key", ".env.*")
  if (pattern.includes('*')) {
    const regex = new RegExp(
      '^' +
        pattern
          .replace(/[.+^${}()|[\]\\]/g, '\\$&')
          .replace(/\*/g, '.*')
          .replace(/\?/g, '.') +
        '$',
    );
    // Match against filename for simple globs, full path for path globs
    if (pattern.includes('/')) {
      return regex.test(filePath);
    }
    return regex.test(fileName);
  }

  // Path prefix match
  return filePath.startsWith(pattern) || filePath === pattern;
}
