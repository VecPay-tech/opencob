/**
 * Parity v4 Tests — Dependency Engine + Quality Rules Engine
 *
 * Tests ported functionality from DriverX dependency_engine.py and Codex checkers.py.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  inferObjectType,
  scanRepo,
  dependencyTree,
  impactAnalysis,
  buildOrder,
  generateBuildScript,
  repoSummary,
  unresolvedReferences,
  impactMarkdown,
  type SourceObject,
} from '../src/metrics/dependency-engine.js';
import {
  scanFileQuality,
  scanQuality,
  getAvailableCheckers,
  DEFAULT_RULES,
  type QualityRule,
} from '../src/metrics/quality-rules.js';

// ═══════════════════════════════════════════════════════════════
//  Helper: In-memory object graph builder
// ═══════════════════════════════════════════════════════════════

function makeObj(
  name: string,
  ext: string,
  dependsOn: string[] = [],
  dependedBy: string[] = [],
): SourceObject {
  const category = ['cpy', 'inc'].includes(ext)
    ? 'copybook'
    : ['pf', 'lf'].includes(ext)
      ? 'dds'
      : 'program';
  return {
    name,
    filename: `${name}.${ext}`,
    extension: ext,
    category,
    objectType: inferObjectType('', ext, category),
    library: 'MYLIB',
    sourceType: 'QSRC',
    absPath: `/repo/source/MYLIB/QSRC/${name}.${ext}`,
    relPath: `source/MYLIB/QSRC/${name}.${ext}`,
    lineCount: 100,
    reference: false,
    dependsOn: new Set(dependsOn),
    dependedBy: new Set(dependedBy),
    references: [],
  };
}

function buildGraph(defs: Array<[string, string, string[]]>): Map<string, SourceObject> {
  // defs: [name, ext, dependsOn[]]
  const map = new Map<string, SourceObject>();
  for (const [name, ext, deps] of defs) {
    map.set(name, makeObj(name, ext, deps));
  }
  // Wire up dependedBy
  for (const [name, , deps] of defs) {
    for (const dep of deps) {
      if (map.has(dep)) map.get(dep)!.dependedBy.add(name);
    }
  }
  return map;
}

// ═══════════════════════════════════════════════════════════════
//  Dependency Engine Tests
// ═══════════════════════════════════════════════════════════════

describe('Dependency Engine', () => {
  describe('inferObjectType', () => {
    it('classifies COBOL programs', () => {
      expect(inferObjectType('', 'cbl', 'program')).toBe('PGM');
      expect(inferObjectType('', 'cob', 'program')).toBe('PGM');
      expect(inferObjectType('', 'sqb', 'program')).toBe('PGM');
    });

    it('classifies copybooks', () => {
      expect(inferObjectType('cpysrc', 'cpy', 'copybook')).toBe('COPY');
      expect(inferObjectType('', 'cpy', 'copybook')).toBe('COPY');
    });

    it('classifies DDS files', () => {
      expect(inferObjectType('', 'pf', 'dds')).toBe('FILE');
      expect(inferObjectType('', 'lf', 'dds')).toBe('FILE');
      expect(inferObjectType('', 'dspf', 'screen')).toBe('DSPF');
      expect(inferObjectType('', 'prtf', 'screen')).toBe('PRTF');
    });

    it('classifies CL programs', () => {
      expect(inferObjectType('', 'clle', 'program')).toBe('PGM');
      expect(inferObjectType('', 'clp', 'program')).toBe('PGM');
    });

    it('classifies commands and menus', () => {
      expect(inferObjectType('', 'cmd', 'program')).toBe('CMD');
      expect(inferObjectType('', 'mnu', 'program')).toBe('MNU');
    });
  });

  describe('dependencyTree', () => {
    const graph = buildGraph([
      ['pgm1', 'cbl', ['copy1', 'file1']],
      ['pgm2', 'cbl', ['copy1']],
      ['copy1', 'cpy', []],
      ['file1', 'pf', []],
    ]);

    it('builds downstream tree (what does target depend on)', () => {
      const result = dependencyTree(graph, 'pgm1', 'down');
      expect(result.root).toBe('pgm1');
      expect(result.direction).toBe('down');
      expect(result.tree).not.toBeNull();
      expect(result.tree!.children.length).toBe(2);
      expect(result.tree!.children.map((c) => c.name).sort()).toEqual(['copy1', 'file1']);
    });

    it('builds upstream tree (what depends on target)', () => {
      const result = dependencyTree(graph, 'copy1', 'up');
      expect(result.tree).not.toBeNull();
      expect(result.tree!.children.length).toBe(2);
      expect(result.tree!.children.map((c) => c.name).sort()).toEqual(['pgm1', 'pgm2']);
    });

    it('returns error for unknown target', () => {
      const result = dependencyTree(graph, 'nonexistent', 'down');
      expect(result.tree).toBeNull();
      expect(result.error).toContain('not found');
    });

    it('respects maxDepth', () => {
      const deep = buildGraph([
        ['a', 'cbl', ['b']],
        ['b', 'cbl', ['c']],
        ['c', 'cbl', ['d']],
        ['d', 'cbl', []],
      ]);
      const result = dependencyTree(deep, 'a', 'down', 1);
      // At depth 1, b is expanded but its children should be truncated
      expect(result.tree!.children[0].children[0]?.truncated).toBe(true);
    });
  });

  describe('impactAnalysis', () => {
    const graph = buildGraph([
      ['pgm1', 'cbl', ['copy1', 'file1']],
      ['pgm2', 'cbl', ['copy1']],
      ['pgm3', 'cbl', ['pgm1']],
      ['copy1', 'cpy', []],
      ['file1', 'pf', []],
    ]);

    it('finds directly and transitively affected objects', () => {
      const result = impactAnalysis(graph, ['copy1.cpy']);
      expect(result.changed).toEqual(['copy1']);
      expect(result.directlyAffected).toContain('pgm1');
      expect(result.directlyAffected).toContain('pgm2');
      expect(result.transitivelyAffected).toContain('pgm3');
    });

    it('reports total affected count', () => {
      const result = impactAnalysis(graph, ['file1.pf']);
      // file1 → pgm1 → pgm3
      expect(result.totalAffected).toBe(3); // file1 + pgm1 + pgm3
    });

    it('groups by depth', () => {
      const result = impactAnalysis(graph, ['copy1.cpy']);
      expect(result.byDepth[0]?.length).toBe(1); // copy1 itself
      expect(result.byDepth[1]?.length).toBe(2); // pgm1, pgm2
    });
  });

  describe('buildOrder', () => {
    const graph = buildGraph([
      ['pgm1', 'cbl', ['file1']],
      ['pgm2', 'cbl', ['file1', 'pgm1']],
      ['file1', 'pf', []],
      ['copy1', 'cpy', []],
    ]);

    it('produces valid topological order', () => {
      const result = buildOrder(graph);
      // COPY excluded, so 3 compilable objects
      expect(result.totalObjects).toBe(3);
      const orderNames = result.order;
      expect(orderNames.indexOf('file1')).toBeLessThan(orderNames.indexOf('pgm1'));
      expect(orderNames.indexOf('pgm1')).toBeLessThan(orderNames.indexOf('pgm2'));
    });

    it('excludes COPY objects', () => {
      const result = buildOrder(graph);
      expect(result.order).not.toContain('copy1');
    });

    it('detects cycles', () => {
      const cyclic = buildGraph([
        ['a', 'cbl', ['b']],
        ['b', 'cbl', ['a']],
      ]);
      const result = buildOrder(cyclic);
      expect(result.cycles.length).toBe(2);
    });

    it('supports scoped build', () => {
      const result = buildOrder(graph, ['pgm1']);
      // pgm1 depends on file1, so scope includes both
      expect(result.order).toContain('file1');
      expect(result.order).toContain('pgm1');
      expect(result.order).not.toContain('pgm2');
    });
  });

  describe('generateBuildScript', () => {
    const graph = buildGraph([
      ['pgm1', 'cbl', ['file1']],
      ['file1', 'pf', []],
    ]);

    it('generates CL build script', () => {
      const result = generateBuildScript(graph, 'cl');
      expect(result.format).toBe('cl');
      expect(result.totalSteps).toBe(2);
      expect(result.script).toContain('CRTPF');
      expect(result.script).toContain('CRTBNDCBL');
      expect(result.script).toContain('PGM1');
    });

    it('generates JSON build steps', () => {
      const result = generateBuildScript(graph, 'json');
      expect(result.format).toBe('json');
      expect(result.steps!.length).toBe(2);
      expect(result.steps![0].command).toBe('CRTPF');
      expect(result.steps![1].command).toBe('CRTBNDCBL');
    });
  });

  describe('repoSummary', () => {
    const graph = buildGraph([
      ['pgm1', 'cbl', ['copy1']],
      ['pgm2', 'cbl', ['copy1']],
      ['copy1', 'cpy', []],
      ['orphan', 'cbl', []],
    ]);

    it('counts objects by type', () => {
      const summary = repoSummary(graph);
      expect(summary.totalObjects).toBe(4);
      expect(summary.byObjectType['PGM']).toBe(3); // pgm1, pgm2, orphan
      expect(summary.byObjectType['COPY']).toBe(1);
    });

    it('identifies orphans', () => {
      const summary = repoSummary(graph);
      expect(summary.orphansCount).toBe(1);
      expect(summary.orphansSample).toContain('orphan');
    });

    it('ranks most depended-on objects', () => {
      const summary = repoSummary(graph);
      expect(summary.mostDependedOn[0].name).toBe('copy1');
      expect(summary.mostDependedOn[0].dependedByCount).toBe(2);
    });
  });

  describe('unresolvedReferences', () => {
    it('finds references to missing objects', () => {
      const graph = new Map<string, SourceObject>();
      const pgm = makeObj('pgm1', 'cbl', []);
      pgm.references = [
        { target: 'missing1', refType: 'COPY', line: 10 },
        { target: 'missing2', refType: 'CALL', line: 20 },
      ];
      graph.set('pgm1', pgm);

      const result = unresolvedReferences(graph);
      expect(result.length).toBe(2);
      expect(result.map((r) => r.name).sort()).toEqual(['missing1', 'missing2']);
    });
  });

  describe('impactMarkdown', () => {
    const graph = buildGraph([
      ['pgm1', 'cbl', ['file1']],
      ['pgm2', 'cbl', ['pgm1']],
      ['file1', 'pf', []],
    ]);

    it('generates markdown report', () => {
      const md = impactMarkdown(graph, ['file1.pf']);
      expect(md).toContain('## Impact Analysis');
      expect(md).toContain('FILE1');
      expect(md).toContain('PGM1');
    });
  });
});

// ═══════════════════════════════════════════════════════════════
//  Quality Rules Engine Tests
// ═══════════════════════════════════════════════════════════════

describe('Quality Rules Engine', () => {
  describe('getAvailableCheckers', () => {
    it('returns all checker IDs', () => {
      const checkers = getAvailableCheckers();
      expect(checkers).toContain('structure_count');
      expect(checkers).toContain('block_size');
      expect(checkers).toContain('nesting_depth');
      expect(checkers).toContain('unused_detection');
      expect(checkers).toContain('naming_convention');
      expect(checkers).toContain('documentation_check');
      expect(checkers).toContain('program_id_filename');
      expect(checkers).toContain('duplicate_detection');
      expect(checkers).toContain('move_analysis');
      expect(checkers.length).toBe(9);
    });
  });

  describe('structure_count checker', () => {
    it('detects too many paragraphs', () => {
      // Generate 35 paragraphs (7 spaces = 6 seq + 1 area A)
      const lines = Array.from(
        { length: 35 },
        (_, i) => `       PARA-${String(i).padStart(3, '0')}.\n           DISPLAY "HELLO".`,
      ).join('\n');
      const rules: QualityRule[] = [
        {
          code: 'TEST',
          name: 'test',
          severity: 'medium',
          category: 'test',
          checkerId: 'structure_count',
          checkerParams: { element: 'paragraph', max: 30 },
          enabled: true,
          maxPerFile: 5,
          debtMinutes: 10,
        },
      ];
      const issues = scanFileQuality(lines, 'test.cbl', rules);
      expect(issues.length).toBe(1);
      expect(issues[0].message).toContain('35');
      expect(issues[0].message).toContain('30');
    });

    it('passes when count is within limit', () => {
      const lines = `       MAIN-PARA.\n           DISPLAY "OK".`;
      const rules: QualityRule[] = [
        {
          code: 'TEST',
          name: 'test',
          severity: 'medium',
          category: 'test',
          checkerId: 'structure_count',
          checkerParams: { element: 'paragraph', max: 30 },
          enabled: true,
          maxPerFile: 5,
          debtMinutes: 10,
        },
      ];
      const issues = scanFileQuality(lines, 'test.cbl', rules);
      expect(issues.length).toBe(0);
    });
  });

  describe('block_size checker', () => {
    it('detects oversized paragraphs', () => {
      const bigPara =
        `       BIG-PARA.\n` +
        Array.from({ length: 70 }, () => '           DISPLAY "X".').join('\n');
      const rules: QualityRule[] = [
        {
          code: 'SIZE',
          name: 'size',
          severity: 'medium',
          category: 'test',
          checkerId: 'block_size',
          checkerParams: { block_type: 'paragraph', max_lines: 60 },
          enabled: true,
          maxPerFile: 10,
          debtMinutes: 10,
        },
      ];
      const issues = scanFileQuality(bigPara, 'test.cbl', rules);
      expect(issues.length).toBe(1);
      expect(issues[0].message).toContain('BIG-PARA');
    });
  });

  describe('nesting_depth checker', () => {
    it('detects deeply nested IF blocks', () => {
      const lines = [
        '       PROCEDURE DIVISION.',
        '       MAIN-PARA.',
        '           IF A = 1',
        '             IF B = 2',
        '               IF C = 3',
        '                 IF D = 4',
        '                   IF E = 5',
        '                     DISPLAY "DEEP"',
        '                   END-IF',
        '                 END-IF',
        '               END-IF',
        '             END-IF',
        '           END-IF',
      ].join('\n');
      const rules: QualityRule[] = [
        {
          code: 'NEST',
          name: 'nest',
          severity: 'high',
          category: 'test',
          checkerId: 'nesting_depth',
          checkerParams: { max_depth: 4 },
          enabled: true,
          maxPerFile: 10,
          debtMinutes: 10,
        },
      ];
      const issues = scanFileQuality(lines, 'test.cbl', rules);
      expect(issues.length).toBeGreaterThan(0);
      expect(issues[0].message).toContain('nesting depth');
    });
  });

  describe('unused_detection checker', () => {
    it('detects unused paragraphs', () => {
      const src = [
        '       MAIN-PARA.',
        '           PERFORM USED-PARA.',
        '           STOP RUN.',
        '       USED-PARA.',
        '           DISPLAY "USED".',
        '       UNUSED-PARA.',
        '           DISPLAY "ORPHAN".',
      ].join('\n');
      const rules: QualityRule[] = [
        {
          code: 'DEAD',
          name: 'dead',
          severity: 'medium',
          category: 'test',
          checkerId: 'unused_detection',
          checkerParams: { element: 'paragraph' },
          enabled: true,
          maxPerFile: 20,
          debtMinutes: 10,
        },
      ];
      const issues = scanFileQuality(src, 'test.cbl', rules);
      // MAIN-PARA is referenced zero times externally (it's entry point — may show as unused)
      // UNUSED-PARA should definitely be flagged
      const unusedNames = issues.map((i) => i.message);
      expect(unusedNames.some((m) => m.includes('UNUSED-PARA'))).toBe(true);
    });
  });

  describe('naming_convention checker', () => {
    it('flags paragraphs not matching pattern', () => {
      const src = `       bad-name.\n           DISPLAY "X".`;
      const rules: QualityRule[] = [
        {
          code: 'NAME',
          name: 'name',
          severity: 'low',
          category: 'test',
          checkerId: 'naming_convention',
          checkerParams: { scope: 'paragraph', pattern: '^[0-9]{4}-[A-Z][A-Z0-9-]*$' },
          enabled: true,
          maxPerFile: 20,
          debtMinutes: 5,
        },
      ];
      const issues = scanFileQuality(src, 'test.cbl', rules);
      expect(issues.length).toBe(1);
      expect(issues[0].message).toContain('bad-name');
    });
  });

  describe('program_id_filename checker', () => {
    it('detects PROGRAM-ID mismatch', () => {
      const src = `       IDENTIFICATION DIVISION.\n       PROGRAM-ID. MYPROG.\n       PROCEDURE DIVISION.\n           STOP RUN.`;
      const rules: QualityRule[] = [
        {
          code: 'ID',
          name: 'id',
          severity: 'medium',
          category: 'test',
          checkerId: 'program_id_filename',
          checkerParams: {},
          enabled: true,
          maxPerFile: 1,
          debtMinutes: 15,
        },
      ];
      const issues = scanFileQuality(src, 'othername.cbl', rules);
      expect(issues.length).toBe(1);
      expect(issues[0].message).toContain('MYPROG');
    });

    it('passes when PROGRAM-ID matches filename', () => {
      const src = `       IDENTIFICATION DIVISION.\n       PROGRAM-ID. MYPROG.\n       PROCEDURE DIVISION.\n           STOP RUN.`;
      const rules: QualityRule[] = [
        {
          code: 'ID',
          name: 'id',
          severity: 'medium',
          category: 'test',
          checkerId: 'program_id_filename',
          checkerParams: {},
          enabled: true,
          maxPerFile: 1,
          debtMinutes: 15,
        },
      ];
      const issues = scanFileQuality(src, 'MYPROG.cbl', rules);
      expect(issues.length).toBe(0);
    });
  });

  describe('duplicate_detection checker', () => {
    it('flags repeated string literals', () => {
      const lines = Array.from({ length: 5 }, () => "           DISPLAY 'REPEATED-VALUE'.").join(
        '\n',
      );
      const rules: QualityRule[] = [
        {
          code: 'DUP',
          name: 'dup',
          severity: 'low',
          category: 'test',
          checkerId: 'duplicate_detection',
          checkerParams: { max_occurrences: 3 },
          enabled: true,
          maxPerFile: 10,
          debtMinutes: 10,
        },
      ];
      const issues = scanFileQuality(lines, 'test.cbl', rules);
      expect(issues.length).toBe(1);
      expect(issues[0].message).toContain('REPEATED-VALUE');
      expect(issues[0].message).toContain('5');
    });
  });

  describe('move_analysis checker', () => {
    it('detects self-assignment MOVE', () => {
      const src = `           MOVE WS-AMOUNT TO WS-AMOUNT.\n           MOVE WS-A TO WS-B.`;
      const rules: QualityRule[] = [
        {
          code: 'MOVE',
          name: 'move',
          severity: 'medium',
          category: 'test',
          checkerId: 'move_analysis',
          checkerParams: { check: 'self_assignment' },
          enabled: true,
          maxPerFile: 10,
          debtMinutes: 10,
        },
      ];
      const issues = scanFileQuality(src, 'test.cbl', rules);
      expect(issues.length).toBe(1);
      expect(issues[0].message).toContain('Self-assignment');
      expect(issues[0].message).toContain('WS-AMOUNT');
    });
  });

  describe('scanQuality (multi-file)', () => {
    it('aggregates issues across files', () => {
      const files = [
        { content: `           MOVE WS-X TO WS-X.`, filename: 'a.cbl' },
        { content: `           MOVE WS-Y TO WS-Y.`, filename: 'b.cbl' },
      ];
      const rules: QualityRule[] = [
        {
          code: 'MOVE',
          name: 'move',
          severity: 'high',
          category: 'test',
          checkerId: 'move_analysis',
          checkerParams: { check: 'self_assignment' },
          enabled: true,
          maxPerFile: 10,
          debtMinutes: 10,
        },
      ];
      const result = scanQuality(files, rules);
      expect(result.totalFiles).toBe(2);
      expect(result.issuesCount).toBe(2);
      expect(result.highCount).toBe(2);
      expect(result.totalDebt).toBe(20);
    });
  });

  describe('DEFAULT_RULES', () => {
    it('contains expected rule codes', () => {
      const codes = DEFAULT_RULES.map((r) => r.code);
      expect(codes).toContain('STRUC001');
      expect(codes).toContain('SIZE001');
      expect(codes).toContain('NEST001');
      expect(codes).toContain('DEAD001');
      expect(codes).toContain('ID001');
      expect(codes).toContain('DUP001');
      expect(codes).toContain('MOVE001');
    });

    it('has no duplicate rule codes', () => {
      const codes = DEFAULT_RULES.map((r) => r.code);
      expect(new Set(codes).size).toBe(codes.length);
    });
  });
});
