import { describe, it, expect } from 'vitest';
import { CobolParser } from '../src/legacy/cobol-parser.js';

const SAMPLE_COBOL = `000100 IDENTIFICATION DIVISION.
000200 PROGRAM-ID. CUSTMGMT.
000300 ENVIRONMENT DIVISION.
000400 DATA DIVISION.
000500 WORKING-STORAGE SECTION.
000600 01 WS-CUSTOMER-REC.
000700    05 WS-CUST-ID        PIC 9(5).
000800    05 WS-CUST-NAME      PIC X(30).
000900    05 WS-CUST-BALANCE   PIC 9(7)V99 COMP-3.
001000    88 WS-VALID-CUST     VALUE 1 THRU 99999.
001100 PROCEDURE DIVISION.
001200 MAIN-PARA.
001300     PERFORM INIT-PARA
001400     PERFORM PROCESS-PARA
001500     STOP RUN.
001600 INIT-PARA.
001700     MOVE ZEROS TO WS-CUST-ID
001800     MOVE SPACES TO WS-CUST-NAME.
001900 PROCESS-PARA.
002000     CALL 'CUSTDB'
002100     EXEC SQL
002200       SELECT CUST_NAME INTO :WS-CUST-NAME
002300       FROM CUSTOMERS
002400     END-EXEC
002500     COPY CUSTCPY.
002600     EXEC CICS SEND MAP('CUSTMAP') END-EXEC.
`;

describe('CobolParser', () => {
  let parser: CobolParser;

  beforeAll(() => {
    parser = new CobolParser();
  });

  it('extracts program ID', () => {
    const program = parser.parse(SAMPLE_COBOL, 'CUSTMGMT.cob');
    expect(program.programId).toBe('CUSTMGMT');
  });

  it('extracts divisions', () => {
    const program = parser.parse(SAMPLE_COBOL, 'CUSTMGMT.cob');
    expect(program.divisions.length).toBe(4);
    expect(program.divisions.map((d) => d.name)).toEqual([
      'IDENTIFICATION',
      'ENVIRONMENT',
      'DATA',
      'PROCEDURE',
    ]);
  });

  it('extracts paragraphs', () => {
    const program = parser.parse(SAMPLE_COBOL, 'CUSTMGMT.cob');
    expect(program.paragraphs.length).toBeGreaterThanOrEqual(2);
    const names = program.paragraphs.map((p) => p.name);
    expect(names).toContain('MAIN-PARA');
    expect(names).toContain('INIT-PARA');
    expect(names).toContain('PROCESS-PARA');
  });

  it('extracts data items with PIC clauses', () => {
    const program = parser.parse(SAMPLE_COBOL, 'CUSTMGMT.cob');
    expect(program.dataItems.length).toBeGreaterThanOrEqual(3);

    const custId = program.dataItems.find((d) => d.name === 'WS-CUST-ID');
    expect(custId).toBeDefined();
    expect(custId?.picture).toBe('9(5)');

    const balance = program.dataItems.find((d) => d.name === 'WS-CUST-BALANCE');
    expect(balance).toBeDefined();
    expect(balance?.usage).toBe('COMP-3');
  });

  it('extracts COPY statements', () => {
    const program = parser.parse(SAMPLE_COBOL, 'CUSTMGMT.cob');
    expect(program.copybooks.length).toBeGreaterThanOrEqual(1);
    expect(program.copybooks[0].name).toBe('CUSTCPY');
  });

  it('extracts CALL statements', () => {
    const program = parser.parse(SAMPLE_COBOL, 'CUSTMGMT.cob');
    expect(program.callStatements.length).toBe(1);
    expect(program.callStatements[0].target).toBe('CUSTDB');
  });

  it('extracts EXEC SQL blocks', () => {
    const program = parser.parse(SAMPLE_COBOL, 'CUSTMGMT.cob');
    expect(program.execSql.length).toBeGreaterThanOrEqual(1);
  });

  it('extracts EXEC CICS commands', () => {
    const program = parser.parse(SAMPLE_COBOL, 'CUSTMGMT.cob');
    expect(program.execCics.length).toBeGreaterThanOrEqual(1);
    expect(program.execCics[0].command).toBe('SEND');
  });

  it('generates code definitions for indexer', () => {
    const program = parser.parse(SAMPLE_COBOL, 'CUSTMGMT.cob');
    const defs = parser.extractDefinitions(program);
    expect(defs.length).toBeGreaterThanOrEqual(3);
    expect(defs.some((d) => d.kind === 'paragraph')).toBe(true);
  });

  it('generates dependency list for indexer', () => {
    const program = parser.parse(SAMPLE_COBOL, 'CUSTMGMT.cob');
    const deps = parser.extractDependencies(program);
    expect(deps.length).toBeGreaterThanOrEqual(2); // COPY + CALL
  });

  it('explains a paragraph', () => {
    const program = parser.parse(SAMPLE_COBOL, 'CUSTMGMT.cob');
    const explanation = parser.explainParagraph(program, 'INIT-PARA', SAMPLE_COBOL);
    expect(explanation).toContain('INIT-PARA');
    expect(explanation).toContain('CUSTMGMT');
  });
});

// Need to import beforeAll
import { beforeAll } from 'vitest';
