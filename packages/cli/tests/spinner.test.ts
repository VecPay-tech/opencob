import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Spinner } from '../src/spinner.js';

describe('Spinner', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('writes to stdout after one interval tick', () => {
    const spinner = new Spinner();
    spinner.start('Loading');
    vi.advanceTimersByTime(80);
    expect(process.stdout.write).toHaveBeenCalled();
  });

  it('clears the line on stop', () => {
    const spinner = new Spinner();
    spinner.start('Loading');
    spinner.stop();
    const calls = (process.stdout.write as ReturnType<typeof vi.fn>).mock.calls;
    const lastCall = calls[calls.length - 1][0] as string;
    expect(lastCall).toContain('\r\x1b[K');
  });

  it('does not throw if stopped before started', () => {
    const spinner = new Spinner();
    expect(() => spinner.stop()).not.toThrow();
  });

  it('updates the label without restarting the timer', () => {
    const spinner = new Spinner();
    spinner.start('Step 1');
    spinner.update('Step 2');
    vi.advanceTimersByTime(80);
    const calls = (process.stdout.write as ReturnType<typeof vi.fn>).mock.calls;
    const lastWritten = calls[calls.length - 1][0] as string;
    expect(lastWritten).toContain('Step 2');
    spinner.stop();
  });
});
