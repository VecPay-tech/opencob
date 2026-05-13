import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Tool, ToolResult } from './types.js';

/**
 * Insert content at a specific line position in a file.
 */
export function createInsertContentTool(workspaceRoot: string): Tool {
  return {
    name: 'insert_content',
    group: 'edit',
    description:
      'Insert content at a specific line position in a file. Line 0 inserts before the first line.',
    parameters: [
      {
        name: 'path',
        type: 'string',
        description: 'File path relative to workspace root',
        required: true,
      },
      {
        name: 'position',
        type: 'number',
        description: 'Line number to insert at (0-based). Content is inserted before this line.',
        required: true,
      },
      {
        name: 'content',
        type: 'string',
        description: 'Content to insert',
        required: true,
      },
    ],
    async execute(params: Record<string, unknown>): Promise<ToolResult> {
      const filePath = params.path as string;
      const position = params.position as number;
      const content = params.content as string;

      if (!filePath) return { success: false, content: 'Error: path is required' };
      if (position === undefined || position === null) return { success: false, content: 'Error: position is required' };
      if (!content) return { success: false, content: 'Error: content is required' };

      const fullPath = path.resolve(workspaceRoot, filePath);
      if (!fullPath.startsWith(path.resolve(workspaceRoot))) {
        return { success: false, content: 'Error: path traversal not allowed' };
      }

      if (!fs.existsSync(fullPath)) {
        return { success: false, content: `Error: file not found: ${filePath}` };
      }

      const existing = fs.readFileSync(fullPath, 'utf-8');
      const lines = existing.split('\n');

      const insertAt = Math.max(0, Math.min(position, lines.length));
      const newLines = content.split('\n');
      lines.splice(insertAt, 0, ...newLines);

      fs.writeFileSync(fullPath, lines.join('\n'), 'utf-8');

      return {
        success: true,
        content: `Inserted ${newLines.length} line(s) at line ${insertAt} in ${filePath}`,
        metadata: {
          path: filePath,
          insertedLines: newLines.length,
          position: insertAt,
          totalLines: lines.length,
        },
      };
    },
  };
}
