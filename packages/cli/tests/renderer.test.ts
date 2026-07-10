import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { CliRenderer } from '../src/renderer.js';
import { Spinner } from '../src/spinner.js';

async function* makeEvents(events: object[]) {
  for (const e of events) yield e as never;
}

describe('CliRenderer', () => {
  let stdoutSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function makeSpinner(): Spinner {
    const s = new Spinner();
    vi.spyOn(s, 'start').mockImplementation(() => {});
    vi.spyOn(s, 'update').mockImplementation(() => {});
    vi.spyOn(s, 'stop').mockImplementation(() => {});
    return s;
  }

  it('writes text events to stdout', async () => {
    const renderer = new CliRenderer(makeSpinner());
    await renderer.render(
      makeEvents([
        { type: 'text', text: 'Hello ' },
        { type: 'text', text: 'world' },
        { type: 'done' },
      ]),
    );
    const written = stdoutSpy.mock.calls.map((c) => c[0]).join('');
    expect(written).toContain('Hello ');
    expect(written).toContain('world');
  });

  it('prints tool_call events in dim colour', async () => {
    const renderer = new CliRenderer(makeSpinner());
    await renderer.render(
      makeEvents([
        {
          type: 'tool_call',
          toolCall: { name: 'read_file', parameters: { path: 'foo.ts' } },
        },
        { type: 'done' },
      ]),
    );
    const written = stdoutSpy.mock.calls.map((c) => c[0]).join('');
    expect(written).toContain('read_file');
    expect(written).toContain('\x1b[2m');
  });

  it('stops spinner on done event', async () => {
    const spinner = makeSpinner();
    const renderer = new CliRenderer(spinner);
    await renderer.render(makeEvents([{ type: 'done' }]));
    expect(spinner.stop).toHaveBeenCalled();
  });

  it('writes error message to stderr on error event', async () => {
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const renderer = new CliRenderer(makeSpinner());
    await renderer.render(
      makeEvents([{ type: 'error', error: 'something went wrong' }, { type: 'done' }]),
    );
    const written = stderrSpy.mock.calls.map((c) => c[0]).join('');
    expect(written).toContain('something went wrong');
  });
});
