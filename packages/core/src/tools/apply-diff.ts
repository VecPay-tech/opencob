import { readFile, writeFile } from 'node:fs/promises';
import { resolve, relative } from 'node:path';
import type { Tool, ToolResult } from './types.js';

export function createApplyDiffTool(workspaceRoot: string): Tool {
  return {
    name: 'apply_diff',
    group: 'edit',
    description:
      'Apply a targeted edit to a file by replacing an exact string match. ' +
      'The oldString must match exactly one location in the file. ' +
      'Provide sufficient context lines for a unique match.',
    parameters: [
      { name: 'path', type: 'string', description: 'Relative path to the file from workspace root', required: true },
      { name: 'oldString', type: 'string', description: 'The exact text to find and replace (must match exactly once)', required: true },
      { name: 'newString', type: 'string', description: 'The replacement text', required: true },
    ],
    async execute(params: Record<string, unknown>): Promise<ToolResult> {
      const filePath = params.path as string;
      const oldString = params.oldString as string;
      const newString = params.newString as string;

      if (!filePath) return { success: false, content: 'Error: path parameter is required' };
      if (!oldString) return { success: false, content: 'Error: oldString parameter is required' };
      if (newString === undefined || newString === null) {
        return { success: false, content: 'Error: newString parameter is required' };
      }

      const absPath = resolve(workspaceRoot, filePath);
      if (!absPath.startsWith(workspaceRoot)) {
        return { success: false, content: 'Error: path is outside the workspace' };
      }

      try {
        const content = await readFile(absPath, 'utf-8');

        // Count occurrences
        let count = 0;
        let idx = 0;
        while ((idx = content.indexOf(oldString, idx)) !== -1) {
          count++;
          idx += oldString.length;
        }

        if (count === 0) {
          return { success: false, content: 'Error: oldString not found in file' };
        }
        if (count > 1) {
          return {
            success: false,
            content: `Error: oldString matches ${count} locations in file. Add more context lines for a unique match.`,
          };
        }

        const updated = content.replace(oldString, newString);
        await writeFile(absPath, updated, 'utf-8');

        const relPath = relative(workspaceRoot, absPath);
        return {
          success: true,
          content: `Diff applied to ${relPath}`,
          metadata: { path: relPath },
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { success: false, content: `Error applying diff: ${msg}` };
      }
    },
  };
}
