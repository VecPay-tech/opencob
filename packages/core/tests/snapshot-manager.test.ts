import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { SnapshotManager } from '../src/checkpoints/snapshot-manager.js';

describe('SnapshotManager', () => {
  let tmpDir: string;
  let manager: SnapshotManager;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'OpenCob-snap-'));
    manager = new SnapshotManager(tmpDir);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('starts with zero snapshots', () => {
    expect(manager.getSnapshotCount()).toBe(0);
    expect(manager.getCurrentTurn()).toBe(0);
  });

  it('starts a new turn', () => {
    const turnId = manager.startTurn();
    expect(turnId).toBe(1);
    expect(manager.getSnapshotCount()).toBe(1);
    expect(manager.getCurrentTurn()).toBe(1);
  });

  it('captures existing file before modification', () => {
    const testFile = 'test.txt';
    fs.writeFileSync(path.join(tmpDir, testFile), 'original content');

    manager.startTurn();
    manager.captureFile(testFile);

    // Modify the file
    fs.writeFileSync(path.join(tmpDir, testFile), 'modified content');

    // Undo
    const result = manager.undoLastTurn();
    expect(result).not.toBeNull();
    expect(result!.restoredFiles).toHaveLength(1);

    const restored = fs.readFileSync(path.join(tmpDir, testFile), 'utf-8');
    expect(restored).toBe('original content');
  });

  it('deletes a file that did not exist before the turn', () => {
    manager.startTurn();
    const testFile = 'new-file.txt';
    manager.captureFile(testFile); // File doesn't exist yet

    // Create the file during the turn
    fs.writeFileSync(path.join(tmpDir, testFile), 'new content');

    // Undo should delete it
    const result = manager.undoLastTurn();
    expect(result).not.toBeNull();
    expect(fs.existsSync(path.join(tmpDir, testFile))).toBe(false);
  });

  it('returns null when undoing with no snapshots', () => {
    expect(manager.undoLastTurn()).toBeNull();
  });

  it('does not re-capture same file in same turn', () => {
    fs.writeFileSync(path.join(tmpDir, 'test.txt'), 'v1');
    manager.startTurn();
    manager.captureFile('test.txt');
    // Modify
    fs.writeFileSync(path.join(tmpDir, 'test.txt'), 'v2');
    manager.captureFile('test.txt'); // Should not overwrite snapshot

    // v2 was written, undo should restore v1 (the first capture)
    manager.undoLastTurn();
    expect(fs.readFileSync(path.join(tmpDir, 'test.txt'), 'utf-8')).toBe('v1');
  });

  it('clears all snapshots', () => {
    manager.startTurn();
    manager.startTurn();
    expect(manager.getSnapshotCount()).toBe(2);
    manager.clear();
    expect(manager.getSnapshotCount()).toBe(0);
    expect(manager.getCurrentTurn()).toBe(0);
  });
});
