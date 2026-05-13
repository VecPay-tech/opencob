import { readFile } from 'node:fs/promises';
import { resolve, relative } from 'node:path';
import type { Tool, ToolResult } from './types.js';

export function createReadFileTool(workspaceRoot: string): Tool {
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
        description: 'Relative path to the file from workspace root',
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

      const absPath = resolve(workspaceRoot, filePath);
      const relPath = relative(workspaceRoot, absPath);

      // Prevent path traversal outside workspace
      if (
        relPath.startsWith('..') ||
        (resolve(absPath) !== absPath && !absPath.startsWith(workspaceRoot))
      ) {
        return { success: false, content: 'Error: path is outside the workspace' };
      }

      try {
        const content = await readFile(absPath, 'utf-8');
        const lines = content.split('\n');

        const start = Math.max(1, (params.startLine as number) || 1);
        const end = Math.min(lines.length, (params.endLine as number) || lines.length);

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
