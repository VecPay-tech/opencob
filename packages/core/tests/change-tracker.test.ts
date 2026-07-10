import { describe, it, expect, beforeEach } from 'vitest';
import { ChangeTracker } from '../src/agent/change-tracker.js';

describe('ChangeTracker', () => {
  let tracker: ChangeTracker;

  beforeEach(() => {
    tracker = new ChangeTracker();
  });

  it('returns null summary when no files tracked', () => {
    expect(tracker.buildSummaryEvent()).toBeNull();
  });

  it('counts all lines as added for write_to_file', () => {
    tracker.track('foo.ts', 'a\nb\nc', 'write_to_file');
    const event = tracker.buildSummaryEvent()!;
    expect(event.type).toBe('changes_summary');
    expect(event.changesSummary!.files[0].added).toBe(3);
    expect(event.changesSummary!.files[0].status).toBe('A');
  });

  it('parses diff markers for apply_diff', () => {
    tracker.track('foo.ts', '+added line\n-removed line\ncontext', 'apply_diff');
    const event = tracker.buildSummaryEvent()!;
    expect(event.changesSummary!.files[0].added).toBe(1);
    expect(event.changesSummary!.files[0].removed).toBe(1);
    expect(event.changesSummary!.files[0].status).toBe('M');
  });

  it('merges changes for the same file across multiple track() calls', () => {
    tracker.track('foo.ts', 'a\nb', 'write_to_file');
    tracker.track('foo.ts', '+more\n-less', 'apply_diff');
    const event = tracker.buildSummaryEvent()!;
    expect(event.changesSummary!.filesChanged).toBe(1);
    expect(event.changesSummary!.files[0].added).toBe(3);
  });

  it('reset() clears state so next summary is null', () => {
    tracker.track('foo.ts', 'content', 'write_to_file');
    tracker.reset();
    expect(tracker.buildSummaryEvent()).toBeNull();
  });

  it('aggregates totals across multiple files', () => {
    tracker.track('a.ts', 'line1\nline2', 'write_to_file');
    tracker.track('b.ts', 'line1', 'write_to_file');
    const event = tracker.buildSummaryEvent()!;
    expect(event.changesSummary!.filesChanged).toBe(2);
    expect(event.changesSummary!.linesAdded).toBe(3);
  });
});
