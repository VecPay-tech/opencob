import { describe, it, expect } from 'vitest';
import { parse } from '../src/legacy/assembler-parser.js';

const ASM_FIXTURE = `
MYPGM    CSECT
         USING *,15
         COPY  COMMON
         BR    14
*
MYDATA   DSECT
LEN      DS    F
NAME     DS    CL8
*
         MACRO
MYMACRO  &PARM
         MEND
*
         END   MYPGM
`.trim();

describe('assembler-parser', () => {
  it('parses CSECT sections', () => {
    const result = parse(ASM_FIXTURE);
    const csect = result.sections.find((s) => s.type === 'CSECT');
    expect(csect?.name).toBe('MYPGM');
  });

  it('parses DSECT sections', () => {
    const result = parse(ASM_FIXTURE);
    const dsect = result.sections.find((s) => s.type === 'DSECT');
    expect(dsect?.name).toBe('MYDATA');
  });

  it('parses COPY members', () => {
    const result = parse(ASM_FIXTURE);
    expect(result.copies).toContain('COMMON');
  });

  it('parses MACRO names from prototype line', () => {
    const result = parse(ASM_FIXTURE);
    expect(result.macros).toContain('MYMACRO');
  });

  it('parses entry point from END statement', () => {
    const result = parse(ASM_FIXTURE);
    expect(result.entryPoint).toBe('MYPGM');
  });
});
