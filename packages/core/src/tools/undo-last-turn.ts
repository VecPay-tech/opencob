import type { Tool, ToolResult } from './types.js';
import type { SnapshotManager } from '../checkpoints/snapshot-manager.js';

/**
 * Rolls back all file changes from the last AI turn using saved snapshots.
 */
export function createUndoLastTurnTool(snapshotManager: SnapshotManager): Tool {
  return {
    name: 'undo_last_turn',
    group: 'meta',
    description:
      'Roll back all file changes from the previous AI turn. Restores files to their state before the last turn.',
    parameters: [],
    async execute(_params: Record<string, unknown>): Promise<ToolResult> {
      const result = snapshotManager.undoLastTurn();

      if (!result) {
        return {
          success: false,
          content: 'No snapshots available to undo. No previous turns have been recorded.',
        };
      }

      if (result.restoredFiles.length === 0) {
        return {
          success: true,
          content: `Turn ${result.turnId} had no file modifications to undo.`,
          metadata: { turnId: result.turnId },
        };
      }

      const fileList = result.restoredFiles.join('\n  ');
      return {
        success: true,
        content: `Undid turn ${result.turnId}. Restored ${result.restoredFiles.length} file(s):\n  ${fileList}`,
        metadata: {
          turnId: result.turnId,
          fileCount: result.restoredFiles.length,
        },
      };
    },
  };
}
