import { describe, it, expect } from 'vitest';
import { parse } from '../src/legacy/jcl-parser.js';

const JCL_FIXTURE = `
//MYJOB01  JOB (ACCT),'MY JOB',CLASS=A,MSGCLASS=X
//* Comment line — should be ignored
//STEP01   EXEC PGM=IEFBR14
//DD01     DD DSN=MY.INPUT.DATA,DISP=SHR
//DD02     DD DSN=MY.OUTPUT.DATA,DISP=(NEW,CATLG)
//STEP02   EXEC PROC=MYPROC
//         SET SYSPARM=VALUE1
`.trim();

describe('jcl-parser', () => {
  it('parses job name', () => {
    const result = parse(JCL_FIXTURE);
    expect(result.jobName).toBe('MYJOB01');
  });

  it('parses EXEC PGM steps', () => {
    const result = parse(JCL_FIXTURE);
    expect(result.steps[0].name).toBe('STEP01');
    expect(result.steps[0].pgm).toBe('IEFBR14');
  });

  it('parses EXEC PROC steps', () => {
    const result = parse(JCL_FIXTURE);
    expect(result.steps[1].name).toBe('STEP02');
    expect(result.steps[1].proc).toBe('MYPROC');
  });

  it('parses DD statements within steps', () => {
    const result = parse(JCL_FIXTURE);
    expect(result.steps[0].dd).toHaveLength(2);
    expect(result.steps[0].dd[0].name).toBe('DD01');
    expect(result.steps[0].dd[0].dsname).toBe('MY.INPUT.DATA');
    expect(result.steps[0].dd[0].disp).toBe('SHR');
  });

  it('parses SET symbols', () => {
    const result = parse(JCL_FIXTURE);
    expect(result.symbols.get('SYSPARM')).toBe('VALUE1');
  });
});
