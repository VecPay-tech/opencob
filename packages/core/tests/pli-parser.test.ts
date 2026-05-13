import { describe, it, expect } from 'vitest';
import { PliParser } from '../src/legacy/pli-parser.js';

const SAMPLE_PLI = `/* Sample PL/I program */
MAINPROG: PROC OPTIONS(MAIN);

  %INCLUDE COPYLIB;

  DCL 1 CUSTOMER,
    2 CUST_ID CHAR(10),
    2 CUST_NAME CHAR(50),
    2 BALANCE FIXED DEC(15,2);

  DCL WS_COUNT FIXED BIN(31);
  DCL WS_FLAG BIT(1);

  EXEC SQL SELECT COUNT(*) INTO :WS_COUNT FROM CUSTOMERS;

  CALL SUBPROG(CUST_ID);

  INNER_PROC: PROC(P1);
    DCL P1 CHAR(10);
    RETURN;
  END INNER_PROC;

END MAINPROG;
`;

describe('PliParser', () => {
  const parser = new PliParser();

  it('parses procedures', () => {
    const program = parser.parse(SAMPLE_PLI, 'test.pli');
    expect(program.procedures.length).toBeGreaterThanOrEqual(2);

    const main = program.procedures.find((p) => p.name === 'MAINPROG');
    expect(main).toBeDefined();
    expect(main!.type).toBe('external');

    const inner = program.procedures.find((p) => p.name === 'INNER_PROC');
    expect(inner).toBeDefined();
    expect(inner!.type).toBe('internal');
    expect(inner!.parameters).toContain('P1');
  });

  it('parses declarations', () => {
    const program = parser.parse(SAMPLE_PLI, 'test.pli');
    const count = program.declarations.find((d) => d.name === 'WS_COUNT');
    expect(count).toBeDefined();
    expect(count!.type).toBe('FIXED BINARY');

    const flag = program.declarations.find((d) => d.name === 'WS_FLAG');
    expect(flag).toBeDefined();
    expect(flag!.type).toBe('BIT');
  });

  it('parses structures', () => {
    const program = parser.parse(SAMPLE_PLI, 'test.pli');
    expect(program.structures.length).toBe(1);
    expect(program.structures[0].name).toBe('CUSTOMER');
    expect(program.structures[0].members.length).toBe(3);
    expect(program.structures[0].members[0].name).toBe('CUST_ID');
  });

  it('parses %INCLUDE directives', () => {
    const program = parser.parse(SAMPLE_PLI, 'test.pli');
    expect(program.includes.length).toBe(1);
    expect(program.includes[0].name).toBe('COPYLIB');
  });

  it('parses EXEC SQL statements', () => {
    const program = parser.parse(SAMPLE_PLI, 'test.pli');
    expect(program.execSql.length).toBe(1);
    expect(program.execSql[0].statement).toContain('SELECT COUNT');
  });

  it('parses CALL statements', () => {
    const program = parser.parse(SAMPLE_PLI, 'test.pli');
    expect(program.callStatements.length).toBe(1);
    expect(program.callStatements[0].target).toBe('SUBPROG');
  });

  it('identifies entry points', () => {
    const program = parser.parse(SAMPLE_PLI, 'test.pli');
    expect(program.entryPoints).toContain('MAINPROG');
  });

  it('extracts CodeDefinitions', () => {
    const defs = parser.extractDefinitions(SAMPLE_PLI, 'test.pli');
    expect(defs.length).toBeGreaterThanOrEqual(3);
    expect(defs.find((d) => d.name === 'MAINPROG')).toBeDefined();
    expect(defs.find((d) => d.name === 'CUSTOMER')).toBeDefined();
  });

  it('extracts FileDependencies', () => {
    const deps = parser.extractDependencies(SAMPLE_PLI, 'test.pli');
    expect(deps.length).toBe(1);
    expect(deps[0].type).toBe('include');
    expect(deps[0].targetFile).toBe('COPYLIB');
  });
});
