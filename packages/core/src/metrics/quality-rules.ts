/**
 * Quality Rules Engine — SonarQube-inspired code quality scanning.
 *
 * Ported from Codex quality.py + checkers.py.
 * Provides configurable rules with heuristic-based code scanning:
 *   - Structure count (paragraphs, sections, COPY, PERFORM, CALL)
 *   - Block size (paragraph/section line count)
 *   - Nesting depth (IF/PERFORM)
 *   - Unused detection (paragraphs, data items, conditions)
 *   - Naming conventions
 *   - Documentation checks
 *   - Duplicate detection (literals)
 *   - Program-ID/filename match
 *   - MOVE analysis (self-assignment)
 */

// ═══════════════════════════════════════════════════════════════
//  Types
// ═══════════════════════════════════════════════════════════════

export type Severity = 'blocker' | 'critical' | 'high' | 'medium' | 'low' | 'info';

export interface QualityRule {
  code: string;
  name: string;
  severity: Severity;
  category: string;
  checkerId: string;
  checkerParams: Record<string, string | number>;
  enabled: boolean;
  maxPerFile: number;
  debtMinutes: number;
}

export interface QualityIssue {
  ruleCode: string;
  ruleName: string;
  severity: Severity;
  line: number;
  message: string;
  debtMinutes: number;
}

export interface QualityScanResult {
  totalFiles: number;
  issuesCount: number;
  blockerCount: number;
  criticalCount: number;
  highCount: number;
  mediumCount: number;
  lowCount: number;
  totalDebt: number;
  issues: QualityIssue[];
}

// ═══════════════════════════════════════════════════════════════
//  Checker Functions
// ═══════════════════════════════════════════════════════════════

type CheckerFn = (
  content: string,
  lines: string[],
  filename: string,
  params: Record<string, string | number>,
) => Array<[number, string]>;

// Precompiled regexes
const RE_PARA = /^.{6}\s{1,4}(\S[\w-]+)\s*\.\s*$/gm;
const RE_SECTION = /^.{6}\s{1,4}([\w-]+)\s+SECTION\s*\./gim;
const RE_COPY = /\bCOPY\s+[\w-]+/gi;
const RE_PERFORM = /\bPERFORM\s+[\w-]+/gi;
const RE_CALL = /\bCALL\s+/gi;
const RE_FD = /^\s*FD\s+([\w-]+)/gim;
const RE_IF = /\bIF\b/gi;
const RE_END_IF = /\bEND-IF\b/gi;
const RE_DATA_ITEM = /^.{6}\s+(\d{2})\s+([\w-]+)/gm;
const RE_COND_NAME = /^.{6}\s+88\s+([\w-]+)/gm;
const RE_PROGRAM_ID = /\bPROGRAM-ID\.\s*([\w-]+)/i;
const RE_LITERAL = /'([^']{3,})'|"([^"]{3,})"/g;
const RE_MOVE = /\bMOVE\s+(\S+)\s+TO\s+(\S+)/gi;

function lineOf(content: string, pos: number): number {
  return content.slice(0, pos).split('\n').length;
}

function countMatches(content: string, regex: RegExp): number {
  regex.lastIndex = 0;
  let count = 0;
  while (regex.exec(content)) count++;
  return count;
}

// ─── 1. structure_count ────────────────────────────────────

const checkStructureCount: CheckerFn = (content, _lines, _filename, params) => {
  const element = String(params.element ?? 'paragraph');
  const max = Number(params.max ?? 30);
  const patterns: Record<string, RegExp> = {
    paragraph: RE_PARA,
    section: RE_SECTION,
    copy: RE_COPY,
    perform: RE_PERFORM,
    call: RE_CALL,
    fd: RE_FD,
  };
  const rx = patterns[element];
  if (!rx) return [];
  const count = countMatches(content, rx);
  if (count > max) {
    return [[1, `File contains ${count} ${element}(s) — exceeds maximum of ${max}`]];
  }
  return [];
};

// ─── 2. block_size ─────────────────────────────────────────

const checkBlockSize: CheckerFn = (content, _lines, _filename, params) => {
  const blockType = String(params.block_type ?? 'paragraph');
  const maxLines = Number(params.max_lines ?? 60);
  const rx =
    blockType === 'section'
      ? new RegExp(RE_SECTION.source, RE_SECTION.flags)
      : new RegExp(RE_PARA.source, RE_PARA.flags);
  const headers: Array<[string, number]> = [];
  let m: RegExpExecArray | null;
  while ((m = rx.exec(content)) !== null) {
    headers.push([m[1], m.index]);
  }
  if (!headers.length) return [];
  const issues: Array<[number, string]> = [];
  for (let i = 0; i < headers.length; i++) {
    const [name, start] = headers[i];
    const end = i + 1 < headers.length ? headers[i + 1][1] : content.length;
    const blockLines = content.slice(start, end).split('\n').length;
    if (blockLines > maxLines) {
      issues.push([
        lineOf(content, start),
        `${blockType} '${name}' has ${blockLines} lines — exceeds max ${maxLines}`,
      ]);
    }
  }
  return issues;
};

// ─── 3. nesting_depth ──────────────────────────────────────

const checkNestingDepth: CheckerFn = (_content, lines, _filename, params) => {
  const maxDepth = Number(params.max_depth ?? 4);
  const issues: Array<[number, string]> = [];
  let depth = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.length > 6 && line[6] === '*') continue;
    const upper = line.toUpperCase();
    const opens = (upper.match(/\bIF\b/g) ?? []).length;
    const closes = (upper.match(/\bEND-IF\b/g) ?? []).length;
    depth += opens - closes;
    if (depth > maxDepth && opens > 0) {
      issues.push([i + 1, `IF nesting depth ${depth} exceeds max ${maxDepth}`]);
    }
    if (depth < 0) depth = 0;
  }
  return issues.slice(0, 20);
};

// ─── 4. unused_detection ──────────────────────────────────

const checkUnusedDetection: CheckerFn = (content, _lines, _filename, params) => {
  const element = String(params.element ?? 'paragraph');
  const issues: Array<[number, string]> = [];
  const upperContent = content.toUpperCase();

  if (element === 'paragraph') {
    const rx = new RegExp(RE_PARA.source, RE_PARA.flags);
    let m: RegExpExecArray | null;
    while ((m = rx.exec(content)) !== null) {
      const name = m[1].toUpperCase();
      const regex = new RegExp(`\\b${name.replace(/[.*+?^${}()|[\]\\-]/g, '\\$&')}\\b`, 'g');
      const count = (upperContent.match(regex) ?? []).length - 1;
      if (count <= 0) {
        issues.push([lineOf(content, m.index), `Paragraph '${m[1]}' is never referenced`]);
      }
    }
  } else if (element === 'data_item') {
    const procDiv = content.toUpperCase().indexOf('PROCEDURE DIVISION');
    if (procDiv > 0) {
      const procSection = content.slice(procDiv).toUpperCase();
      const rx = new RegExp(RE_DATA_ITEM.source, RE_DATA_ITEM.flags);
      let m: RegExpExecArray | null;
      while ((m = rx.exec(content)) !== null) {
        if (m.index > procDiv) break; // Only check DATA DIVISION items
        const level = parseInt(m[1], 10);
        const name = m[2].toUpperCase();
        if ([66, 88].includes(level) || name === 'FILLER') continue;
        if (!procSection.includes(name)) {
          issues.push([
            lineOf(content, m.index),
            `Data item '${m[2]}' appears unused in PROCEDURE DIVISION`,
          ]);
        }
      }
    }
  } else if (element === 'condition_name') {
    const rx = new RegExp(RE_COND_NAME.source, RE_COND_NAME.flags);
    let m: RegExpExecArray | null;
    while ((m = rx.exec(content)) !== null) {
      const name = m[1].toUpperCase();
      const regex = new RegExp(`\\b${name.replace(/[.*+?^${}()|[\]\\-]/g, '\\$&')}\\b`, 'g');
      const count = (upperContent.match(regex) ?? []).length - 1;
      if (count <= 0) {
        issues.push([
          lineOf(content, m.index),
          `Condition name '${m[1]}' (88-level) is never used`,
        ]);
      }
    }
  }

  return issues.slice(0, 50);
};

// ─── 5. naming_convention ──────────────────────────────────

const checkNamingConvention: CheckerFn = (content, _lines, filename, params) => {
  const scope = String(params.scope ?? 'paragraph');
  const pattern = String(params.pattern ?? '^[A-Z0-9][\\w-]*$');
  const msg = String(params.message ?? '');
  let rx: RegExp;
  try {
    rx = new RegExp(pattern);
  } catch {
    return [[1, `Invalid naming pattern: ${pattern}`]];
  }
  const issues: Array<[number, string]> = [];

  if (scope === 'paragraph') {
    const paraRx = new RegExp(RE_PARA.source, RE_PARA.flags);
    let m: RegExpExecArray | null;
    while ((m = paraRx.exec(content)) !== null) {
      if (!rx.test(m[1])) {
        issues.push([
          lineOf(content, m.index),
          msg || `Paragraph '${m[1]}' does not match naming convention: ${pattern}`,
        ]);
      }
    }
  } else if (scope === 'program') {
    const pgmMatch = RE_PROGRAM_ID.exec(content);
    if (pgmMatch && !rx.test(pgmMatch[1])) {
      issues.push([
        lineOf(content, pgmMatch.index),
        msg || `PROGRAM-ID '${pgmMatch[1]}' does not match naming convention: ${pattern}`,
      ]);
    }
  } else if (scope === 'file') {
    const basename =
      filename
        .replace(/\.[^.]+$/, '')
        .split('/')
        .pop() ?? '';
    if (!rx.test(basename)) {
      issues.push([
        1,
        msg || `Filename '${basename}' does not match naming convention: ${pattern}`,
      ]);
    }
  }

  return issues.slice(0, 30);
};

// ─── 6. documentation_check ───────────────────────────────

const checkDocumentation: CheckerFn = (content, lines, _filename, params) => {
  const scope = String(params.scope ?? 'paragraph');
  const issues: Array<[number, string]> = [];
  const rx =
    scope === 'section'
      ? new RegExp(RE_SECTION.source, RE_SECTION.flags)
      : new RegExp(RE_PARA.source, RE_PARA.flags);

  let m: RegExpExecArray | null;
  while ((m = rx.exec(content)) !== null) {
    const ln = lineOf(content, m.index);
    if (ln >= 2) {
      const prev = lines[ln - 2]; // 0-indexed
      const isComment = prev.length > 6 && prev[6] === '*';
      if (!isComment) {
        issues.push([ln, `${scope} '${m[1]}' has no preceding comment`]);
      }
    }
  }

  return issues.slice(0, 30);
};

// ─── 7. program_id_filename ───────────────────────────────

const checkProgramIdFilename: CheckerFn = (content, _lines, filename, _params) => {
  const m = RE_PROGRAM_ID.exec(content);
  if (!m) return [];
  const pgmId = m[1].toUpperCase();
  const basename =
    filename
      .replace(/\.[^.]+$/, '')
      .split('/')
      .pop()
      ?.toUpperCase() ?? '';
  if (pgmId !== basename) {
    return [
      [
        lineOf(content, m.index),
        `PROGRAM-ID '${m[1]}' does not match filename '${filename.split('/').pop()}'`,
      ],
    ];
  }
  return [];
};

// ─── 8. duplicate_detection ───────────────────────────────

const checkDuplicateDetection: CheckerFn = (content, _lines, _filename, params) => {
  const maxOcc = Number(params.max_occurrences ?? 3);
  const issues: Array<[number, string]> = [];
  const lits = new Map<string, number[]>();
  const rx = new RegExp(RE_LITERAL.source, RE_LITERAL.flags);
  let m: RegExpExecArray | null;
  while ((m = rx.exec(content)) !== null) {
    const val = (m[1] ?? m[2]).toUpperCase();
    if (!lits.has(val)) lits.set(val, []);
    lits.get(val)!.push(lineOf(content, m.index));
  }
  for (const [val, locs] of [...lits.entries()].sort((a, b) => b[1].length - a[1].length)) {
    if (locs.length > maxOcc) {
      issues.push([
        locs[0],
        `String literal '${val}' is duplicated ${locs.length} times — define as constant`,
      ]);
    }
  }
  return issues.slice(0, 20);
};

// ─── 9. move_analysis ────────────────────────────────────

const checkMoveAnalysis: CheckerFn = (content, _lines, _filename, params) => {
  const check = String(params.check ?? 'self_assignment');
  const issues: Array<[number, string]> = [];
  if (check === 'self_assignment') {
    const rx = new RegExp(RE_MOVE.source, RE_MOVE.flags);
    let m: RegExpExecArray | null;
    while ((m = rx.exec(content)) !== null) {
      const src = m[1].toUpperCase().replace(/\.$/, '');
      const dst = m[2].toUpperCase().replace(/\.$/, '');
      if (src === dst) {
        issues.push([lineOf(content, m.index), `Self-assignment: MOVE ${src} TO ${dst}`]);
      }
    }
  }
  return issues.slice(0, 20);
};

// ═══════════════════════════════════════════════════════════════
//  Checker Registry
// ═══════════════════════════════════════════════════════════════

const CHECKER_REGISTRY: Record<string, CheckerFn> = {
  structure_count: checkStructureCount,
  block_size: checkBlockSize,
  nesting_depth: checkNestingDepth,
  unused_detection: checkUnusedDetection,
  naming_convention: checkNamingConvention,
  documentation_check: checkDocumentation,
  program_id_filename: checkProgramIdFilename,
  duplicate_detection: checkDuplicateDetection,
  move_analysis: checkMoveAnalysis,
};

/** Get list of available checker IDs */
export function getAvailableCheckers(): string[] {
  return Object.keys(CHECKER_REGISTRY);
}

// ═══════════════════════════════════════════════════════════════
//  Default Rule Set
// ═══════════════════════════════════════════════════════════════

export const DEFAULT_RULES: QualityRule[] = [
  {
    code: 'STRUC001',
    name: 'Too many paragraphs',
    severity: 'medium',
    category: 'maintainability',
    checkerId: 'structure_count',
    checkerParams: { element: 'paragraph', max: 30 },
    enabled: true,
    maxPerFile: 1,
    debtMinutes: 60,
  },
  {
    code: 'STRUC002',
    name: 'Too many COPY statements',
    severity: 'low',
    category: 'maintainability',
    checkerId: 'structure_count',
    checkerParams: { element: 'copy', max: 20 },
    enabled: true,
    maxPerFile: 1,
    debtMinutes: 30,
  },
  {
    code: 'SIZE001',
    name: 'Paragraph too large',
    severity: 'medium',
    category: 'maintainability',
    checkerId: 'block_size',
    checkerParams: { block_type: 'paragraph', max_lines: 60 },
    enabled: true,
    maxPerFile: 10,
    debtMinutes: 30,
  },
  {
    code: 'SIZE002',
    name: 'Section too large',
    severity: 'medium',
    category: 'maintainability',
    checkerId: 'block_size',
    checkerParams: { block_type: 'section', max_lines: 200 },
    enabled: true,
    maxPerFile: 5,
    debtMinutes: 45,
  },
  {
    code: 'NEST001',
    name: 'Deeply nested IF',
    severity: 'high',
    category: 'complexity',
    checkerId: 'nesting_depth',
    checkerParams: { max_depth: 4 },
    enabled: true,
    maxPerFile: 10,
    debtMinutes: 30,
  },
  {
    code: 'DEAD001',
    name: 'Unused paragraph',
    severity: 'medium',
    category: 'dead-code',
    checkerId: 'unused_detection',
    checkerParams: { element: 'paragraph' },
    enabled: true,
    maxPerFile: 20,
    debtMinutes: 15,
  },
  {
    code: 'DEAD002',
    name: 'Unused data item',
    severity: 'low',
    category: 'dead-code',
    checkerId: 'unused_detection',
    checkerParams: { element: 'data_item' },
    enabled: true,
    maxPerFile: 30,
    debtMinutes: 10,
  },
  {
    code: 'DEAD003',
    name: 'Unused condition name',
    severity: 'low',
    category: 'dead-code',
    checkerId: 'unused_detection',
    checkerParams: { element: 'condition_name' },
    enabled: true,
    maxPerFile: 20,
    debtMinutes: 10,
  },
  {
    code: 'NAME001',
    name: 'Paragraph naming convention',
    severity: 'low',
    category: 'convention',
    checkerId: 'naming_convention',
    checkerParams: { scope: 'paragraph', pattern: '^[0-9]{4}-[A-Z][A-Z0-9-]*$' },
    enabled: false,
    maxPerFile: 20,
    debtMinutes: 5,
  },
  {
    code: 'DOC001',
    name: 'Missing paragraph comment',
    severity: 'info',
    category: 'documentation',
    checkerId: 'documentation_check',
    checkerParams: { scope: 'paragraph' },
    enabled: false,
    maxPerFile: 30,
    debtMinutes: 10,
  },
  {
    code: 'ID001',
    name: 'PROGRAM-ID mismatch',
    severity: 'medium',
    category: 'convention',
    checkerId: 'program_id_filename',
    checkerParams: {},
    enabled: true,
    maxPerFile: 1,
    debtMinutes: 15,
  },
  {
    code: 'DUP001',
    name: 'Duplicate string literal',
    severity: 'low',
    category: 'maintainability',
    checkerId: 'duplicate_detection',
    checkerParams: { max_occurrences: 3 },
    enabled: true,
    maxPerFile: 10,
    debtMinutes: 15,
  },
  {
    code: 'MOVE001',
    name: 'Self-assignment MOVE',
    severity: 'medium',
    category: 'bug-risk',
    checkerId: 'move_analysis',
    checkerParams: { check: 'self_assignment' },
    enabled: true,
    maxPerFile: 10,
    debtMinutes: 10,
  },
];

// ═══════════════════════════════════════════════════════════════
//  Scanner
// ═══════════════════════════════════════════════════════════════

/**
 * Scan a single file against a set of quality rules.
 */
export function scanFileQuality(
  content: string,
  filename: string,
  rules?: QualityRule[],
): QualityIssue[] {
  const activeRules = (rules ?? DEFAULT_RULES).filter((r) => r.enabled);
  const lines = content.split('\n');
  const issues: QualityIssue[] = [];

  for (const rule of activeRules) {
    const checker = CHECKER_REGISTRY[rule.checkerId];
    if (!checker) continue;

    const results = checker(content, lines, filename, rule.checkerParams);
    for (const [line, message] of results.slice(0, rule.maxPerFile)) {
      issues.push({
        ruleCode: rule.code,
        ruleName: rule.name,
        severity: rule.severity,
        line,
        message,
        debtMinutes: rule.debtMinutes,
      });
    }
  }

  return issues;
}

/**
 * Scan multiple files and aggregate results.
 */
export function scanQuality(
  files: Array<{ content: string; filename: string }>,
  rules?: QualityRule[],
): QualityScanResult {
  let totalIssues: QualityIssue[] = [];
  for (const file of files) {
    const fileIssues = scanFileQuality(file.content, file.filename, rules);
    totalIssues = totalIssues.concat(fileIssues);
  }

  return {
    totalFiles: files.length,
    issuesCount: totalIssues.length,
    blockerCount: totalIssues.filter((i) => i.severity === 'blocker').length,
    criticalCount: totalIssues.filter((i) => i.severity === 'critical').length,
    highCount: totalIssues.filter((i) => i.severity === 'high').length,
    mediumCount: totalIssues.filter((i) => i.severity === 'medium').length,
    lowCount: totalIssues.filter((i) => i.severity === 'low').length,
    totalDebt: totalIssues.reduce((sum, i) => sum + i.debtMinutes, 0),
    issues: totalIssues,
  };
}
