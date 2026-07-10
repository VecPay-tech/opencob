import { describe, it, expect } from 'vitest';
import { parse } from '../src/legacy/rexx-parser.js';

const REXX_FIXTURE = `
/* REXX exec: main routine */
CALL INITIALIZE
CALL EXTERNAL_ROUTINE
SIGNAL DONE

INITIALIZE:
  SAY 'Starting up'
RETURN

DONE:
  EXIT 0
`.trim();

const REXX_DYNAMIC = `
/* REXX with INTERPRET */
INTERPRET 'SAY hello'
`.trim();

describe('rexx-parser', () => {
  it('detects procedure labels', () => {
    const result = parse(REXX_FIXTURE);
    expect(result.labels).toContain('INITIALIZE');
    expect(result.labels).toContain('DONE');
  });

  it('classifies internal calls', () => {
    const result = parse(REXX_FIXTURE);
    const initCall = result.calls.find((c) => c.target === 'INITIALIZE');
    expect(initCall?.type).toBe('internal');
  });

  it('classifies external calls', () => {
    const result = parse(REXX_FIXTURE);
    const extCall = result.calls.find((c) => c.target === 'EXTERNAL_ROUTINE');
    expect(extCall?.type).toBe('external');
  });

  it('parses SIGNAL targets', () => {
    const result = parse(REXX_FIXTURE);
    expect(result.signals).toContain('DONE');
  });

  it('detects dynamic execution', () => {
    expect(parse(REXX_FIXTURE).hasDynamicExec).toBe(false);
    expect(parse(REXX_DYNAMIC).hasDynamicExec).toBe(true);
  });
});
