import { readFile } from 'node:fs/promises';
import type { Tool, ToolResult } from './types.js';
import { resolveWorkspacePath, isPathError } from './workspace-paths.js';

export function createReadFileTool(workspaceRoot: string, allRoots?: string[]): Tool {
  const roots = allRoots ?? [workspaceRoot];
  return {
    name: 'read_file',
    group: 'read',
    description:
      'Read the contents of a file. Returns the file content with line numbers. ' +
      'Optionally specify startLine and endLine to read a range.',
    parameters: [
      {
        name: 'path',
        type: 'string',
        description: 'Relative or absolute path to the file',
        required: true,
      },
      {
        name: 'startLine',
        type: 'number',
        description: 'Start line (1-based, inclusive)',
        required: false,
      },
      {
        name: 'endLine',
        type: 'number',
        description: 'End line (1-based, inclusive)',
        required: false,
      },
    ],
    async execute(params: Record<string, unknown>): Promise<ToolResult> {
      const filePath = params.path as string;
      if (!filePath) {
        return { success: false, content: 'Error: path parameter is required' };
      }

      const resolved = resolveWorkspacePath(filePath, workspaceRoot, roots);
      if (isPathError(resolved)) {
        return { success: false, content: resolved.error };
      }
      const { absPath, relDisplay } = resolved;

      try {
        const content = await readFile(absPath, 'utf-8');
        const lines = content.split('\n');

        const start = Math.max(1, (params.startLine as number) || 1);
        const end = Math.min(lines.length, (params.endLine as number) || lines.length);

        const relPath = relDisplay;
        const numbered = lines
          .slice(start - 1, end)
          .map((line: string, i: number) => `${start + i} | ${line}`)
          .join('\n');

        return {
          success: true,
          content: numbered,
          metadata: { path: relPath, lineCount: lines.length, startLine: start, endLine: end },
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { success: false, content: `Error reading file: ${msg}` };
      }
    },
  };
}
