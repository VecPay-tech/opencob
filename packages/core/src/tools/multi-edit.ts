import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Tool, ToolResult } from './types.js';
import type { SnapshotManager } from '../checkpoints/snapshot-manager.js';

interface EditOperation {
  filePath: string;
  content: string;
}

/** Creates the multi_edit tool for atomic multi-file edits */
export function createMultiEditTool(
  workspaceRoot: string,
  snapshotManager?: SnapshotManager,
): Tool {
  return {
    name: 'multi_edit',
    group: 'edit',
    description:
      'Atomic multi-file edit: apply changes to multiple files in a single operation. All changes succeed or all roll back. Pre-edit snapshots are taken for safety.',
    parameters: [
      {
        name: 'edits',
        type: 'string',
        description:
          'JSON array of edit operations: [{ "filePath": "relative/path", "content": "full file content" }, ...]. Each entry specifies a file path and its new content.',
        required: true,
      },
      {
        name: 'description',
        type: 'string',
        description: 'Brief description of the multi-file edit operation',
        required: false,
      },
    ],
    async execute(params: Record<string, unknown>): Promise<ToolResult> {
      let edits: EditOperation[];
      try {
        const raw = params.edits as string;
        edits = typeof raw === 'string' ? JSON.parse(raw) : (raw as unknown as EditOperation[]);
      } catch {
        return { success: false, content: 'Invalid edits parameter: must be valid JSON array.' };
      }

      if (!Array.isArray(edits) || edits.length === 0) {
        return { success: false, content: 'Edits must be a non-empty array.' };
      }

      // Validate all paths first
      for (const edit of edits) {
        if (!edit.filePath || typeof edit.content !== 'string') {
          return {
            success: false,
            content: `Invalid edit entry: each must have "filePath" and "content" fields.`,
          };
        }
      }

      // Take snapshots of existing files before editing
      const snapshots = new Map<string, string | null>();
      for (const edit of edits) {
        const fullPath = path.resolve(workspaceRoot, edit.filePath);
        try {
          if (fs.existsSync(fullPath)) {
            snapshots.set(edit.filePath, fs.readFileSync(fullPath, 'utf-8'));
            // Also record in snapshot manager
            if (snapshotManager) {
              snapshotManager.captureFile(edit.filePath);
            }
          } else {
            snapshots.set(edit.filePath, null); // new file
          }
        } catch (err) {
          return {
            success: false,
            content: `Failed to snapshot ${edit.filePath}: ${err instanceof Error ? err.message : String(err)}`,
          };
        }
      }

      // Apply all edits — roll back on any failure
      const applied: string[] = [];
      try {
        for (const edit of edits) {
          const fullPath = path.resolve(workspaceRoot, edit.filePath);
          const dir = path.dirname(fullPath);
          if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
          }
          fs.writeFileSync(fullPath, edit.content, 'utf-8');
          applied.push(edit.filePath);
        }
      } catch (err) {
        // Roll back all applied changes
        for (const filePath of applied) {
          const original = snapshots.get(filePath);
          const fullPath = path.resolve(workspaceRoot, filePath);
          if (original === null) {
            // File didn't exist before — delete it
            try {
              fs.unlinkSync(fullPath);
            } catch {
              /* ignore */
            }
          } else if (original !== undefined) {
            try {
              fs.writeFileSync(fullPath, original, 'utf-8');
            } catch {
              /* ignore */
            }
          }
        }
        return {
          success: false,
          content: `Multi-edit failed and rolled back ${applied.length} file(s): ${err instanceof Error ? err.message : String(err)}`,
        };
      }

      return {
        success: true,
        content: `Successfully edited ${applied.length} file(s):\n${applied.map((f) => `  ✓ ${f}`).join('\n')}`,
        metadata: { filesModified: applied },
      };
    },
  };
}
