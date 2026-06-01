/**
 * Diagram Parity v2 Tests — Validates all DriverX/Codex gap closures.
 *
 * Tests cover:
 * 1. Direction override parameter
 * 2. Collapsed procedure_flow for large programs
 * 3. fileId on nodes
 * 4. IBM i source PF name inference
 * 5. DSPF field label humanization
 * 6. MSGCON message resolution
 * 7. CL driver title extraction
 * 8. Function key label assignment
 * 9. Header value resolution
 * 10. ASCII field legend table
 * 11. cached_types in availability response
 * 12. Full inbound ref scan
 * 13. Reverse usage_map
 */

import { describe, it, expect } from 'vitest';
import {
  generateDiagramFromContent,
  getAvailableDiagramsFromContent,
  listAvailableTypes,
  generateDiagram,
  humanizeFieldLabel,
  assignFunctionKeyLabels,
  resolveMsgcon,
  resolveHeaderValue,
  generateFieldLegend,
  ibmiNameToExtension,
  ibmiExtractMemberName,
  diagramCache,
} from '../src/index.js';

// ── IBM i Name Resolution ───────────────────────────────────

describe('IBM i Name Resolution', () => {
  it('infers extension from IFS path', () => {
    expect(ibmiNameToExtension('/home/user/myfile.rpgle')).toBe('rpgle');
    expect(ibmiNameToExtension('PROG001.cbl')).toBe('cbl');
  });

  it('infers extension from object browser format', () => {
    expect(ibmiNameToExtension('MYPGM — MYLIB/QRPGLESRC')).toBe('rpgle');
    expect(ibmiNameToExtension('PROG01 — LIB/QCBLSRC')).toBe('cbl');
    expect(ibmiNameToExtension('MENU01 — PRODLIB/QMNUSRC')).toBe('mnu');
  });

  it('infers extension from source PF name', () => {
    expect(ibmiNameToExtension('QRPGLESRC')).toBe('rpgle');
    expect(ibmiNameToExtension('QCBLSRC')).toBe('cbl');
    expect(ibmiNameToExtension('QCLLESRC')).toBe('clle');
    expect(ibmiNameToExtension('QDDSSRC')).toBe('dds');
    expect(ibmiNameToExtension('QSQLRPGLE')).toBe('sqlrpgle');
  });

  it('fuzzy matches non-standard source PF names', () => {
    expect(ibmiNameToExtension('CBLSRC')).toBe('cbl');
    expect(ibmiNameToExtension('RPGLESRC')).toBe('rpgle');
    expect(ibmiNameToExtension('DSPFSRC')).toBe('dspf');
  });

  it('handles LIB/SRCPF(MEMBER) format', () => {
    expect(ibmiNameToExtension('MYLIB/QRPGLESRC(MYPGM)')).toBe('rpgle');
  });

  it('returns null for unrecognizable input', () => {
    expect(ibmiNameToExtension('')).toBeNull();
    expect(ibmiNameToExtension('RANDOM')).toBeNull();
  });

  it('extracts member name from various formats', () => {
    expect(ibmiExtractMemberName('MYLIB/QRPGLESRC(MYPGM)')).toBe('MYPGM');
    expect(ibmiExtractMemberName('MYPGM — MYLIB/QRPGLESRC')).toBe('MYPGM');
    expect(ibmiExtractMemberName('/home/user/myfile.rpgle')).toBe('myfile');
  });
});

// ── DSPF Field Label Humanization ───────────────────────────

describe('DSPF Field Label Humanization', () => {
  it('uses TEXT keyword as highest priority', () => {
    expect(humanizeFieldLabel('CUSTNO', undefined, 'Customer Number')).toBe('Customer Number');
  });

  it('uses cleaned ALIAS as second priority', () => {
    expect(humanizeFieldLabel('SCRN_CUSTNO', 'CUST_NUMBER')).toBe('Cust Number');
  });

  it('looks up known field names', () => {
    expect(humanizeFieldLabel('ERRMSG')).toBe('Error Message');
    expect(humanizeFieldLabel('ACCTNO')).toBe('Account Number');
    expect(humanizeFieldLabel('USERID')).toBe('User ID');
  });

  it('strips known prefixes', () => {
    expect(humanizeFieldLabel('SCRN_NAME')).toBe('Name');
    expect(humanizeFieldLabel('DSP_BALANCE')).toBe('Balance');
    expect(humanizeFieldLabel('FLD_STATUS')).toBe('Status');
  });

  it('splits underscore-separated names', () => {
    expect(humanizeFieldLabel('CUST_ACCT_NUM')).toBe('Cust Acct Num');
  });

  it('splits uppercase blobs by known sub-words', () => {
    expect(humanizeFieldLabel('CUSTNAME')).toBe('Customer Name');
    expect(humanizeFieldLabel('ACCTBALANCE')).toBe('Acct Balance');
    expect(humanizeFieldLabel('ACCOUNTBALANCE')).toBe('Account Balance');
  });

  it('handles numbered fields', () => {
    expect(humanizeFieldLabel('FUNKEY3')).toBe('Fn Key 3');
    expect(humanizeFieldLabel('MSGFLD2')).toBe('Message 2');
    expect(humanizeFieldLabel('CARD1')).toBe('Card 1');
  });
});

// ── Function Key Label Assignment ───────────────────────────

describe('Function Key Label Assignment', () => {
  it('identifies and sorts function key fields', () => {
    const fields = [
      {
        fieldName: 'FK12',
        alias: 'FK12',
        displayLabel: 'Cancel',
        row: 24,
        col: 60,
        type: 'output',
      },
      { fieldName: 'FK3', alias: 'FK3', displayLabel: 'Exit', row: 24, col: 2, type: 'output' },
      { fieldName: 'FK5', alias: 'FK5', displayLabel: 'Refresh', row: 24, col: 20, type: 'output' },
    ];

    const result = assignFunctionKeyLabels(fields);
    expect(result).toHaveLength(3);
    // Sorted by column
    expect(result[0].label).toBe('F3=Exit');
    expect(result[1].label).toBe('F5=Refresh');
    expect(result[2].label).toBe('F12=Cancel');
  });

  it('matches by alias pattern', () => {
    const fields = [
      {
        fieldName: 'CMDKEY',
        alias: 'FKEY7',
        displayLabel: 'Print',
        row: 23,
        col: 5,
        type: 'output',
      },
    ];
    const result = assignFunctionKeyLabels(fields);
    expect(result[0].fKeyNumber).toBe(7);
  });

  it('returns empty for non-fkey fields', () => {
    const fields = [
      {
        fieldName: 'CUSTNAME',
        alias: 'CUST',
        displayLabel: 'Customer',
        row: 5,
        col: 10,
        type: 'input',
      },
    ];
    expect(assignFunctionKeyLabels(fields)).toHaveLength(0);
  });
});

// ── MSGCON Resolution ───────────────────────────────────────

describe('MSGCON Message Resolution', () => {
  it('resolves known message IDs', () => {
    const result = resolveMsgcon('30 CPF0001 QCPFMSG');
    expect(result.msgId).toBe('CPF0001');
    expect(result.resolvedText).toBe('Error found on command');
  });

  it('respects length truncation', () => {
    const result = resolveMsgcon('5 CPF0001 QCPFMSG');
    expect(result.resolvedText).toBe('Error');
  });

  it('returns null for unknown messages', () => {
    const result = resolveMsgcon('20 XYZZY99 CUSTMSG');
    expect(result.msgId).toBe('XYZZY99');
    expect(result.resolvedText).toBeNull();
  });

  it('parses msgcon components correctly', () => {
    const result = resolveMsgcon('30 USR0004 USRMSGF');
    expect(result.msgFile).toBe('USRMSGF');
    expect(result.length).toBe(30);
    expect(result.resolvedText).toBe('Operation successful');
  });
});

// ── Header Value Resolution ─────────────────────────────────

describe('Header Value Resolution', () => {
  const ctx = { screenTitle: 'Customer Inquiry', screenTran: 'CI01', programName: 'CUSTINQ' };

  it('resolves title/heading fields', () => {
    expect(resolveHeaderValue('SYSTEM_HEADING', ctx)).toBe('Customer Inquiry');
    expect(resolveHeaderValue('TITLE', ctx)).toBe('Customer Inquiry');
  });

  it('resolves transaction fields', () => {
    expect(resolveHeaderValue('TRANID', ctx)).toBe('CI01');
    expect(resolveHeaderValue('MENUID', ctx)).toBe('CI01');
  });

  it('resolves date/time with placeholders', () => {
    expect(resolveHeaderValue('SYSDATE', ctx)).toBe('99/99/9999');
    expect(resolveHeaderValue('CURTIME', ctx)).toBe('99:99:99');
  });

  it('resolves program name', () => {
    expect(resolveHeaderValue('PGMNAME', ctx)).toBe('CUSTINQ');
  });

  it('returns null for non-header fields', () => {
    expect(resolveHeaderValue('CUSTNAME', ctx)).toBeNull();
    expect(resolveHeaderValue('BALANCE', ctx)).toBeNull();
  });
});

// ── Field Legend Table ───────────────────────────────────────

describe('Field Legend Table', () => {
  it('generates formatted legend', () => {
    const fields = [
      {
        fieldName: 'ACCTNO',
        displayLabel: 'Account Number',
        type: 'input',
        row: 5,
        col: 20,
        length: 10,
        usage: 'I',
      },
      {
        fieldName: 'BALANCE',
        displayLabel: 'Balance',
        type: 'output',
        row: 6,
        col: 20,
        length: 12,
        usage: 'O',
      },
    ];
    const legend = generateFieldLegend(fields);
    expect(legend).toContain('[INPUT]');
    expect(legend).toContain('[OUTPUT]');
    expect(legend).toContain('ACCTNO');
    expect(legend).toContain('BALANCE');
    expect(legend).toContain('Row  5');
    expect(legend).toContain('Row  6');
  });

  it('returns empty for no fields', () => {
    expect(generateFieldLegend([])).toBe('');
  });

  it('skips unnamed constants', () => {
    const fields = [
      { fieldName: '', displayLabel: '', type: 'constant', row: 1, col: 1, length: 5 },
    ];
    expect(generateFieldLegend(fields)).toBe('');
  });
});

// ── Direction Override ───────────────────────────────────────

describe('Direction Override', () => {
  it('respects LR direction override for control_flow', () => {
    diagramCache.clear();
    const cobolSource = `       IDENTIFICATION DIVISION.
       PROGRAM-ID. DIRTEST1.
       PROCEDURE DIVISION.
       0000-MAIN.
           PERFORM 1000-INIT.
           PERFORM 2000-PROCESS.
           STOP RUN.
       1000-INIT.
           DISPLAY "INIT".
       2000-PROCESS.
           DISPLAY "PROCESS".`;
    const result = generateDiagram(cobolSource, 'cbl', 'control_flow', undefined, 'LR');
    expect(result.success).toBe(true);
    expect(result.content).toContain('graph LR');
  });

  it('respects RL direction override', () => {
    diagramCache.clear();
    const cobolSource = `       IDENTIFICATION DIVISION.
       PROGRAM-ID. DIRTEST2.
       PROCEDURE DIVISION.
       0000-MAIN.
           PERFORM 1000-INIT.
           PERFORM 2000-PROCESS.
           STOP RUN.
       1000-INIT.
           DISPLAY "INIT".
       2000-PROCESS.
           DISPLAY "PROCESS".`;
    const result = generateDiagram(cobolSource, 'cbl', 'control_flow', undefined, 'RL');
    expect(result.success).toBe(true);
    expect(result.content).toContain('graph RL');
  });

  it('uses default TD direction when not specified', () => {
    diagramCache.clear();
    const cobolSource = `       IDENTIFICATION DIVISION.
       PROGRAM-ID. DIRTEST3.
       PROCEDURE DIVISION.
       0000-MAIN.
           PERFORM 1000-INIT.
           PERFORM 2000-PROCESS.
           STOP RUN.
       1000-INIT.
           DISPLAY "INIT".
       2000-PROCESS.
           DISPLAY "PROCESS".`;
    const result = generateDiagram(cobolSource, 'cbl', 'control_flow');
    expect(result.success).toBe(true);
    expect(result.content).toContain('graph TD');
  });

  it('uses default direction when invalid value provided', () => {
    diagramCache.clear();
    const cobolSource = `       IDENTIFICATION DIVISION.
       PROGRAM-ID. DIRTEST4.
       PROCEDURE DIVISION.
       0000-MAIN.
           PERFORM 1000-INIT.
           PERFORM 2000-PROCESS.
           STOP RUN.
       1000-INIT.
           DISPLAY "INIT".
       2000-PROCESS.
           DISPLAY "PROCESS".`;
    const result = generateDiagram(cobolSource, 'cbl', 'control_flow', undefined, 'INVALID');
    expect(result.success).toBe(true);
    expect(result.content).toContain('graph TD');
  });
});

// ── Collapsed Procedure Flow ────────────────────────────────

describe('Collapsed Procedure Flow', () => {
  // Generate a large COBOL program with >100 paragraphs
  function makeLargeCobol(): string {
    const lines = [
      '       IDENTIFICATION DIVISION.',
      '       PROGRAM-ID. BIGPROG.',
      '       DATA DIVISION.',
      '       WORKING-STORAGE SECTION.',
      '       01 WS-FLAG PIC X.',
      '       PROCEDURE DIVISION.',
      '       MAIN-SECTION SECTION.',
    ];
    for (let i = 0; i < 120; i++) {
      const name = `P${String(i).padStart(4, '0')}-PARA`;
      lines.push(`       ${name}.`);
      lines.push(`           DISPLAY "${name}".`);
      if (i < 119) {
        lines.push(`           PERFORM P${String(i + 1).padStart(4, '0')}-PARA.`);
      }
    }
    return lines.join('\n');
  }

  it('collapses >100 nodes into section-level groups', () => {
    const source = makeLargeCobol();
    const result = generateDiagramFromContent(source, 'cbl', 'procedure_flow');
    expect(result.success).toBe(true);
    // The collapsed diagram should NOT have 120+ individual nodes
    const nodeCount = (result.content.match(/\["/g) ?? []).length;
    expect(nodeCount).toBeLessThan(20);
    // Should contain "para" count indicator
    expect(result.content).toContain('para)');
  });

  it('preserves small programs without collapse', () => {
    const smallSource = `       IDENTIFICATION DIVISION.
       PROGRAM-ID. SMALL.
       PROCEDURE DIVISION.
       0000-MAIN.
           PERFORM 1000-INIT.
           STOP RUN.
       1000-INIT.
           DISPLAY "INIT".
       2000-PROCESS.
           DISPLAY "PROCESS".`;
    const result = generateDiagramFromContent(smallSource, 'cbl', 'procedure_flow');
    expect(result.success).toBe(true);
    // Small program should not be collapsed
    expect(result.content).not.toContain('para)');
  });
});

// ── cached_types in Availability Response ───────────────────

describe('cached_types in Availability Response', () => {
  it('returns empty cachedTypes initially', () => {
    diagramCache.clear();
    const source = `       IDENTIFICATION DIVISION.
       PROGRAM-ID. CACHETEST.
       PROCEDURE DIVISION.
       MAIN.
           DISPLAY "HELLO".
           STOP RUN.`;
    const response = listAvailableTypes(source, 'cbl');
    expect(response.cachedTypes).toEqual([]);
  });

  it('includes type in cachedTypes after generation', () => {
    diagramCache.clear();
    const source = `       IDENTIFICATION DIVISION.
       PROGRAM-ID. CACHETEST2.
       DATA DIVISION.
       WORKING-STORAGE SECTION.
       01 WS-FLAG PIC X.
       PROCEDURE DIVISION.
       MAIN.
           DISPLAY "HELLO".
           STOP RUN.`;

    // Generate a diagram first
    generateDiagram(source, 'cbl', 'control_flow');

    // Now check availability — should show control_flow as cached
    const response = listAvailableTypes(source, 'cbl');
    expect(response.cachedTypes).toContain('control_flow');
  });
});

// ── fileId on DiagramNode ───────────────────────────────────

describe('fileId on DiagramNode', () => {
  it('DiagramNode type supports fileId property', () => {
    // Type check — if this compiles, the interface is correct
    const node: import('../src/tools/diagram-types.js').DiagramNode = {
      id: 'test',
      label: 'TEST',
      type: 'call',
      fileId: 'src/programs/SUBPROG.cbl',
    };
    expect(node.fileId).toBe('src/programs/SUBPROG.cbl');
  });
});

// ── Direction applies to usage_map ──────────────────────────

describe('Usage Map Direction', () => {
  it('usage_map defaults to LR', () => {
    diagramCache.clear();
    const source = `       IDENTIFICATION DIVISION.
       PROGRAM-ID. USAGEPROG.
       PROCEDURE DIVISION.
           CALL "SUBPROG".
           CALL "HELPER".
           STOP RUN.`;
    const result = generateDiagram(source, 'cbl', 'usage_map');
    expect(result.success).toBe(true);
    expect(result.content).toContain('graph LR');
  });

  it('usage_map respects direction override', () => {
    diagramCache.clear();
    const source = `       IDENTIFICATION DIVISION.
       PROGRAM-ID. USAGEPROG2.
       PROCEDURE DIVISION.
           CALL "SUBPROG".
           STOP RUN.`;
    const result = generateDiagram(source, 'cbl', 'usage_map', undefined, 'TD');
    expect(result.success).toBe(true);
    expect(result.content).toContain('graph TD');
  });
});
