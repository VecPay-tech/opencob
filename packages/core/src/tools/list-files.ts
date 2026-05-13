import { readdir, stat } from 'node:fs/promises';
import { resolve, relative, join } from 'node:path';
import type { Tool, ToolResult } from './types.js';

export function createListFilesTool(workspaceRoot: string): Tool {
  return {
    name: 'list_files',
    group: 'read',
    description:
      'List files and directories at a given path. ' +
      'Returns entries with type indicators (/ for directories). ' +
      'Set recursive=true to list all files recursively.',
    parameters: [
      {
        name: 'path',
        type: 'string',
        description: 'Relative path from workspace root (default: ".")',
        required: false,
      },
      {
        name: 'recursive',
        type: 'boolean',
        description: 'List files recursively',
        required: false,
      },
    ],
    async execute(params: Record<string, unknown>): Promise<ToolResult> {
      const relInput = (params.path as string) || '.';
      const absPath = resolve(workspaceRoot, relInput);

      if (!absPath.startsWith(workspaceRoot)) {
        return { success: false, content: 'Error: path is outside the workspace' };
      }

      try {
        const recursive = Boolean(params.recursive);
        const entries = await listDir(absPath, workspaceRoot, recursive, 0);
        return {
          success: true,
          content: entries.join('\n') || '(empty directory)',
          metadata: { path: relative(workspaceRoot, absPath), entryCount: entries.length },
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { success: false, content: `Error listing files: ${msg}` };
      }
    },
  };
}

const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', '.OpenCob']);

async function listDir(
  absPath: string,
  workspaceRoot: string,
  recursive: boolean,
  depth: number,
): Promise<string[]> {
  if (depth > 10) return ['... (max depth reached)'];

  const dirents = await readdir(absPath, { withFileTypes: true });
  const results: string[] = [];

  for (const dirent of dirents) {
    const fullPath = join(absPath, dirent.name);
    const relPath = relative(workspaceRoot, fullPath);

    if (dirent.isDirectory()) {
      if (SKIP_DIRS.has(dirent.name)) continue;
      results.push(`${relPath}/`);
      if (recursive) {
        const nested = await listDir(fullPath, workspaceRoot, true, depth + 1);
        results.push(...nested);
      }
    } else {
      results.push(relPath);
    }
  }

  return results;
}
