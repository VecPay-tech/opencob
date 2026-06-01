import { writeFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { Tool, ToolResult } from './types.js';
import { resolveWorkspacePath, isPathError } from './workspace-paths.js';

export function createWriteFileTool(workspaceRoot: string, allRoots?: string[]): Tool {
  const roots = allRoots ?? [workspaceRoot];
  return {
    name: 'write_to_file',
    group: 'edit',
    description:
      'Create a new file or overwrite an existing file with the provided content. ' +
      'Directories are created automatically if they do not exist.',
    parameters: [
      {
        name: 'path',
        type: 'string',
        description: 'Relative or absolute path to the file',
        required: true,
      },
      {
        name: 'content',
        type: 'string',
        description: 'The full content to write to the file',
        required: true,
      },
    ],
    async execute(params: Record<string, unknown>): Promise<ToolResult> {
      const filePath = params.path as string;
      const content = params.content as string;

      if (!filePath) return { success: false, content: 'Error: path parameter is required' };
      if (content === undefined || content === null) {
        return { success: false, content: 'Error: content parameter is required' };
      }

      const resolved = resolveWorkspacePath(filePath, workspaceRoot, roots);
      if (isPathError(resolved)) {
        return { success: false, content: resolved.error };
      }
      const { absPath, relDisplay } = resolved;

      try {
        await mkdir(dirname(absPath), { recursive: true });
        await writeFile(absPath, content, 'utf-8');
        return {
          success: true,
          content: `File written: ${relDisplay}`,
          metadata: { path: relDisplay, bytes: Buffer.byteLength(content, 'utf-8') },
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { success: false, content: `Error writing file: ${msg}` };
      }
    },
  };
}
