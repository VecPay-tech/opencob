import { describe, it, expect } from 'vitest';
import { parse } from '../src/legacy/natural-parser.js';

const NAT_FIXTURE = `
* Main program
PROGRAM CUSTMAINT
DEFINE DATA
LOCAL
1 #CUSTNO (A8)
1 #NAME   (A30)
PARAMETER
1 #ACTION (A1)
END-DEFINE
CALLNAT 'CUSTVAL'
FETCH 'CUSTMENU'
READ CUSTOMERS WITH CUSTNO = #CUSTNO
FIND ORDERS WITH ORDERNO = '12345'
END
`.trim();

describe('natural-parser', () => {
  it('parses module type and name', () => {
    const result = parse(NAT_FIXTURE);
    expect(result.type).toBe('PROGRAM');
    expect(result.name).toBe('CUSTMAINT');
  });

  it('parses LOCAL variables', () => {
    const result = parse(NAT_FIXTURE);
    const local = result.dataArea.filter((v) => v.scope === 'LOCAL');
    expect(local).toHaveLength(2);
    expect(local[0]).toMatchObject({ level: 1, name: '#CUSTNO', type: 'A8', scope: 'LOCAL' });
  });

  it('parses PARAMETER variables', () => {
    const result = parse(NAT_FIXTURE);
    const params = result.dataArea.filter((v) => v.scope === 'PARAMETER');
    expect(params).toHaveLength(1);
    expect(params[0].name).toBe('#ACTION');
  });

  it('parses external calls', () => {
    const result = parse(NAT_FIXTURE);
    expect(result.externalCalls).toContain('CUSTVAL');
    expect(result.externalCalls).toContain('CUSTMENU');
  });

  it('parses database access statements', () => {
    const result = parse(NAT_FIXTURE);
    expect(result.dbAccess).toHaveLength(2);
    expect(result.dbAccess[0]).toMatchObject({ statement: 'READ', ddm: 'CUSTOMERS' });
    expect(result.dbAccess[1]).toMatchObject({ statement: 'FIND', ddm: 'ORDERS' });
  });
});
