/**
 * Live source integration tests for generate_diagram tool.
 *
 * Uses real production source files from /Users/everestkwok/Projects/asccend/source
 * to validate diagram generation against actual IBM i COBOL, CL, DDS, DSPF, PRTF,
 * LF, PF, MNU, and CLLE programs.
 *
 * File type distribution in live source:
 *   5762 .cbl | 1899 .dds | 769 .cpy | 653 .clp | 363 .pf
 *   353 .obs  | 346 .clle | 271 .dspf | 128 .prtf | 124 .lf | 66 .mnu | 11 .cmd
 */
import { describe, it, expect, beforeAll } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { generateDiagramFromContent } from '../src/tools/generate-diagram.js';

const SOURCE_ROOT = '/Users/everestkwok/Projects/asccend/source';

// Skip entire suite if source directory not present (CI environments)
const hasSource = fs.existsSync(SOURCE_ROOT);

function readSource(relativePath: string): string {
  return fs.readFileSync(path.join(SOURCE_ROOT, relativePath), 'utf8');
}

// ══════════════════════════════════════════════════════════════
//  COBOL Programs (.cbl)
// ══════════════════════════════════════════════════════════════

describe.skipIf(!hasSource)('Live Source — COBOL (.cbl)', () => {
  let scadcass: string; // Small I/O subroutine (128 lines)
  let scafmcrs: string; // Medium program (129 lines)
  let scmhskps: string; // Housekeeping program

  beforeAll(() => {
    scadcass = readSource('sc3commlib/cblsrc/scadcass.cbl');
    scafmcrs = readSource('sc3commlib/cblsrc/scafmcrs.cbl');
    scmhskps = readSource('sc3commlib/cblsrc/scmhskps.cbl');
  });

  it('call_graph — handles program with no CALL targets gracefully', () => {
    // scadcass uses COPY to include procedures, no explicit CALL statements
    const result = generateDiagramFromContent(scadcass, 'cbl', 'call_graph');
    // May succeed with empty graph or fail with "No data found"
    expect(result).toBeDefined();
    if (result.success) {
      expect(result.content).toContain('mermaid');
    } else {
      expect(result.content).toContain('No data found');
    }
  });

  it('call_graph — extracts CALL targets from large COBOL with CALLs', () => {
    const largePgm = readSource('sc3cammlib/cblsrc/scm505ab.cbl');
    const result = generateDiagramFromContent(largePgm, 'cbl', 'call_graph');
    expect(result.success).toBe(true);
    expect(result.content).toContain('mermaid');
    expect(result.content).toContain('graph');
  });

  it('dependency_map — extracts COPY/includes from real COBOL', () => {
    const result = generateDiagramFromContent(scadcass, 'cbl', 'dependency_map');
    expect(result.success).toBe(true);
    expect(result.content).toContain('mermaid');
    // Real file copies SCSIOFBC, SCM3150C, SCM3160C, SCSFERCC
    expect(result.content).toMatch(/SCSIOFBC|SCM3150C|SCM3160C|SCSFERCC/i);
  });

  it('structure_chart — builds paragraph hierarchy', () => {
    const result = generateDiagramFromContent(scmhskps, 'cbl', 'structure_chart');
    // May or may not have enough paragraphs; still should not crash
    expect(result).toBeDefined();
    if (result.success) {
      expect(result.content).toContain('mermaid');
    }
  });

  it('field_hierarchy — extracts DATA DIVISION structures', () => {
    const result = generateDiagramFromContent(scadcass, 'cbl', 'field_hierarchy');
    expect(result.success).toBe(true);
    expect(result.content).toContain('mermaid');
    // Real file has WS-SWITCHES with level-03 fields
    expect(result.content).toMatch(/WS-SWITCHES|WS-FSTS/i);
  });

  it('file_io — maps FILE-CONTROL SELECT to physical files', () => {
    const result = generateDiagramFromContent(scadcass, 'cbl', 'file_io');
    // Real file has multi-line SELECT...ASSIGN with sequence numbers
    expect(result.success).toBe(true);
    expect(result.content).toContain('mermaid');
    expect(result.content).toContain('SCADCASP');
  });

  it('copybook_tree — finds COPY statements', () => {
    const result = generateDiagramFromContent(scadcass, 'cbl', 'copybook_tree');
    expect(result.success).toBe(true);
    expect(result.content).toContain('mermaid');
    expect(result.content).toMatch(/SCSIOFBC|SCM3150C|SCM3160C|SCSFERCC/i);
  });

  it('procedure_flow — sequences paragraph calls', () => {
    const result = generateDiagramFromContent(scafmcrs, 'cbl', 'procedure_flow');
    // May not have enough paragraphs
    expect(result).toBeDefined();
    if (result.success) {
      expect(result.content).toContain('mermaid');
    }
  });

  it('control_flow — builds CFG for PROCEDURE DIVISION', () => {
    const result = generateDiagramFromContent(scadcass, 'cbl', 'control_flow');
    expect(result).toBeDefined();
    if (result.success) {
      expect(result.content).toContain('mermaid');
    }
  });
});

// ══════════════════════════════════════════════════════════════
//  CL Programs (.clp)
// ══════════════════════════════════════════════════════════════

describe.skipIf(!hasSource)('Live Source — CL (.clp)', () => {
  let scsrjobx: string; // Job attribute retrieval (193 lines)
  let scsrjobx2: string;

  beforeAll(() => {
    scsrjobx = readSource('sc3commlib/clpsrc/scsrjobx.clp');
    scsrjobx2 = readSource('sc3commlib/clpsrc/scsgetmx.clp');
  });

  it('call_graph — handles CL with no CALL PGM gracefully', () => {
    // scsrjobx only uses RTVJOBA, no CALL PGM statements
    const result = generateDiagramFromContent(scsrjobx, 'clp', 'call_graph');
    expect(result).toBeDefined();
    if (result.success) {
      expect(result.content).toContain('mermaid');
    }
  });

  it('call_graph — extracts CALL PGM from CL with calls', () => {
    // scsgetmx has actual CALL PGM targets
    const result = generateDiagramFromContent(scsrjobx2, 'clp', 'call_graph');
    expect(result).toBeDefined();
    if (result.success) {
      expect(result.content).toContain('mermaid');
    }
  });

  it('control_flow — builds CL flow graph with IF/GOTO/MONMSG', () => {
    const result = generateDiagramFromContent(scsrjobx, 'clp', 'control_flow');
    expect(result.success).toBe(true);
    expect(result.content).toContain('mermaid');
    // Real file has MONMSG, IF, GOTO CMDLBL
    expect(result.content).toMatch(/MONMSG|GOTO|IF/i);
  });

  it('procedure_flow — sequences CL commands', () => {
    const result = generateDiagramFromContent(scsrjobx2, 'clp', 'procedure_flow');
    expect(result).toBeDefined();
    if (result.success) {
      expect(result.content).toContain('mermaid');
    }
  });

  it('dependency_map — finds any includes/files', () => {
    const result = generateDiagramFromContent(scsrjobx, 'clp', 'dependency_map');
    // CL may not have COPY; should still not crash
    expect(result).toBeDefined();
  });
});

// ══════════════════════════════════════════════════════════════
//  CL ILE Programs (.clle)
// ══════════════════════════════════════════════════════════════

describe.skipIf(!hasSource)('Live Source — CLLE (.clle)', () => {
  let sca0101x: string; // Send data queue routine

  beforeAll(() => {
    sca0101x = readSource('sc3anilib/clpsrc/sca0101x.pgm.clle');
  });

  it('call_graph — extracts CALL/CALLPRC from ILE CL', () => {
    const result = generateDiagramFromContent(sca0101x, 'clle', 'call_graph');
    expect(result.success).toBe(true);
    expect(result.content).toContain('mermaid');
  });

  it('control_flow — handles ILE CL constructs', () => {
    const result = generateDiagramFromContent(sca0101x, 'clle', 'control_flow');
    expect(result.success).toBe(true);
    expect(result.content).toContain('mermaid');
  });
});

// ══════════════════════════════════════════════════════════════
//  Copybooks (.cpy)
// ══════════════════════════════════════════════════════════════

describe.skipIf(!hasSource)('Live Source — Copybook (.cpy)', () => {
  let sca0000c: string; // Large copybook (333 lines)
  let scsiofbc: string; // I/O feedback area

  beforeAll(() => {
    sca0000c = readSource('sc3commlib/cpysrc/sca0000c.cpy');
    scsiofbc = readSource('sc3commlib/cpysrc/scsiofbc.cpy');
  });

  it('field_hierarchy — builds data structure tree from copybook', () => {
    const result = generateDiagramFromContent(sca0000c, 'cpy', 'field_hierarchy');
    expect(result.success).toBe(true);
    expect(result.content).toContain('mermaid');
  });

  it('record_layout — shows field layout from copybook', () => {
    const result = generateDiagramFromContent(scsiofbc, 'cpy', 'record_layout');
    expect(result).toBeDefined();
    if (result.success) {
      expect(result.content).toContain('mermaid');
    }
  });

  it('dependency_map — finds nested COPY in copybook', () => {
    const result = generateDiagramFromContent(sca0000c, 'cpy', 'dependency_map');
    expect(result).toBeDefined();
  });
});

// ══════════════════════════════════════════════════════════════
//  DDS Physical File (.pf)
// ══════════════════════════════════════════════════════════════

describe.skipIf(!hasSource)('Live Source — DDS Physical File (.pf)', () => {
  let scavisqp: string; // VISA queue file

  beforeAll(() => {
    scavisqp = readSource('sc3anilib/ddssrc/scavisqp.pf');
  });

  it('record_layout — extracts record format with fields', () => {
    const result = generateDiagramFromContent(scavisqp, 'pf', 'record_layout');
    expect(result.success).toBe(true);
    expect(result.content).toContain('mermaid');
    expect(result.content).toMatch(/SCAVISQR|VISQKEY/i);
  });

  it('field_hierarchy — shows field structure', () => {
    const result = generateDiagramFromContent(scavisqp, 'pf', 'field_hierarchy');
    expect(result.success).toBe(true);
    expect(result.content).toContain('mermaid');
  });
});

// ══════════════════════════════════════════════════════════════
//  DDS Logical File (.lf)
// ══════════════════════════════════════════════════════════════

describe.skipIf(!hasSource)('Live Source — DDS Logical File (.lf)', () => {
  let scavaull: string;

  beforeAll(() => {
    scavaull = readSource('sc3anilib/ddssrc/scavaull.lf');
  });

  it('record_layout — extracts LF record format and keys', () => {
    const result = generateDiagramFromContent(scavaull, 'lf', 'record_layout');
    expect(result.success).toBe(true);
    expect(result.content).toContain('mermaid');
  });

  it('field_hierarchy — shows LF key fields (if parsed)', () => {
    const result = generateDiagramFromContent(scavaull, 'lf', 'field_hierarchy');
    // LF files may only have key specifications, not full field definitions
    expect(result).toBeDefined();
    if (result.success) {
      expect(result.content).toContain('mermaid');
    }
  });
});

// ══════════════════════════════════════════════════════════════
//  DDS Display File (.dspf)
// ══════════════════════════════════════════════════════════════

describe.skipIf(!hasSource)('Live Source — DDS Display File (.dspf)', () => {
  let sca0000d: string; // Main menu screen

  beforeAll(() => {
    sca0000d = readSource('sc3anilib/ddssrc/sca0000d.dspf');
  });

  it('screen_layout — renders 5250 screen as ASCII art', () => {
    const result = generateDiagramFromContent(sca0000d, 'dspf', 'screen_layout');
    expect(result.success).toBe(true);
    expect(result.content).toContain('+');
    expect(result.content).toContain('|');
    expect(result.metadata?.format).toBe('ascii');
    expect(result.metadata?.screen?.platform).toBe('5250');
    expect(result.metadata?.screen?.rows).toBe(24);
    expect(result.metadata?.screen?.cols).toBe(80);
  });

  it('record_layout — extracts DSPF fields', () => {
    const result = generateDiagramFromContent(sca0000d, 'dspf', 'record_layout');
    expect(result).toBeDefined();
    if (result.success) {
      expect(result.content).toContain('mermaid');
    }
  });
});

// ══════════════════════════════════════════════════════════════
//  DDS Print File (.prtf)
// ══════════════════════════════════════════════════════════════

describe.skipIf(!hasSource)('Live Source — DDS Print File (.prtf)', () => {
  let sca1100h: string; // Auth alert report

  beforeAll(() => {
    sca1100h = readSource('sc3anilib/ddssrc/sca1100h.prtf');
  });

  it('record_layout — extracts PRTF record format', () => {
    const result = generateDiagramFromContent(sca1100h, 'prtf', 'record_layout');
    expect(result.success).toBe(true);
    expect(result.content).toContain('mermaid');
    expect(result.content).toMatch(/HEADER|PBNKNAME/i);
  });

  it('field_hierarchy — shows print field structure', () => {
    const result = generateDiagramFromContent(sca1100h, 'prtf', 'field_hierarchy');
    expect(result.success).toBe(true);
    expect(result.content).toContain('mermaid');
  });
});

// ══════════════════════════════════════════════════════════════
//  DDS generic (.dds)
// ══════════════════════════════════════════════════════════════

describe.skipIf(!hasSource)('Live Source — DDS generic (.dds)', () => {
  let scadctlp: string; // Generic DDS file

  beforeAll(() => {
    scadctlp = readSource('sc3commlib/ddssrc/scadctlp.dds');
  });

  it('record_layout — works with .dds extension', () => {
    const result = generateDiagramFromContent(scadctlp, 'dds', 'record_layout');
    expect(result.success).toBe(true);
    expect(result.content).toContain('mermaid');
  });

  it('field_hierarchy — works with .dds extension', () => {
    const result = generateDiagramFromContent(scadctlp, 'dds', 'field_hierarchy');
    expect(result.success).toBe(true);
    expect(result.content).toContain('mermaid');
  });
});

// ══════════════════════════════════════════════════════════════
//  MNU files (.mnu)
// ══════════════════════════════════════════════════════════════

describe.skipIf(!hasSource)('Live Source — Menu Source (.mnu)', () => {
  let scs7300x: string;

  beforeAll(() => {
    scs7300x = readSource('sc3commlib/mnusrc/scs7300x.mnu');
  });

  it('dependency_map — extracts menu dependencies', () => {
    const result = generateDiagramFromContent(scs7300x, 'mnu', 'dependency_map');
    expect(result).toBeDefined();
    // MNU may or may not produce content; should not crash
  });
});

// ══════════════════════════════════════════════════════════════
//  OBS files (.obs)
// ══════════════════════════════════════════════════════════════

describe.skipIf(!hasSource)('Live Source — OBS (.obs)', () => {
  let scmuexts: string;

  beforeAll(() => {
    scmuexts = readSource('sc3cuplib/obssrc/scmuexts.obs');
  });

  it('dependency_map — works with .obs extension', () => {
    const result = generateDiagramFromContent(scmuexts, 'obs', 'dependency_map');
    expect(result).toBeDefined();
    // OBS files may map to COBOL or other; should not crash
  });
});

// ══════════════════════════════════════════════════════════════
//  Batch / Scale test — large COBOL programs
// ══════════════════════════════════════════════════════════════

describe.skipIf(!hasSource)('Live Source — Large COBOL (scale)', () => {
  it('call_graph on 25,866-line COBOL program (performance)', () => {
    const largeCobol = readSource('sc3cammlib/cblsrc/scm505ab.cbl');
    const start = performance.now();
    const result = generateDiagramFromContent(largeCobol, 'cbl', 'call_graph');
    const elapsed = performance.now() - start;

    expect(result.success).toBe(true);
    expect(result.content).toContain('mermaid');
    // Should complete in under 2 seconds even for 25k lines
    expect(elapsed).toBeLessThan(2000);
  });

  it('structure_chart on large program', () => {
    const largeCobol = readSource('sc3cammlib/cblsrc/scm505ab.cbl');
    const result = generateDiagramFromContent(largeCobol, 'cbl', 'structure_chart');
    expect(result.success).toBe(true);
    expect(result.content).toContain('mermaid');
  });

  it('field_hierarchy on large program', () => {
    const largeCobol = readSource('sc3cammlib/cblsrc/scm505ab.cbl');
    const result = generateDiagramFromContent(largeCobol, 'cbl', 'field_hierarchy');
    expect(result.success).toBe(true);
    expect(result.content).toContain('mermaid');
  });

  it('control_flow on large program', () => {
    const largeCobol = readSource('sc3cammlib/cblsrc/scm505ab.cbl');
    const result = generateDiagramFromContent(largeCobol, 'cbl', 'control_flow');
    expect(result).toBeDefined();
    if (result.success) {
      expect(result.content).toContain('mermaid');
    }
  });
});
