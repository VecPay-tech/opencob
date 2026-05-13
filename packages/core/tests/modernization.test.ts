import { describe, it, expect } from 'vitest';
import { ModernizationAssistant } from '../src/legacy/modernization-assistant.js';
import { CobolParser } from '../src/legacy/cobol-parser.js';
import { RpgParser } from '../src/legacy/rpg-parser.js';

describe('ModernizationAssistant', () => {
  const assistant = new ModernizationAssistant();

  describe('COBOL → Java entity generation', () => {
    it('generates Java entity from copybook data items', () => {
      const dataItems = [
        { level: 1, name: 'WS-CUSTOMER', line: 1 },
        { level: 5, name: 'WS-CUST-ID', line: 2, picture: '9(5)' },
        { level: 5, name: 'WS-CUST-NAME', line: 3, picture: 'X(30)' },
        { level: 5, name: 'WS-CUST-BALANCE', line: 4, picture: '9(7)V99', usage: 'COMP-3' },
      ];

      const entity = assistant.generateEntityFromCopybook(dataItems, 'CUSTOMER-REC');
      expect(entity.className).toBe('CustomerRec');
      expect(entity.code).toContain('@Entity');
      expect(entity.code).toContain('class CustomerRec');
      expect(entity.fields.length).toBeGreaterThanOrEqual(3);
    });

    it('maps COBOL PIC 9 to int', () => {
      const entity = assistant.generateEntityFromCopybook(
        [{ level: 5, name: 'WS-COUNT', line: 1, picture: '9(5)' }],
        'COUNTER',
      );
      expect(entity.fields[0].javaType).toBe('int');
    });

    it('maps COBOL PIC X to String', () => {
      const entity = assistant.generateEntityFromCopybook(
        [{ level: 5, name: 'WS-NAME', line: 1, picture: 'X(20)' }],
        'NAMES',
      );
      expect(entity.fields[0].javaType).toBe('String');
    });

    it('maps COMP-3 to BigDecimal', () => {
      const entity = assistant.generateEntityFromCopybook(
        [{ level: 5, name: 'WS-AMT', line: 1, picture: '9(9)V99', usage: 'COMP-3' }],
        'AMOUNTS',
      );
      expect(entity.fields[0].javaType).toBe('BigDecimal');
    });

    it('skips FILLER items', () => {
      const entity = assistant.generateEntityFromCopybook(
        [
          { level: 5, name: 'WS-ID', line: 1, picture: '9(5)' },
          { level: 5, name: 'FILLER', line: 2, picture: 'X(10)' },
        ],
        'TEST',
      );
      expect(entity.fields.length).toBe(1);
    });
  });

  describe('RPG → Java entity generation', () => {
    it('generates Java entity from RPG data structure', () => {
      const ds = {
        name: 'CustomerRec',
        line: 5,
        fields: [
          { name: 'custId', type: 'CHAR(5)', line: 6 },
          { name: 'custName', type: 'CHAR(30)', line: 7 },
          { name: 'balance', type: 'PACKED(9:2)', line: 8 },
        ],
      };

      const entity = assistant.generateEntityFromRpgDs(ds);
      expect(entity.className).toBe('Customerrec');
      expect(entity.code).toContain('class Customerrec');
      expect(entity.fields.length).toBe(3);
      expect(entity.fields[0].javaType).toBe('String');
      expect(entity.fields[2].javaType).toBe('BigDecimal');
    });
  });

  describe('Test stub generation', () => {
    it('generates test stubs for COBOL paragraphs', () => {
      const parser = new CobolParser();
      const program = parser.parse(
        `000100 IDENTIFICATION DIVISION.\n000200 PROGRAM-ID. TESTPGM.\n000300 PROCEDURE DIVISION.\n000400 INIT-PARA.\n000500     DISPLAY 'INIT'.\n000600 PROCESS-PARA.\n000700     DISPLAY 'PROCESS'.\n`,
        'TESTPGM.cob',
      );

      const stubs = assistant.generateCobolTestStubs(program);
      expect(stubs.className).toBe('TestpgmTest');
      expect(stubs.testMethods.length).toBeGreaterThanOrEqual(2);
      expect(stubs.code).toContain('@Test');
    });

    it('generates test stubs for RPG procedures', () => {
      const parser = new RpgParser();
      const program = parser.parse(
        `**FREE\nDCL-PROC CalcTotal;\n  RETURN;\nEND-PROC;\nDCL-PROC ValidateInput;\n  RETURN;\nEND-PROC;\n`,
        'calcpgm.rpgle',
      );

      const stubs = assistant.generateRpgTestStubs(program);
      expect(stubs.testMethods.length).toBe(2);
      expect(stubs.code).toContain('@Test');
    });
  });

  describe('Paragraph translation', () => {
    it('translates COBOL paragraph to Java method scaffold', () => {
      const paragraph = {
        name: 'CALC-TOTAL',
        line: 10,
        endLine: 15,
        performedBy: ['MAIN-PARA'],
      };
      const sourceLines = Array.from({ length: 20 }, (_, i) => `     * line ${i + 1}`);
      sourceLines[9] = '      CALC-TOTAL.';
      sourceLines[10] = '          ADD WS-A TO WS-B GIVING WS-TOTAL';
      sourceLines[11] = '          MOVE WS-TOTAL TO WS-RESULT';

      const result = assistant.translateParagraphToJava(paragraph, sourceLines);
      expect(result.sourceLanguage).toBe('cobol');
      expect(result.targetLanguage).toBe('java');
      expect(result.translatedCode).toContain('calcTotal');
      expect(result.translatedCode).toContain('Called by: MAIN-PARA');
    });
  });
});
