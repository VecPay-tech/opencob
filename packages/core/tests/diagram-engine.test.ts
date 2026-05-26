import { describe, it, expect } from 'vitest';
import {
  classifyExtension,
  getAvailableDiagramTypes,
  FILE_TYPES,
  DIAGRAM_TYPES,
  ALL_LEGACY_EXTS,
  COBOL_EXTS,
  CL_EXTS,
  RPG_EXTS,
} from '../src/tools/diagram-types.js';
import { parseControlFlow, parseClControlFlow } from '../src/tools/flow-parser.js';

describe('diagram-types', () => {
  describe('classifyExtension', () => {
    it('classifies COBOL extensions', () => {
      const info = classifyExtension('cbl');
      expect(info).toBeDefined();
      expect(info!.category).toBe('program');
      expect(info!.platform).toBe('as400');
      expect(info!.language).toBe('cobol');
    });

    it('classifies CL extensions', () => {
      const info = classifyExtension('clle');
      expect(info).toBeDefined();
      expect(info!.category).toBe('program');
      expect(info!.language).toBe('cl');
    });

    it('classifies DDS extensions', () => {
      const info = classifyExtension('pf');
      expect(info).toBeDefined();
      expect(info!.category).toBe('dds');
      expect(info!.language).toBe('dds');
    });

    it('classifies screen extensions', () => {
      const info = classifyExtension('dspf');
      expect(info).toBeDefined();
      expect(info!.category).toBe('screen');
    });

    it('classifies RPG extensions', () => {
      const info = classifyExtension('rpgle');
      expect(info).toBeDefined();
      expect(info!.category).toBe('program');
      expect(info!.language).toBe('rpg');
    });

    it('returns undefined for unknown extensions', () => {
      expect(classifyExtension('xyz')).toBeUndefined();
      expect(classifyExtension('ts')).toBeUndefined();
    });

    it('strips leading dot', () => {
      expect(classifyExtension('.cob')).toBeDefined();
      expect(classifyExtension('.cob')!.language).toBe('cobol');
    });
  });

  describe('getAvailableDiagramTypes', () => {
    it('returns program diagrams for COBOL', () => {
      const types = getAvailableDiagramTypes('cob');
      expect(types).toContain('call_graph');
      expect(types).toContain('procedure_flow');
      expect(types).toContain('control_flow');
      expect(types).toContain('field_hierarchy');
    });

    it('returns copybook diagrams for copybook extensions', () => {
      const types = getAvailableDiagramTypes('cpy');
      expect(types).toContain('record_layout');
      expect(types).toContain('field_hierarchy');
    });

    it('returns screen diagrams for display files', () => {
      const types = getAvailableDiagramTypes('dspf');
      expect(types).toContain('screen_layout');
    });

    it('returns empty for unknown extensions', () => {
      expect(getAvailableDiagramTypes('js')).toEqual([]);
    });
  });

  describe('FILE_TYPES completeness', () => {
    it('covers all extensions in ALL_LEGACY_EXTS', () => {
      for (const ext of ALL_LEGACY_EXTS) {
        expect(FILE_TYPES[ext]).toBeDefined();
      }
    });

    it('has 25+ known extensions', () => {
      expect(Object.keys(FILE_TYPES).length).toBeGreaterThanOrEqual(25);
    });
  });
});

describe('flow-parser', () => {
  describe('parseControlFlow (COBOL)', () => {
    it('generates start and end nodes for empty input', () => {
      const result = parseControlFlow([], 1, 'MAIN');
      expect(result.nodes.length).toBe(2);
      expect(result.nodes[0].type).toBe('terminal');
      expect(result.nodes[0].label).toBe('MAIN');
      expect(result.nodes[1].type).toBe('terminal');
      expect(result.nodes[1].label).toBe('END');
    });

    it('creates process nodes for simple statements', () => {
      const lines = ['MOVE "A" TO WS-FIELD', 'DISPLAY WS-FIELD'];
      const result = parseControlFlow(lines, 10, 'PROCESS-DATA');
      expect(result.nodes.length).toBeGreaterThanOrEqual(3); // START + process + END
      expect(result.nodes[0].label).toBe('PROCESS-DATA');
      const processNodes = result.nodes.filter((n) => n.type === 'process');
      expect(processNodes.length).toBeGreaterThanOrEqual(1);
    });

    it('generates decision node for IF/ELSE/END-IF', () => {
      const lines = [
        'IF WS-STATUS = "OK"',
        '  MOVE 1 TO WS-CODE',
        'ELSE',
        '  MOVE 2 TO WS-CODE',
        'END-IF',
      ];
      const result = parseControlFlow(lines, 1, 'CHECK-STATUS');
      const decisions = result.nodes.filter((n) => n.type === 'decision');
      expect(decisions.length).toBe(1);
      expect(decisions[0].label).toContain('WS-STATUS');

      const trueEdges = result.edges.filter((e) => e.edgeType === 'true');
      const falseEdges = result.edges.filter((e) => e.edgeType === 'false');
      expect(trueEdges.length).toBeGreaterThanOrEqual(1);
      expect(falseEdges.length).toBeGreaterThanOrEqual(1);
    });

    it('generates decision node for EVALUATE/WHEN', () => {
      const lines = [
        'EVALUATE WS-ACTION',
        '  WHEN "ADD"',
        '    PERFORM ADD-RECORD',
        '  WHEN "DELETE"',
        '    PERFORM DELETE-RECORD',
        '  WHEN OTHER',
        '    PERFORM ERROR-HANDLER',
        'END-EVALUATE',
      ];
      const result = parseControlFlow(lines, 1, 'DISPATCH');
      const decisions = result.nodes.filter((n) => n.type === 'decision');
      expect(decisions.length).toBe(1);
      expect(decisions[0].label).toContain('EVALUATE');

      const whenEdges = result.edges.filter((e) => e.edgeType === 'when');
      expect(whenEdges.length).toBe(3);
    });

    it('generates call node for PERFORM paragraph', () => {
      const lines = ['PERFORM INIT-DATA', 'PERFORM PROCESS-RECORDS'];
      const result = parseControlFlow(lines, 1, 'MAIN-LOGIC');
      const callNodes = result.nodes.filter((n) => n.type === 'call');
      expect(callNodes.length).toBe(2);
      expect(callNodes[0].label).toContain('INIT-DATA');
      expect(callNodes[1].label).toContain('PROCESS-RECORDS');
    });

    it('generates loop node for PERFORM UNTIL', () => {
      const lines = ['PERFORM READ-NEXT UNTIL WS-EOF = "Y"'];
      const result = parseControlFlow(lines, 1, 'LOOP-PARA');
      const loopNodes = result.nodes.filter((n) => n.type === 'loop');
      expect(loopNodes.length).toBe(1);
      expect(loopNodes[0].label).toContain('UNTIL');
    });

    it('generates goto node for GO TO', () => {
      const lines = ['GO TO EXIT-PARAGRAPH'];
      const result = parseControlFlow(lines, 1, 'ERROR-HANDLER');
      const gotoNodes = result.nodes.filter((n) => n.type === 'goto');
      expect(gotoNodes.length).toBe(1);
      expect(gotoNodes[0].label).toContain('EXIT-PARAGRAPH');
      const gotoEdges = result.edges.filter((e) => e.edgeType === 'goto');
      expect(gotoEdges.length).toBe(1);
    });

    it('generates io node for READ/WRITE', () => {
      const lines = ['READ INPUT-FILE INTO WS-RECORD', 'WRITE OUTPUT-RECORD FROM WS-DATA'];
      const result = parseControlFlow(lines, 1, 'IO-PARA');
      const ioNodes = result.nodes.filter((n) => n.type === 'io');
      expect(ioNodes.length).toBe(2);
    });

    it('generates terminal node for STOP RUN', () => {
      const lines = ['DISPLAY "DONE"', 'STOP RUN'];
      const result = parseControlFlow(lines, 1, 'FINAL');
      const terminals = result.nodes.filter((n) => n.type === 'terminal' && n.label === 'STOP');
      expect(terminals.length).toBe(1);
    });

    it('handles nested IF', () => {
      const lines = ['IF A = 1', '  IF B = 2', '    MOVE "X" TO C', '  END-IF', 'END-IF'];
      const result = parseControlFlow(lines, 1, 'NESTED');
      const decisions = result.nodes.filter((n) => n.type === 'decision');
      expect(decisions.length).toBe(2);
    });
  });

  describe('parseClControlFlow', () => {
    it('generates start and end for empty input', () => {
      const result = parseClControlFlow([], 1, 'MYPGM');
      expect(result.nodes.length).toBe(2);
      expect(result.nodes[0].label).toBe('MYPGM');
      expect(result.nodes[1].label).toBe('END');
    });

    it('handles IF COND THEN(DO)/ENDDO', () => {
      const lines = ['IF COND(&STATUS *EQ "OK") THEN(DO)', '  CHGVAR &CODE VALUE(1)', 'ENDDO'];
      const result = parseClControlFlow(lines, 1, 'CHECKPGM');
      const decisions = result.nodes.filter((n) => n.type === 'decision');
      expect(decisions.length).toBe(1);
      expect(decisions[0].label).toContain('IF');
    });

    it('handles CALL PGM', () => {
      const lines = ['CALL PGM(MYLIB/MYPGM) PARM(&P1 &P2)'];
      const result = parseClControlFlow(lines, 1, 'CALLER');
      const callNodes = result.nodes.filter((n) => n.type === 'call');
      expect(callNodes.length).toBe(1);
      expect(callNodes[0].label).toContain('MYPGM');
    });

    it('handles GOTO CMDLBL', () => {
      const lines = ['GOTO CMDLBL(ERROR)'];
      const result = parseClControlFlow(lines, 1, 'TEST');
      const gotoNodes = result.nodes.filter((n) => n.type === 'goto');
      expect(gotoNodes.length).toBe(1);
      expect(gotoNodes[0].label).toContain('ERROR');
    });

    it('handles DOWHILE loop', () => {
      const lines = ['DOWHILE COND(&EOF *NE "1")', '  CALL PGM(READNEXT)', 'ENDDO'];
      const result = parseClControlFlow(lines, 1, 'LOOP');
      const loopNodes = result.nodes.filter((n) => n.type === 'loop');
      expect(loopNodes.length).toBe(1);
      expect(loopNodes[0].label).toContain('DOWHILE');
    });

    it('handles labels', () => {
      const lines = ['ERROR:  SNDPGMMSG MSG("Error occurred")'];
      const result = parseClControlFlow(lines, 1, 'PGM');
      const mergeNodes = result.nodes.filter(
        (n) => n.type === 'merge' && n.label.includes('ERROR'),
      );
      expect(mergeNodes.length).toBe(1);
    });
    it('handles CALLPRC', () => {
      const lines = ['CALLPRC PRC(VALIDATECUST)'];
      const result = parseClControlFlow(lines, 1, 'PGM');
      const callNodes = result.nodes.filter((n) => n.type === 'call');
      expect(callNodes.length).toBe(1);
      expect(callNodes[0].label).toContain('VALIDATECUST');
    });

    it('handles SBMJOB CMD(CALL PGM(...))', () => {
      const lines = ['SBMJOB CMD(CALL PGM(BATCHPGM)) JOB(NIGHTLY)'];
      const result = parseClControlFlow(lines, 1, 'PGM');
      const callNodes = result.nodes.filter((n) => n.type === 'call');
      expect(callNodes.length).toBe(1);
      expect(callNodes[0].label).toContain('BATCHPGM');
    });

    it('handles MONMSG with EXEC(GOTO)', () => {
      const lines = ['MONMSG MSGID(CPF0000) EXEC(GOTO CMDLBL(ERROR))'];
      const result = parseClControlFlow(lines, 1, 'PGM');
      const decisions = result.nodes.filter((n) => n.type === 'decision');
      expect(decisions.length).toBe(1);
      expect(decisions[0].label).toContain('MONMSG');
      expect(decisions[0].label).toContain('GOTO ERROR');
    });

    it('handles MONMSG without EXEC', () => {
      const lines = ['MONMSG MSGID(CPF0000)'];
      const result = parseClControlFlow(lines, 1, 'PGM');
      const processNodes = result.nodes.filter(
        (n) => n.type === 'process' && n.label.includes('MONMSG'),
      );
      expect(processNodes.length).toBe(1);
    });

    it('handles SUBR / ENDSUBR', () => {
      const lines = ['SUBR SUBR(CLEANUP)', '  CALL PGM(CLNPGM)', 'ENDSUBR'];
      const result = parseClControlFlow(lines, 1, 'PGM');
      const callNodes = result.nodes.filter((n) => n.type === 'call');
      expect(callNodes.some((n) => n.label.includes('CLEANUP'))).toBe(true);
      const termNodes = result.nodes.filter(
        (n) => n.type === 'terminal' && n.label.includes('ENDSUBR'),
      );
      expect(termNodes.length).toBe(1);
    });

    it('handles RETURN', () => {
      const lines = ['RETURN'];
      const result = parseClControlFlow(lines, 1, 'PGM');
      const termNodes = result.nodes.filter((n) => n.type === 'terminal' && n.label === 'RETURN');
      expect(termNodes.length).toBe(1);
    });

    it('handles simple IF THEN(command) without DO', () => {
      const lines = ['IF COND(&ERR *EQ "1") THEN(GOTO CMDLBL(EXIT))'];
      const result = parseClControlFlow(lines, 1, 'PGM');
      const decisions = result.nodes.filter((n) => n.type === 'decision');
      expect(decisions.length).toBe(1);
      const processNodes = result.nodes.filter((n) => n.type === 'process');
      expect(processNodes.length).toBeGreaterThanOrEqual(1);
    });

    it('handles IF/ELSE/ENDDO block', () => {
      const lines = [
        'IF COND(&ACTION *EQ "A") THEN(DO)',
        '  CALL PGM(ADDPGM)',
        'ELSE CMD(CALL PGM(DELPGM))',
        'ENDDO',
      ];
      const result = parseClControlFlow(lines, 1, 'PGM');
      const decisions = result.nodes.filter((n) => n.type === 'decision');
      expect(decisions.length).toBe(1);
      const callNodes = result.nodes.filter((n) => n.type === 'call');
      expect(callNodes.length).toBeGreaterThanOrEqual(1);
    });

    it('handles DOUNTIL loop', () => {
      const lines = ['DOUNTIL COND(&DONE *EQ "Y")', '  CALL PGM(PROCESS)', 'ENDDO'];
      const result = parseClControlFlow(lines, 1, 'PGM');
      const loopNodes = result.nodes.filter((n) => n.type === 'loop');
      expect(loopNodes.length).toBe(1);
      expect(loopNodes[0].label).toContain('DOUNTIL');
    });
  });
});

// ══════════════════════════════════════════════════════════════
//  BMS Parser Tests
// ══════════════════════════════════════════════════════════════

import { parseBmsMap } from '../src/legacy/bms-parser.js';

describe('bms-parser', () => {
  it('parses mapset and map definitions', () => {
    const bms = `MYMAPS   DFHMSD TYPE=MAP,MODE=INOUT
MAP1     DFHMDI SIZE=(24,80)
FLD1     DFHMDF POS=(3,10),LENGTH=20,ATTRB=(UNPROT,BRT)
FLD2     DFHMDF POS=(5,10),LENGTH=15,ATTRB=(PROT),INITIAL='HELLO'
`;
    const result = parseBmsMap(bms);
    expect(result.mapsetName).toBe('MYMAPS');
    expect(result.maps).toHaveLength(1);
    expect(result.maps[0].name).toBe('MAP1');
    expect(result.fields).toHaveLength(2);
  });

  it('extracts field positions and attributes', () => {
    const bms = `TESTMS   DFHMSD TYPE=MAP
TESTMP   DFHMDI SIZE=(24,80)
ACCTNO   DFHMDF POS=(5,20),LENGTH=10,ATTRB=(UNPROT,NUM)
LABEL1   DFHMDF POS=(3,5),LENGTH=8,ATTRB=(ASKIP),INITIAL='ACCOUNT'
`;
    const result = parseBmsMap(bms);
    const acctField = result.fields.find((f) => f.fieldName === 'ACCTNO');
    expect(acctField).toBeDefined();
    expect(acctField!.row).toBe(5);
    expect(acctField!.col).toBe(20);
    expect(acctField!.length).toBe(10);
    expect(acctField!.attrb).toContain('UNPROT');

    const labelField = result.fields.find((f) => f.fieldName === 'LABEL1');
    expect(labelField).toBeDefined();
    expect(labelField!.initialVal).toBe('ACCOUNT');
  });

  it('handles continuation lines', () => {
    const bms = `TESTMS   DFHMSD TYPE=MAP                                               X
               MODE=INOUT
TESTMP   DFHMDI SIZE=(24,80)
FLD1     DFHMDF POS=(1,1),LENGTH=5
`;
    const result = parseBmsMap(bms);
    expect(result.mapsetName).toBe('TESTMS');
    expect(result.fields).toHaveLength(1);
  });
});

// ══════════════════════════════════════════════════════════════
//  DDS Parser Tests
// ══════════════════════════════════════════════════════════════

import { parseDds } from '../src/legacy/dds-parser.js';

describe('dds-parser', () => {
  it('parses PF record format and fields', () => {
    const dds = `     A          R CUSTREC
     A            CUSTNO         5S 0       TEXT('Customer Number')
     A            CUSTNM        30A         TEXT('Customer Name')
     A            CUSTCI        20A         TEXT('City')
     A          K CUSTNO
`;
    const result = parseDds(dds, '/test/CUSTMST.pf');
    expect(result.fileType).toBe('pf');
    expect(result.records).toHaveLength(1);
    expect(result.records[0].name).toBe('CUSTREC');
    expect(result.records[0].keys).toContain('CUSTNO');
    expect(result.records[0].fields.length).toBeGreaterThanOrEqual(2);
  });

  it('parses DSPF display file with screen positions', () => {
    const dds = `     A                                      DSPSIZ(24 80)
     A          R SCRN01
     A                                  3 10'Customer Inquiry'
     A            CUSTNO    R        B  5 10REFFLD(CUSTNO CUSTMST)
     A            CUSTNM         30A  O  7 10
`;
    const result = parseDds(dds, '/test/CUSTINQ.dspf');
    expect(result.fileType).toBe('dspf');
    expect(result.screenMeta).toBeDefined();
    expect(result.screenMeta!.rows).toBe(24);
    expect(result.screenMeta!.cols).toBe(80);
    expect(result.records).toHaveLength(1);

    const positioned = result.allFields.filter((f) => f.row !== null);
    expect(positioned.length).toBeGreaterThanOrEqual(1);
  });

  it('extracts REFFLD references', () => {
    const dds = `     A          R ORDREC
     A            ORDNO     R           REFFLD(ORDNO ORDMST)
`;
    const result = parseDds(dds, '/test/ORDSCR.dspf');
    expect(result.references.length).toBeGreaterThanOrEqual(1);
    const reffld = result.references.find((r) => r.type === 'reffld');
    expect(reffld).toBeDefined();
    expect(reffld!.target).toBe('ORDMST');
  });

  it('returns null fileType for unknown extensions gracefully', () => {
    const result = parseDds('', '/test/FILE.dds');
    expect(result.fileType).toBe('dds');
    expect(result.records).toHaveLength(0);
  });
});

// ══════════════════════════════════════════════════════════════
//  Content-based Diagram Generation Tests
// ══════════════════════════════════════════════════════════════

import { generateDiagramFromContent } from '../src/tools/generate-diagram.js';

describe('generateDiagramFromContent', () => {
  it('generates a call_graph from COBOL content', () => {
    const cobol = `       IDENTIFICATION DIVISION.
       PROGRAM-ID. TESTPGM.
       PROCEDURE DIVISION.
           CALL 'SUBPGM1'.
           CALL 'SUBPGM2'.
           STOP RUN.
`;
    const result = generateDiagramFromContent(cobol, 'cbl', 'call_graph');
    expect(result.success).toBe(true);
    expect(result.content).toContain('mermaid');
    expect(result.metadata?.format).toBe('mermaid');
  });

  it('generates screen_layout ASCII from BMS content', () => {
    const bms = `MYMAPS   DFHMSD TYPE=MAP,MODE=INOUT
MAP1     DFHMDI SIZE=(24,80)
FLD1     DFHMDF POS=(3,10),LENGTH=20,ATTRB=(UNPROT,BRT)
LABEL    DFHMDF POS=(1,5),LENGTH=7,ATTRB=(ASKIP),INITIAL='WELCOME'
`;
    const result = generateDiagramFromContent(bms, 'map', 'screen_layout');
    expect(result.success).toBe(true);
    expect(result.metadata?.format).toBe('ascii');
    expect(result.content).toContain('+');
    expect(result.content).toContain('|');
    expect(result.metadata?.platform).toBe('mainframe');
  });

  it('returns error for invalid diagram type', () => {
    const cobol = `       IDENTIFICATION DIVISION.
       PROGRAM-ID. TESTPGM.
`;
    const result = generateDiagramFromContent(cobol, 'cbl', 'screen_layout' as any);
    expect(result.success).toBe(false);
    expect(result.content).toContain('not available');
  });

  it('returns error for unrecognized extension', () => {
    const result = generateDiagramFromContent('hello', 'xyz', 'call_graph');
    expect(result.success).toBe(false);
    expect(result.content).toContain('unrecognized');
  });
});
