import { readdir } from 'node:fs/promises';
import { relative, join } from 'node:path';
import type { Tool, ToolResult } from './types.js';
import { resolveWorkspacePath, isPathError } from './workspace-paths.js';

export function createListFilesTool(workspaceRoot: string, allRoots?: string[]): Tool {
  const roots = allRoots ?? [workspaceRoot];
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
        description: 'Relative or absolute path to list (default: ".")',
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
      const resolved = resolveWorkspacePath(relInput, workspaceRoot, roots);
      if (isPathError(resolved)) {
        return { success: false, content: resolved.error };
      }
      const { absPath } = resolved;

      try {
        const recursive = Boolean(params.recursive);
        const entries = await listDir(absPath, resolved.root, recursive, 0);
        return {
          success: true,
          content: entries.join('\n') || '(empty directory)',
          metadata: { path: resolved.relDisplay, entryCount: entries.length },
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
