import * as fs from 'node:fs';
import * as path from 'node:path';

export interface FileSnapshot {
  filePath: string;
  content: string | null; // null = file did not exist
}

export interface TurnSnapshot {
  turnId: number;
  timestamp: number;
  files: FileSnapshot[];
}

/**
 * Manages file snapshots for undo/rollback support.
 * Takes snapshots of files before they are modified, enabling full turn rollback.
 */
export class SnapshotManager {
  private snapshots: TurnSnapshot[] = [];
  private currentTurn: number = 0;
  private workspaceRoot: string;

  constructor(workspaceRoot: string) {
    this.workspaceRoot = workspaceRoot;
  }

  /** Start a new turn — call before any AI modifications */
  startTurn(): number {
    this.currentTurn++;
    this.snapshots.push({
      turnId: this.currentTurn,
      timestamp: Date.now(),
      files: [],
    });
    return this.currentTurn;
  }

  /** Capture a file's state before modification */
  captureFile(filePath: string): void {
    const currentSnapshot = this.snapshots[this.snapshots.length - 1];
    if (!currentSnapshot) return;

    // Don't re-capture the same file in the same turn
    if (currentSnapshot.files.some((f) => f.filePath === filePath)) return;

    const fullPath = path.resolve(this.workspaceRoot, filePath);
    let content: string | null = null;
    if (fs.existsSync(fullPath)) {
      content = fs.readFileSync(fullPath, 'utf-8');
    }

    currentSnapshot.files.push({ filePath, content });
  }

  /** Undo the last turn — restore all files to their pre-turn state */
  undoLastTurn(): { turnId: number; restoredFiles: string[] } | null {
    if (this.snapshots.length === 0) return null;

    const snapshot = this.snapshots.pop()!;
    const restoredFiles: string[] = [];

    for (const file of snapshot.files) {
      const fullPath = path.resolve(this.workspaceRoot, file.filePath);
      if (file.content === null) {
        // File didn't exist before — delete it
        if (fs.existsSync(fullPath)) {
          fs.unlinkSync(fullPath);
          restoredFiles.push(`deleted: ${file.filePath}`);
        }
      } else {
        // Restore original content
        const dir = path.dirname(fullPath);
        if (!fs.existsSync(dir)) {
          fs.mkdirSync(dir, { recursive: true });
        }
        fs.writeFileSync(fullPath, file.content, 'utf-8');
        restoredFiles.push(`restored: ${file.filePath}`);
      }
    }

    return { turnId: snapshot.turnId, restoredFiles };
  }

  /** Get current turn number */
  getCurrentTurn(): number {
    return this.currentTurn;
  }

  /** Get snapshot count */
  getSnapshotCount(): number {
    return this.snapshots.length;
  }

  /** Get the last snapshot details (for display) */
  getLastSnapshot(): TurnSnapshot | undefined {
    return this.snapshots[this.snapshots.length - 1];
  }

  /** Clear all snapshots */
  clear(): void {
    this.snapshots = [];
    this.currentTurn = 0;
  }
}
