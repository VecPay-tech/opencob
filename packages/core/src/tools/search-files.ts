import { readFile, readdir } from 'node:fs/promises';
import { resolve, relative, join } from 'node:path';
import type { Tool, ToolResult } from './types.js';

export function createSearchFilesTool(workspaceRoot: string): Tool {
  return {
    name: 'search_files',
    group: 'read',
    description:
      'Search files in the workspace using a regex pattern. ' +
      'Returns matching lines with file paths, line numbers, and content. ' +
      'Optionally restrict search to a subdirectory with the path parameter.',
    parameters: [
      {
        name: 'pattern',
        type: 'string',
        description: 'Regex pattern to search for',
        required: true,
      },
      {
        name: 'path',
        type: 'string',
        description: 'Subdirectory to search in (default: entire workspace)',
        required: false,
      },
      {
        name: 'caseSensitive',
        type: 'boolean',
        description: 'Case-sensitive search (default: false)',
        required: false,
      },
    ],
    async execute(params: Record<string, unknown>): Promise<ToolResult> {
      const pattern = params.pattern as string;
      if (!pattern) {
        return { success: false, content: 'Error: pattern parameter is required' };
      }

      const searchPath = resolve(workspaceRoot, (params.path as string) || '.');
      if (!searchPath.startsWith(workspaceRoot)) {
        return { success: false, content: 'Error: path is outside the workspace' };
      }

      const flags = (params.caseSensitive as boolean) ? 'g' : 'gi';
      let regex: RegExp;
      try {
        regex = new RegExp(pattern, flags);
      } catch {
        return { success: false, content: `Error: invalid regex pattern: ${pattern}` };
      }

      try {
        const matches: string[] = [];
        await searchDir(searchPath, workspaceRoot, regex, matches);

        if (matches.length === 0) {
          return { success: true, content: 'No matches found.', metadata: { matchCount: 0 } };
        }

        const truncated = matches.length > 100;
        const output = matches.slice(0, 100).join('\n');
        const suffix = truncated ? `\n... (${matches.length - 100} more matches)` : '';

        return {
          success: true,
          content: output + suffix,
          metadata: { matchCount: matches.length },
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { success: false, content: `Error searching files: ${msg}` };
      }
    },
  };
}

const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', '.OpenCob']);
const BINARY_EXTS = new Set([
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.ico',
  '.woff',
  '.woff2',
  '.ttf',
  '.eot',
  '.zip',
  '.tar',
  '.gz',
  '.exe',
  '.dll',
  '.so',
  '.dylib',
]);

async function searchDir(
  absPath: string,
  workspaceRoot: string,
  regex: RegExp,
  matches: string[],
): Promise<void> {
  if (matches.length >= 200) return;

  const dirents = await readdir(absPath, { withFileTypes: true });

  for (const dirent of dirents) {
    if (matches.length >= 200) return;

    const fullPath = join(absPath, dirent.name);

    if (dirent.isDirectory()) {
      if (SKIP_DIRS.has(dirent.name)) continue;
      await searchDir(fullPath, workspaceRoot, regex, matches);
    } else {
      if (BINARY_EXTS.has(dirent.name.substring(dirent.name.lastIndexOf('.')))) continue;

      try {
        const content = await readFile(fullPath, 'utf-8');
        const lines = content.split('\n');
        const relPath = relative(workspaceRoot, fullPath);

        for (let i = 0; i < lines.length; i++) {
          regex.lastIndex = 0;
          if (regex.test(lines[i])) {
            matches.push(`${relPath}:${i + 1}: ${lines[i].trim()}`);
            if (matches.length >= 200) return;
          }
        }
      } catch {
        // Skip unreadable files
      }
    }
  }
}
