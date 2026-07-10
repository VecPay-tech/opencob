import type { AgentEvent } from './agent-loop.js';

interface FileChange {
  path: string;
  status: 'M' | 'A' | 'D' | 'R';
  added: number;
  removed: number;
}

export class ChangeTracker {
  private changes: FileChange[] = [];

  reset(): void {
    this.changes = [];
  }

  track(filePath: string, content: string, toolName?: string): void {
    let added = 0;
    let removed = 0;

    if (toolName === 'write_to_file') {
      added = content.split('\n').length;
    } else if (toolName === 'apply_diff' || toolName === 'multi_edit') {
      const lines = content.split('\n');
      for (const line of lines) {
        if (line.startsWith('+') && !line.startsWith('+++')) added++;
        if (line.startsWith('-') && !line.startsWith('---')) removed++;
      }
      if (added === 0 && removed === 0) added = Math.max(1, lines.length);
    } else {
      added = content ? content.split('\n').length : 1;
    }

    const existing = this.changes.find((f) => f.path === filePath);
    if (existing) {
      existing.added += added;
      existing.removed += removed;
    } else {
      this.changes.push({
        path: filePath,
        status: added > 0 && removed === 0 ? 'A' : 'M',
        added,
        removed,
      });
    }
  }

  getChanges(): ReadonlyArray<{
    path: string;
    status: 'M' | 'A' | 'D' | 'R';
    added: number;
    removed: number;
  }> {
    return this.changes;
  }

  buildSummaryEvent(): AgentEvent | null {
    if (this.changes.length === 0) return null;
    const totalAdded = this.changes.reduce((s, f) => s + f.added, 0);
    const totalRemoved = this.changes.reduce((s, f) => s + f.removed, 0);
    return {
      type: 'changes_summary',
      changesSummary: {
        filesChanged: this.changes.length,
        linesAdded: totalAdded,
        linesRemoved: totalRemoved,
        files: [...this.changes],
      },
    };
  }
}
