import { describe, it, expect, beforeAll } from 'vitest';
import { RpgParser } from '../src/legacy/rpg-parser.js';

const SAMPLE_RPG_FREE = `**FREE
CTL-OPT DFTACTGRP(*NO);

/COPY QRPGLESRC,PROTOTYPES

DCL-F CUSTFILE DISK USAGE(*INPUT);

DCL-DS CustomerRec QUALIFIED;
  custId CHAR(5);
  custName CHAR(30);
  balance PACKED(9:2);
END-DS;

DCL-PROC ProcessCustomer;
  DCL-PI *N;
    pCustId CHAR(5) CONST;
  END-PI;

  IF *IN99;
    // indicator test
  ENDIF;

  EXEC SQL SELECT * FROM CUSTOMERS;

  RETURN;
END-PROC;

BEGSR InitRoutine;
  CLEAR CustomerRec;
ENDSR;
`;

const SAMPLE_RPG_FIXED = `     H DFTACTGRP(*NO)
     FCUSTFILE  IF   E             DISK
     D CustomerRec   DS
     D  CustId                5    0
     D  CustName             30
     C     *ENTRY        PLIST
     C                   PARM                    CustId
     C                   BEGSR     CalcTotal
     C                   ENDSR
     P ProcessOrder  B
     P ProcessOrder  E
`;

describe('RpgParser', () => {
  let parser: RpgParser;

  beforeAll(() => {
    parser = new RpgParser();
  });

  describe('Free-format RPG', () => {
    it('detects free format', () => {
      const program = parser.parse(SAMPLE_RPG_FREE, 'custproc.rpgle');
      expect(program.format).toBe('free');
    });

    it('extracts procedures', () => {
      const program = parser.parse(SAMPLE_RPG_FREE, 'custproc.rpgle');
      expect(program.procedures.length).toBe(1);
      expect(program.procedures[0].name).toBe('ProcessCustomer');
    });

    it('extracts subroutines', () => {
      const program = parser.parse(SAMPLE_RPG_FREE, 'custproc.rpgle');
      expect(program.subroutines.length).toBe(1);
      expect(program.subroutines[0].name).toBe('InitRoutine');
    });

    it('extracts data structures', () => {
      const program = parser.parse(SAMPLE_RPG_FREE, 'custproc.rpgle');
      expect(program.dataStructures.length).toBe(1);
      expect(program.dataStructures[0].name).toBe('CustomerRec');
      expect(program.dataStructures[0].fields.length).toBeGreaterThanOrEqual(1);
    });

    it('extracts /COPY directives', () => {
      const program = parser.parse(SAMPLE_RPG_FREE, 'custproc.rpgle');
      expect(program.copyDirectives.length).toBe(1);
    });

    it('extracts file declarations', () => {
      const program = parser.parse(SAMPLE_RPG_FREE, 'custproc.rpgle');
      expect(program.fileDeclarations.length).toBe(1);
      expect(program.fileDeclarations[0].name).toBe('CUSTFILE');
    });

    it('extracts SQL statements', () => {
      const program = parser.parse(SAMPLE_RPG_FREE, 'custproc.rpgle');
      expect(program.sqlStatements.length).toBeGreaterThanOrEqual(1);
    });

    it('extracts indicator usage', () => {
      const program = parser.parse(SAMPLE_RPG_FREE, 'custproc.rpgle');
      expect(program.indicators.length).toBeGreaterThanOrEqual(1);
    });
  });

  describe('Fixed-format RPG', () => {
    it('detects fixed format', () => {
      const program = parser.parse(SAMPLE_RPG_FIXED, 'custpgm.rpg');
      expect(program.format).toBe('fixed');
    });

    it('extracts file declarations from F-spec', () => {
      const program = parser.parse(SAMPLE_RPG_FIXED, 'custpgm.rpg');
      expect(program.fileDeclarations.length).toBeGreaterThanOrEqual(1);
    });

    it('extracts subroutines from C-spec', () => {
      const program = parser.parse(SAMPLE_RPG_FIXED, 'custpgm.rpg');
      expect(program.subroutines.length).toBe(1);
      expect(program.subroutines[0].name).toBe('CalcTotal');
    });

    it('extracts procedures from P-spec', () => {
      const program = parser.parse(SAMPLE_RPG_FIXED, 'custpgm.rpg');
      expect(program.procedures.length).toBe(1);
      expect(program.procedures[0].name).toBe('ProcessOrder');
    });
  });

  describe('Definition extraction', () => {
    it('generates CodeDefinitions for indexer', () => {
      const program = parser.parse(SAMPLE_RPG_FREE, 'custproc.rpgle');
      const defs = parser.extractDefinitions(program);
      expect(defs.length).toBeGreaterThanOrEqual(3); // 1 proc + 1 sub + 1 ds
      expect(defs.some((d) => d.kind === 'procedure' && d.name === 'ProcessCustomer')).toBe(true);
      expect(defs.some((d) => d.kind === 'subroutine' && d.name === 'InitRoutine')).toBe(true);
      expect(defs.some((d) => d.kind === 'data-structure' && d.name === 'CustomerRec')).toBe(true);
    });

    it('generates dependencies for indexer', () => {
      const program = parser.parse(SAMPLE_RPG_FREE, 'custproc.rpgle');
      const deps = parser.extractDependencies(program);
      expect(deps.length).toBe(1);
      expect(deps[0].type).toBe('copy');
    });
  });
});
