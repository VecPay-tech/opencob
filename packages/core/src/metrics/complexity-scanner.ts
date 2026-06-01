/**
 * Complexity Scanner — Calculates code complexity metrics for legacy programs.
 *
 * Ported from Codex models.ComplexityScore + DriverX cobol_parser.cyclomatic_complexity.
 * Computes: cyclomatic complexity, max nesting depth, keyword counts, risk score.
 */

export interface ComplexityScore {
  /** Source file path */
  filePath: string;
  /** Module / library identifier */
  module: string;
  /** File extension / category */
  extension: string;
  /** Total physical lines */
  totalLines: number;
  /** Non-blank, non-comment lines */
  codeLines: number;
  /** Comment-only lines */
  commentLines: number;
  /** Blank lines */
  blankLines: number;
  /** Comment ratio × 10 for integer precision */
  commentRatio: number;
  /** McCabe cyclomatic complexity */
  cyclomaticComplexity: number;
  /** Maximum nesting depth (IF/EVALUATE/PERFORM nesting) */
  maxNestingDepth: number;
  /** GO TO statement count */
  gotoCount: number;
  /** PERFORM statement count */
  performCount: number;
  /** CALL statement count */
  callCount: number;
  /** COPY statement count */
  copyCount: number;
  /** IF statement count */
  ifCount: number;
  /** EVALUATE statement count */
  evaluateCount: number;
  /** Computed risk score (higher = riskier) */
  riskScore: number;
}

export interface ComplexityScan {
  /** Unique scan identifier */
  id: string;
  /** Total files scanned */
  totalFiles: number;
  /** Average cyclomatic complexity across files */
  avgCyclomatic: number;
  /** Average risk score across files */
  avgRiskScore: number;
  /** Average lines per file */
  avgLines: number;
  /** Total GO TO statements across all files */
  totalGotos: number;
  /** Risk bucket counts */
  lowCount: number;
  mediumCount: number;
  highCount: number;
  criticalCount: number;
  /** Scan duration in seconds */
  elapsedSec: number;
  /** Timestamp of scan */
  scannedAt: string;
  /** Individual file scores */
  scores: ComplexityScore[];
}

/** Risk thresholds per DriverX/Codex calibration */
const RISK_THRESHOLDS = {
  low: 10,
  medium: 20,
  high: 50,
} as const;

/**
 * Compute cyclomatic complexity for COBOL source.
 * Algorithm: start at 1, increment for each decision point (IF, EVALUATE, WHEN).
 */
export function computeCyclomaticComplexity(
  lines: string[],
  platform: 'mainframe' | 'as400' = 'mainframe',
): number {
  let complexity = 1;
  for (const raw of lines) {
    const line = stripSequenceArea(raw, platform);
    if (isComment(line, platform)) continue;
    const upper = line.toUpperCase();
    // Count decision keywords (each adds a new independent path)
    complexity += countKeyword(upper, ' IF ');
    complexity += countKeyword(upper, 'EVALUATE ');
    complexity += countKeyword(upper, ' WHEN ');
    // ON SIZE ERROR, AT END, INVALID KEY add paths
    if (/ ON SIZE ERROR/i.test(upper)) complexity++;
    if (/ AT END/i.test(upper)) complexity++;
    if (/ INVALID KEY/i.test(upper)) complexity++;
  }
  return complexity;
}

/**
 * Compute maximum nesting depth by tracking IF/EVALUATE/PERFORM stack.
 */
export function computeMaxNestingDepth(
  lines: string[],
  platform: 'mainframe' | 'as400' = 'mainframe',
): number {
  let depth = 0;
  let maxDepth = 0;
  for (const raw of lines) {
    const line = stripSequenceArea(raw, platform);
    if (isComment(line, platform)) continue;
    const upper = line.toUpperCase().trim();
    // Openers
    if (/^\s*IF\b/.test(upper) || /\bIF\b/.test(upper)) depth++;
    if (/^\s*EVALUATE\b/.test(upper)) depth++;
    if (/^\s*PERFORM\b.*\bUNTIL\b/.test(upper) || /^\s*PERFORM\b.*\bVARYING\b/.test(upper)) depth++;
    // Closers
    if (/^\s*END-IF\b/.test(upper)) depth = Math.max(0, depth - 1);
    if (/^\s*END-EVALUATE\b/.test(upper)) depth = Math.max(0, depth - 1);
    if (/^\s*END-PERFORM\b/.test(upper)) depth = Math.max(0, depth - 1);
    maxDepth = Math.max(maxDepth, depth);
  }
  return maxDepth;
}

/**
 * Compute full complexity score for a single file.
 */
export function computeComplexityScore(
  content: string,
  filePath: string,
  platform: 'mainframe' | 'as400' = 'mainframe',
): ComplexityScore {
  const lines = content.split('\n');
  const extension = filePath.split('.').pop()?.toLowerCase() ?? '';
  const module = extractModule(filePath);

  let codeLines = 0;
  let commentLines = 0;
  let blankLines = 0;
  let gotoCount = 0;
  let performCount = 0;
  let callCount = 0;
  let copyCount = 0;
  let ifCount = 0;
  let evaluateCount = 0;

  for (const raw of lines) {
    const stripped = stripSequenceArea(raw, platform);
    if (!stripped.trim()) {
      blankLines++;
      continue;
    }
    if (isComment(stripped, platform)) {
      commentLines++;
      continue;
    }
    codeLines++;
    const upper = stripped.toUpperCase();
    if (/\bGO\s+TO\b/.test(upper)) gotoCount++;
    if (/\bPERFORM\b/.test(upper)) performCount++;
    if (/\bCALL\b/.test(upper)) callCount++;
    if (/\bCOPY\b/.test(upper)) copyCount++;
    if (/\bIF\b/.test(upper)) ifCount++;
    if (/\bEVALUATE\b/.test(upper)) evaluateCount++;
  }

  const cyclomaticComplexity = computeCyclomaticComplexity(lines, platform);
  const maxNestingDepth = computeMaxNestingDepth(lines, platform);

  // Risk score formula from Codex: cyclomatic × depth penalty + goto penalty
  const depthPenalty = maxNestingDepth > 4 ? (maxNestingDepth - 4) * 2 : 0;
  const gotoPenalty = gotoCount * 3;
  const sizePenalty = codeLines > 500 ? Math.floor((codeLines - 500) / 100) : 0;
  const riskScore = cyclomaticComplexity + depthPenalty + gotoPenalty + sizePenalty;

  const commentRatio = codeLines > 0 ? Math.round((commentLines / codeLines) * 10) : 0;

  return {
    filePath,
    module,
    extension,
    totalLines: lines.length,
    codeLines,
    commentLines,
    blankLines,
    commentRatio,
    cyclomaticComplexity,
    maxNestingDepth,
    gotoCount,
    performCount,
    callCount,
    copyCount,
    ifCount,
    evaluateCount,
    riskScore,
  };
}

/**
 * Classify risk level from score.
 */
export function classifyRisk(riskScore: number): 'low' | 'medium' | 'high' | 'critical' {
  if (riskScore <= RISK_THRESHOLDS.low) return 'low';
  if (riskScore <= RISK_THRESHOLDS.medium) return 'medium';
  if (riskScore <= RISK_THRESHOLDS.high) return 'high';
  return 'critical';
}

/**
 * Aggregate multiple scores into a scan result.
 */
export function aggregateScores(scores: ComplexityScore[], elapsedSec: number): ComplexityScan {
  const n = scores.length;
  let totalGotos = 0;
  let sumCyclomatic = 0;
  let sumRisk = 0;
  let sumLines = 0;
  let lowCount = 0;
  let mediumCount = 0;
  let highCount = 0;
  let criticalCount = 0;

  for (const s of scores) {
    totalGotos += s.gotoCount;
    sumCyclomatic += s.cyclomaticComplexity;
    sumRisk += s.riskScore;
    sumLines += s.totalLines;
    const risk = classifyRisk(s.riskScore);
    if (risk === 'low') lowCount++;
    else if (risk === 'medium') mediumCount++;
    else if (risk === 'high') highCount++;
    else criticalCount++;
  }

  return {
    id: `scan_${Date.now()}`,
    totalFiles: n,
    avgCyclomatic: n > 0 ? Math.round(sumCyclomatic / n) : 0,
    avgRiskScore: n > 0 ? Math.round(sumRisk / n) : 0,
    avgLines: n > 0 ? Math.round(sumLines / n) : 0,
    totalGotos,
    lowCount,
    mediumCount,
    highCount,
    criticalCount,
    elapsedSec,
    scannedAt: new Date().toISOString(),
    scores,
  };
}

// ── Internal Helpers ────────────────────────────────────────

function stripSequenceArea(line: string, platform: 'mainframe' | 'as400'): string {
  if (platform === 'mainframe') {
    // Columns 1-6 sequence, 7 indicator, 8-72 text area, 73-80 identification
    return line.length > 6 ? line.substring(6, Math.min(line.length, 72)) : '';
  }
  // AS/400: columns 1-5 sequence (optional), 6 indicator, 7-80 text
  return line.length > 5 ? line.substring(5) : line;
}

function isComment(strippedLine: string, platform: 'mainframe' | 'as400'): boolean {
  if (!strippedLine || strippedLine.length === 0) return false;
  const indicator = strippedLine[0];
  if (platform === 'mainframe') {
    return indicator === '*' || indicator === '/';
  }
  // AS/400: * in column 7 (position 0 after stripping 5-char sequence area)
  return indicator === '*' || indicator === '/';
}

function countKeyword(upper: string, keyword: string): number {
  let count = 0;
  let idx = upper.indexOf(keyword);
  while (idx !== -1) {
    count++;
    idx = upper.indexOf(keyword, idx + keyword.length);
  }
  return count;
}

function extractModule(filePath: string): string {
  const parts = filePath.replace(/\\/g, '/').split('/');
  // Return parent directory as module name
  return parts.length >= 2 ? parts[parts.length - 2] : '';
}
