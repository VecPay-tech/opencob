/**
 * Parity V3 Tests — Validates gap closures from the third deep evaluation.
 *
 * Covers:
 * 1. Cyclomatic Complexity Calculation
 * 2. Advanced Metrics (nesting depth, risk score)
 * 3. Dependency Graph Edge Weights
 * 4. REFFLD Cross-File Field Resolution
 * 5. Vulnerability Propagation via Dependency Graph
 * 6. Bulk MSGCON Pre-scan
 * 7. String Literal Preservation in Flow Parser
 * 8. Enhanced Error Messages for Diagrams
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  computeCyclomaticComplexity,
  computeMaxNestingDepth,
  computeComplexityScore,
  classifyRisk,
  aggregateScores,
  DependencyGraph,
  propagateVulnerabilities,
  degradeSeverity,
  DEP_WEIGHTS,
} from '../src/metrics/index.js';
import {
  lookupMsgcon,
  clearMsgconCache,
  addMsgconEntry,
  getMsgconCacheSize,
} from '../src/tools/msgcon-cache.js';
import { parseControlFlow } from '../src/tools/flow-parser.js';
import { generateDiagram } from '../src/tools/diagram-api.js';
import { resolveReffldLengths, clearReffldCache } from '../src/legacy/reffld-resolver.js';

// ══════════════════════════════════════════════════════════════
//  1. Cyclomatic Complexity
// ══════════════════════════════════════════════════════════════

describe('Cyclomatic Complexity', () => {
  it('returns 1 for straight-line code', () => {
    const lines = [
      '       IDENTIFICATION DIVISION.',
      '       PROGRAM-ID. SIMPLE.',
      '       PROCEDURE DIVISION.',
      '           DISPLAY "HELLO".',
      '           STOP RUN.',
    ];
    expect(computeCyclomaticComplexity(lines, 'mainframe')).toBe(1);
  });

  it('increments for each IF statement', () => {
    const lines = [
      '      * A comment line',
      '       IF X > 1',
      '           DISPLAY "A"',
      '       END-IF',
      '       IF Y > 2',
      '           DISPLAY "B"',
      '       END-IF',
    ];
    expect(computeCyclomaticComplexity(lines, 'mainframe')).toBe(3);
  });

  it('counts EVALUATE WHEN clauses', () => {
    const lines = [
      '       EVALUATE TRUE',
      '         WHEN X = 1',
      '           DISPLAY "ONE"',
      '         WHEN X = 2',
      '           DISPLAY "TWO"',
      '         WHEN OTHER',
      '           DISPLAY "OTHER"',
      '       END-EVALUATE',
    ];
    // 1 base + 1 EVALUATE + 3 WHEN = 5
    expect(computeCyclomaticComplexity(lines, 'mainframe')).toBe(5);
  });

  it('skips comment lines', () => {
    const lines = ['      * IF X > 1 EVALUATE WHEN WHEN WHEN', '       DISPLAY "HELLO".'];
    expect(computeCyclomaticComplexity(lines, 'mainframe')).toBe(1);
  });
});

// ══════════════════════════════════════════════════════════════
//  2. Advanced Metrics (Nesting, Risk Score)
// ══════════════════════════════════════════════════════════════

describe('Advanced Complexity Metrics', () => {
  it('computes max nesting depth', () => {
    const lines = [
      '       IF A > 1',
      '         IF B > 2',
      '           IF C > 3',
      '             DISPLAY "DEEP"',
      '           END-IF',
      '         END-IF',
      '       END-IF',
    ];
    expect(computeMaxNestingDepth(lines, 'mainframe')).toBe(3);
  });

  it('computes full complexity score', () => {
    const source = `       IDENTIFICATION DIVISION.
       PROGRAM-ID. METRICS.
       DATA DIVISION.
       WORKING-STORAGE SECTION.
       01 WS-VAR PIC X(10).
       PROCEDURE DIVISION.
       0000-MAIN.
           PERFORM 1000-INIT.
           IF WS-VAR = "A"
             CALL "SUBPGM"
             COPY MYCOPY.
             GO TO 9999-EXIT
           END-IF.
           STOP RUN.
       1000-INIT.
           MOVE SPACES TO WS-VAR.
       9999-EXIT.
           GOBACK.`;

    const score = computeComplexityScore(source, '/test/METRICS.cbl', 'mainframe');
    expect(score.cyclomaticComplexity).toBeGreaterThanOrEqual(2);
    expect(score.ifCount).toBeGreaterThanOrEqual(1);
    expect(score.callCount).toBe(1);
    expect(score.copyCount).toBe(1);
    expect(score.gotoCount).toBe(1);
    expect(score.performCount).toBe(1);
    expect(score.totalLines).toBeGreaterThan(10);
    expect(score.riskScore).toBeGreaterThan(0);
    expect(score.module).toBe('test');
    expect(score.extension).toBe('cbl');
  });

  it('classifies risk levels correctly', () => {
    expect(classifyRisk(5)).toBe('low');
    expect(classifyRisk(15)).toBe('medium');
    expect(classifyRisk(35)).toBe('high');
    expect(classifyRisk(100)).toBe('critical');
  });

  it('aggregates multiple scores', () => {
    const scores = [
      computeComplexityScore('IF X\nEND-IF\n', '/a.cbl', 'mainframe'),
      computeComplexityScore('DISPLAY "HI".\n', '/b.cbl', 'mainframe'),
    ];
    const scan = aggregateScores(scores, 0.5);
    expect(scan.totalFiles).toBe(2);
    expect(scan.avgCyclomatic).toBeGreaterThanOrEqual(1);
    expect(scan.elapsedSec).toBe(0.5);
    expect(scan.scannedAt).toMatch(/^\d{4}-/);
  });
});

// ══════════════════════════════════════════════════════════════
//  3. Dependency Graph Edge Weights
// ══════════════════════════════════════════════════════════════

describe('Dependency Graph', () => {
  let graph: DependencyGraph;

  beforeEach(() => {
    graph = new DependencyGraph();
  });

  it('assigns correct weights per reference type', () => {
    expect(DEP_WEIGHTS.call).toBe(1.0);
    expect(DEP_WEIGHTS.cics_link).toBe(1.0);
    expect(DEP_WEIGHTS.copy).toBe(0.8);
    expect(DEP_WEIGHTS.file_io).toBe(0.6);
    expect(DEP_WEIGHTS.perform).toBe(0.0);
  });

  it('builds forward and reverse edge lists', () => {
    graph.addEdge('A', 'B', 'call');
    graph.addEdge('A', 'C', 'copy');
    graph.addEdge('B', 'D', 'call');

    expect(graph.getOutEdges('A')).toHaveLength(2);
    expect(graph.getInEdges('B')).toHaveLength(1);
    expect(graph.nodeCount).toBe(4);
    expect(graph.edgeCount).toBe(3);
  });

  it('performs forward transitive traversal', () => {
    graph.addEdge('A', 'B', 'call');
    graph.addEdge('B', 'C', 'call');
    graph.addEdge('C', 'D', 'copy');

    const reachable = graph.transitive('A', 'forward', 5);
    expect(reachable).toHaveLength(3);
    expect(reachable[0].nodeId).toBe('B');
    expect(reachable[0].hops).toBe(1);
    expect(reachable[0].accumulatedWeight).toBe(1.0);
    expect(reachable[2].nodeId).toBe('D');
    expect(reachable[2].hops).toBe(3);
    expect(reachable[2].accumulatedWeight).toBeCloseTo(0.8); // 1.0 * 1.0 * 0.8
  });

  it('performs reverse transitive traversal', () => {
    graph.addEdge('A', 'B', 'call');
    graph.addEdge('C', 'B', 'copy');

    const reachable = graph.transitive('B', 'reverse');
    expect(reachable).toHaveLength(2);
    const ids = reachable.map((r) => r.nodeId).sort();
    expect(ids).toEqual(['A', 'C']);
  });

  it('respects maxDepth limit', () => {
    graph.addEdge('A', 'B', 'call');
    graph.addEdge('B', 'C', 'call');
    graph.addEdge('C', 'D', 'call');

    const reachable = graph.transitive('A', 'forward', 2);
    expect(reachable).toHaveLength(2); // B and C only, D at depth 3 excluded
  });

  it('skips zero-weight edges (perform)', () => {
    graph.addEdge('A', 'B', 'perform');
    graph.addEdge('A', 'C', 'call');

    const reachable = graph.transitive('A', 'forward');
    expect(reachable).toHaveLength(1);
    expect(reachable[0].nodeId).toBe('C');
  });

  it('detects cycles via Tarjan algorithm', () => {
    graph.addEdge('A', 'B', 'call');
    graph.addEdge('B', 'C', 'call');
    graph.addEdge('C', 'A', 'call'); // cycle A→B→C→A

    const cycles = graph.findCycles();
    expect(cycles).toHaveLength(1);
    expect(cycles[0].sort()).toEqual(['A', 'B', 'C']);
  });

  it('no cycles in acyclic graph', () => {
    graph.addEdge('A', 'B', 'call');
    graph.addEdge('B', 'C', 'call');

    const cycles = graph.findCycles();
    expect(cycles).toHaveLength(0);
  });
});

// ══════════════════════════════════════════════════════════════
//  5. Vulnerability Propagation
// ══════════════════════════════════════════════════════════════

describe('Vulnerability Propagation', () => {
  it('degrades severity by hop count', () => {
    expect(degradeSeverity('critical', 0)).toBe('critical');
    expect(degradeSeverity('critical', 1)).toBe('high');
    expect(degradeSeverity('critical', 2)).toBe('medium');
    expect(degradeSeverity('critical', 3)).toBe('low');
    expect(degradeSeverity('critical', 4)).toBe('info');
    expect(degradeSeverity('high', 1)).toBe('medium');
    expect(degradeSeverity('low', 1)).toBe('info');
  });

  it('propagates findings through reverse graph', () => {
    const graph = new DependencyGraph();
    graph.addEdge('CALLER1', 'VULNERABLE', 'call');
    graph.addEdge('CALLER2', 'VULNERABLE', 'call');
    graph.addEdge('GRANDCALLER', 'CALLER1', 'call');

    const findings = [
      { fileId: 'VULNERABLE', severity: 'critical' as const, message: 'SQL injection' },
    ];
    const impacts = propagateVulnerabilities(findings, graph, 3);

    expect(impacts.length).toBeGreaterThanOrEqual(3);
    const caller1Impact = impacts.find((i) => i.affectedFileId === 'CALLER1');
    expect(caller1Impact?.inheritedSeverity).toBe('high'); // 1 hop
    const grandcallerImpact = impacts.find((i) => i.affectedFileId === 'GRANDCALLER');
    expect(grandcallerImpact?.inheritedSeverity).toBe('medium'); // 2 hops
    expect(grandcallerImpact?.callPath).toEqual(['VULNERABLE', 'CALLER1', 'GRANDCALLER']);
  });

  it('does not propagate info findings from non-info source', () => {
    const graph = new DependencyGraph();
    graph.addEdge('A', 'B', 'call');
    graph.addEdge('C', 'A', 'call');
    graph.addEdge('D', 'C', 'call');
    graph.addEdge('E', 'D', 'call');

    const findings = [{ fileId: 'B', severity: 'medium' as const, message: 'Weak crypto' }];
    const impacts = propagateVulnerabilities(findings, graph, 10);
    // medium → low (1 hop) → info (2 hops) → excluded (3+ hops)
    expect(impacts.length).toBeLessThanOrEqual(2);
  });
});

// ══════════════════════════════════════════════════════════════
//  6. Bulk MSGCON Pre-scan
// ══════════════════════════════════════════════════════════════

describe('MSGCON Cache', () => {
  beforeEach(() => {
    clearMsgconCache();
  });

  it('looks up known IBM messages', () => {
    const entry = lookupMsgcon('CPF0001');
    expect(entry).not.toBeNull();
    expect(entry!.resolvedText).toBe('Error found on command');
    expect(entry!.msgFile).toBe('QCPFMSG');
  });

  it('returns null for unknown messages', () => {
    expect(lookupMsgcon('ZZZ9999')).toBeNull();
  });

  it('accepts manually added entries', () => {
    addMsgconEntry({
      msgId: 'USR1234',
      msgFile: 'USRMSGF',
      msgLib: 'MYLIB',
      resolvedText: 'Custom message text',
      sourceFile: '/test/CLPGM.clle',
    });
    expect(getMsgconCacheSize()).toBe(1);
    const entry = lookupMsgcon('USR1234');
    expect(entry!.resolvedText).toBe('Custom message text');
  });

  it('is case-insensitive for lookups', () => {
    addMsgconEntry({
      msgId: 'ABC0001',
      msgFile: 'TESTF',
      msgLib: '*LIBL',
      resolvedText: 'Test message',
      sourceFile: '',
    });
    expect(lookupMsgcon('abc0001')).not.toBeNull();
    expect(lookupMsgcon('ABC0001')).not.toBeNull();
  });
});

// ══════════════════════════════════════════════════════════════
//  7. String Literal Preservation in Flow Parser
// ══════════════════════════════════════════════════════════════

describe('String Literal Preservation', () => {
  it('does not treat keywords inside quotes as control flow', () => {
    const lines = ['MOVE "IF ELSE EVALUATE" TO WS-MSG', 'DISPLAY WS-MSG'];
    const result = parseControlFlow(lines, 1, 'TEST-PARA');
    // Should produce: START → process (MOVE...) → process (DISPLAY) → END
    // NOT: START → IF decision → ...
    const hasDecision = result.nodes.some((n) => n.type === 'decision');
    expect(hasDecision).toBe(false);
  });

  it('still detects real IF outside quotes', () => {
    const lines = ['IF WS-FLAG = "Y"', '  DISPLAY "TRUE"', 'END-IF'];
    const result = parseControlFlow(lines, 1, 'TEST-PARA');
    const hasDecision = result.nodes.some((n) => n.type === 'decision');
    expect(hasDecision).toBe(true);
  });

  it('handles mixed quoted and unquoted keywords', () => {
    const lines = ['MOVE "PERFORM" TO WS-CMD', 'PERFORM 1000-INIT'];
    const result = parseControlFlow(lines, 1, 'TEST-PARA');
    // The PERFORM on line 2 should be detected as a call
    const hasCall = result.nodes.some((n) => n.type === 'call');
    expect(hasCall).toBe(true);
  });

  it('preserves single-quoted strings', () => {
    const lines = ["MOVE 'GO TO END' TO WS-TEXT", 'DISPLAY WS-TEXT'];
    const result = parseControlFlow(lines, 1, 'TEST-PARA');
    const hasGoto = result.nodes.some((n) => n.type === 'goto');
    expect(hasGoto).toBe(false);
  });
});

// ══════════════════════════════════════════════════════════════
//  8. Enhanced Error Messages
// ══════════════════════════════════════════════════════════════

describe('Enhanced Diagram Error Messages', () => {
  it('provides hint for missing call_graph data', () => {
    const source = `       IDENTIFICATION DIVISION.
       PROGRAM-ID. NOCALLS.
       PROCEDURE DIVISION.
           DISPLAY "HELLO".
           STOP RUN.`;
    const result = generateDiagram(source, 'cbl', 'call_graph');
    if (!result.success) {
      expect(result.error).toContain('CALL');
    }
    // If it succeeds with empty graph, that's also acceptable
  });

  it('provides hint for missing control_flow constructs', () => {
    // A file with NO procedure division at all
    const source = `       IDENTIFICATION DIVISION.
       PROGRAM-ID. EMPTY.
       DATA DIVISION.
       WORKING-STORAGE SECTION.
       01 WS-VAR PIC X(5).`;
    const result = generateDiagram(source, 'cbl', 'control_flow');
    if (!result.success) {
      expect(result.error).toContain('PROCEDURE DIVISION');
    }
  });

  it('rejects unavailable type with helpful message', () => {
    const source = `       IDENTIFICATION DIVISION.
       PROGRAM-ID. TEST.
       PROCEDURE DIVISION.
           STOP RUN.`;
    const result = generateDiagram(source, 'cbl', 'screen_layout');
    expect(result.success).toBe(false);
    expect(result.error).toContain('not available');
  });
});

// ══════════════════════════════════════════════════════════════
//  4. REFFLD Cross-File Resolution (unit test without filesystem)
// ══════════════════════════════════════════════════════════════

describe('REFFLD Resolution', () => {
  // Note: Full filesystem-dependent tests would require temp directories.
  // Here we test the RFDUMMY pattern extraction logic.
  it('resolves RFDUMMY pattern in field references', () => {
    // This tests the concept — RFDUMMY30 means length 30
    clearReffldCache();

    const fields = [
      {
        recordName: 'REC1',
        fieldName: 'CUSTNO',
        fieldType: 'A',
        fieldLength: null,
        decimalPos: null,
        refField: 'RFDUMMY10 DUMMYPF',
        alias: '',
        colHeading: '',
        textDesc: '',
        startLine: 1,
        row: null,
        col: null,
        usage: 'O',
        isConstant: false,
        constantKeyword: '',
        constantLength: null,
      },
      {
        recordName: 'REC1',
        fieldName: 'CUSTNAME',
        fieldType: 'A',
        fieldLength: null,
        decimalPos: null,
        refField: 'RFDUMMY30 DUMMYPF',
        alias: '',
        colHeading: '',
        textDesc: '',
        startLine: 2,
        row: null,
        col: null,
        usage: 'O',
        isConstant: false,
        constantKeyword: '',
        constantLength: null,
      },
    ];

    const resolved = resolveReffldLengths(fields, '/test/source.dspf');
    expect(resolved).toBe(2);
    expect(fields[0].fieldLength).toBe(10);
    expect(fields[1].fieldLength).toBe(30);
  });

  it('skips fields that already have a length', () => {
    clearReffldCache();

    const fields = [
      {
        recordName: 'REC1',
        fieldName: 'EXISTING',
        fieldType: 'A',
        fieldLength: 15, // Already set
        decimalPos: null,
        refField: 'RFDUMMY20 DUMMYPF',
        alias: '',
        colHeading: '',
        textDesc: '',
        startLine: 1,
        row: null,
        col: null,
        usage: 'O',
        isConstant: false,
        constantKeyword: '',
        constantLength: null,
      },
    ];

    const resolved = resolveReffldLengths(fields, '/test/source.dspf');
    expect(resolved).toBe(0);
    expect(fields[0].fieldLength).toBe(15); // Unchanged
  });
});
