import * as fs from 'node:fs';
import * as path from 'node:path';

export interface Finding {
  id: string;
  filePath: string;
  line?: number;
  severity: 'info' | 'warning' | 'error';
  category: 'complexity' | 'dead-code' | 'security' | 'style' | 'maintenance';
  message: string;
  dismissed: boolean;
}

/**
 * Background code scanner that detects issues proactively.
 * Scans files for complexity, dead code, security issues, and style problems.
 */
export class FindingsScanner {
  private findings: Map<string, Finding[]> = new Map();
  private workspaceRoot: string;
  private nextId: number = 1;

  constructor(workspaceRoot: string) {
    this.workspaceRoot = workspaceRoot;
  }

  /** Scan a single file and update findings */
  scanFile(filePath: string): Finding[] {
    // Support both absolute and relative paths
    const fullPath = path.isAbsolute(filePath)
      ? filePath
      : path.resolve(this.workspaceRoot, filePath);
    if (!fs.existsSync(fullPath)) {
      this.findings.delete(filePath);
      return [];
    }

    const content = fs.readFileSync(fullPath, 'utf-8');
    const lines = content.split('\n');
    const fileFindings: Finding[] = [];

    // Determine file type for rule selection
    const isCobol = /\.(cob|cbl|cpy|sqb|pco|cblcpy|sbc|ccp|ccc|cbe|rmc|obs)$/i.test(filePath);
    const isCl = /\.(clp|clle|cmd)$/i.test(filePath);
    const isLegacy =
      isCobol || isCl || /\.(rpg|rpgle|sqlrpgle|sqlrpg|pli|pl1|dds|pf|lf)$/i.test(filePath);

    // Generic rules only for modern languages (not COBOL/CL/RPG)
    if (!isLegacy) {
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const trimmed = line.trim();
        const lineNum = i + 1;

        // Security: Hardcoded secrets
        if (/(?:password|secret|token|api_key)\s*[:=]\s*['"][^'"]{4,}['"]/i.test(trimmed)) {
          fileFindings.push(
            this.createFinding(filePath, lineNum, 'error', 'security', 'Possible hardcoded secret'),
          );
        }

        // Security: SQL injection patterns
        if (
          /(?:query|execute|sql)\s*\(\s*[`'"]\s*(?:SELECT|INSERT|UPDATE|DELETE).*\$\{/i.test(
            trimmed,
          )
        ) {
          fileFindings.push(
            this.createFinding(
              filePath,
              lineNum,
              'error',
              'security',
              'Potential SQL injection — use parameterized queries',
            ),
          );
        }

        // Complexity: deeply nested code (5+ levels of indentation)
        const leadingSpaces = line.match(/^(\s*)/)?.[1]?.length ?? 0;
        const indentLevel = Math.floor(leadingSpaces / 2);
        if (indentLevel >= 6 && trimmed.length > 0) {
          fileFindings.push(
            this.createFinding(
              filePath,
              lineNum,
              'warning',
              'complexity',
              `Deeply nested code (${indentLevel} levels) — consider extracting`,
            ),
          );
        }

        // Style: lines > 120 chars
        if (line.length > 150) {
          fileFindings.push(
            this.createFinding(
              filePath,
              lineNum,
              'info',
              'style',
              `Line length ${line.length} exceeds 150 characters`,
            ),
          );
        }

        // Maintenance: TODO/FIXME/HACK markers
        const todoMatch = trimmed.match(/\b(TODO|FIXME|HACK|XXX)\b:?\s*(.*)/i);
        if (todoMatch) {
          fileFindings.push(
            this.createFinding(
              filePath,
              lineNum,
              'info',
              'maintenance',
              `${todoMatch[1]}: ${todoMatch[2] || '(no description)'}`,
            ),
          );
        }

        // Dead code: commented-out code blocks
        if (/^\/\/\s*(const|let|var|function|class|import|export|if|for|while)\b/.test(trimmed)) {
          fileFindings.push(
            this.createFinding(
              filePath,
              lineNum,
              'info',
              'dead-code',
              'Commented-out code — consider removing',
            ),
          );
        }
      }
    } // end if (!isLegacy)

    // File-level checks (apply to all)
    if (lines.length > 500 && !isLegacy) {
      fileFindings.push(
        this.createFinding(
          filePath,
          undefined,
          'warning',
          'complexity',
          `Large file (${lines.length} lines) — consider splitting`,
        ),
      );
    }

    // COBOL / CL-specific rules
    if (isCobol) {
      this.scanCobolRules(filePath, lines, fileFindings);
    } else if (isCl) {
      this.scanClRules(filePath, lines, fileFindings);
    }

    this.findings.set(filePath, fileFindings);
    return fileFindings;
  }

  /** Scan all supported files in the workspace */
  scanWorkspace(_patterns: string[] = ['**/*.ts', '**/*.js', '**/*.py']): Finding[] {
    const allFindings: Finding[] = [];
    const files = this.collectFiles(this.workspaceRoot, 5);

    for (const file of files) {
      const relPath = path.relative(this.workspaceRoot, file).replace(/\\/g, '/');
      const findings = this.scanFile(relPath);
      allFindings.push(...findings);
    }

    return allFindings;
  }

  /** Get all current findings */
  getAllFindings(): Finding[] {
    const all: Finding[] = [];
    for (const findings of this.findings.values()) {
      all.push(...findings.filter((f) => !f.dismissed));
    }
    return all.sort((a, b) => {
      const severityOrder = { error: 0, warning: 1, info: 2 };
      return severityOrder[a.severity] - severityOrder[b.severity];
    });
  }

  /** Get findings for a specific file */
  getFileFindings(filePath: string): Finding[] {
    return (this.findings.get(filePath) ?? []).filter((f) => !f.dismissed);
  }

  /** Get findings grouped by file */
  getGroupedFindings(): Map<string, Finding[]> {
    const grouped = new Map<string, Finding[]>();
    for (const [file, findings] of this.findings) {
      const active = findings.filter((f) => !f.dismissed);
      if (active.length > 0) {
        grouped.set(file, active);
      }
    }
    return grouped;
  }

  /** Dismiss a finding by ID */
  dismiss(findingId: string): boolean {
    for (const findings of this.findings.values()) {
      const finding = findings.find((f) => f.id === findingId);
      if (finding) {
        finding.dismissed = true;
        return true;
      }
    }
    return false;
  }

  /** Get finding counts by severity */
  getCounts(): { error: number; warning: number; info: number; total: number } {
    const all = this.getAllFindings();
    return {
      error: all.filter((f) => f.severity === 'error').length,
      warning: all.filter((f) => f.severity === 'warning').length,
      info: all.filter((f) => f.severity === 'info').length,
      total: all.length,
    };
  }

  private createFinding(
    filePath: string,
    line: number | undefined,
    severity: Finding['severity'],
    category: Finding['category'],
    message: string,
  ): Finding {
    return {
      id: `finding_${this.nextId++}`,
      filePath,
      line,
      severity,
      category,
      message,
      dismissed: false,
    };
  }

  /** COBOL-specific quality rules */
  private scanCobolRules(filePath: string, lines: string[], findings: Finding[]): void {
    let paragraphStart = -1;
    let paragraphName = '';
    const paragraphNames: string[] = [];
    const referencedParagraphs = new Set<string>();
    let gotoCount = 0;

    // Detect if file uses sequence numbers (columns 73-80)
    const hasSeqNums =
      lines.length > 10 &&
      lines.slice(0, 20).some((l) => l.length > 72 && /^\d{6,8}$/.test(l.substring(72).trim()));

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const lineNum = i + 1;
      // Code area: columns 7-72 (skip indicator in col 7, sequence in col 73-80)
      const rawCodeArea = line.length > 6 ? line.substring(6) : '';
      const codeArea = hasSeqNums && line.length > 72 ? line.substring(6, 72) : rawCodeArea;
      const isComment = line.length > 6 && line[6] === '*';
      if (isComment || codeArea.trim() === '') continue;

      const trimmedCode = codeArea.trim().toUpperCase();

      // Rule: GO TO statements
      if (/\bGO\s+TO\b/.test(trimmedCode)) {
        gotoCount++;
        findings.push(
          this.createFinding(
            filePath,
            lineNum,
            'warning',
            'maintenance',
            'GO TO statement — consider structured alternatives (PERFORM)',
          ),
        );
        const target = trimmedCode.match(/GO\s+TO\s+([A-Z0-9-]+)/)?.[1];
        if (target) referencedParagraphs.add(target);
      }

      // Rule: PERFORM references
      const performMatch = trimmedCode.match(/\bPERFORM\s+([A-Z0-9][A-Z0-9-]*)/);
      if (performMatch && performMatch[1] !== 'VARYING' && performMatch[1] !== 'UNTIL') {
        referencedParagraphs.add(performMatch[1]);
        const thruMatch = trimmedCode.match(/\bTHRU\s+([A-Z0-9][A-Z0-9-]*)/);
        if (thruMatch) referencedParagraphs.add(thruMatch[1]);
      }

      // Detect paragraph/section headers (skip division keywords)
      if (line.length > 7 && /[A-Z0-9]/.test(line[7] || '')) {
        const headerMatch = codeArea.match(/^\s{0,4}([A-Z0-9][A-Z0-9-]*)\s*(\.\s*$|SECTION\s*\.)/);
        if (
          headerMatch &&
          !/^(WORKING-STORAGE|LINKAGE|FILE|LOCAL-STORAGE|DATA|PROCEDURE|IDENTIFICATION|ENVIRONMENT|CONFIGURATION|INPUT-OUTPUT|REPORT|SCREEN|COMMUNICATION)$/.test(
            headerMatch[1],
          )
        ) {
          if (paragraphStart > 0) {
            const length = i - paragraphStart;
            if (length > 100) {
              findings.push(
                this.createFinding(
                  filePath,
                  paragraphStart + 1,
                  'warning',
                  'complexity',
                  `Paragraph ${paragraphName} is ${length} lines — consider splitting`,
                ),
              );
            }
          }
          paragraphName = headerMatch[1];
          paragraphStart = i;
          paragraphNames.push(paragraphName);
        }
      }

      // Rule: Magic numbers in operations
      const magicMatch = trimmedCode.match(/\b(?:MOVE|IF|COMPUTE|ADD|SUBTRACT)\b.*\b(\d{3,})\b/);
      if (magicMatch && !['000', '100', '999'].includes(magicMatch[1])) {
        findings.push(
          this.createFinding(
            filePath,
            lineNum,
            'info',
            'style',
            `Magic number ${magicMatch[1]} — consider using a named constant`,
          ),
        );
      }

      // Rule: Debug DISPLAY
      if (/^\s*DISPLAY\s+['"](?:DEBUG|TRACE|TEST)/i.test(codeArea)) {
        findings.push(
          this.createFinding(
            filePath,
            lineNum,
            'info',
            'maintenance',
            'Debug DISPLAY statement — remove before production',
          ),
        );
      }
    }

    // Last paragraph length
    if (paragraphStart > 0) {
      const length = lines.length - paragraphStart;
      if (length > 100) {
        findings.push(
          this.createFinding(
            filePath,
            paragraphStart + 1,
            'warning',
            'complexity',
            `Paragraph ${paragraphName} is ${length} lines — consider splitting`,
          ),
        );
      }
    }

    // Dead paragraph detection
    const COBOL_DIVISIONS = new Set([
      'WORKING-STORAGE',
      'LINKAGE',
      'FILE',
      'LOCAL-STORAGE',
      'COMMUNICATION',
      'REPORT',
      'SCREEN',
      'IDENTIFICATION',
      'ENVIRONMENT',
      'DATA',
      'PROCEDURE',
      'CONFIGURATION',
      'INPUT-OUTPUT',
    ]);
    for (let idx = 1; idx < paragraphNames.length; idx++) {
      const name = paragraphNames[idx];
      if (
        !referencedParagraphs.has(name) &&
        !name.endsWith('-EXIT') &&
        !name.endsWith('-END') &&
        !COBOL_DIVISIONS.has(name)
      ) {
        findings.push(
          this.createFinding(
            filePath,
            undefined,
            'info',
            'dead-code',
            `Paragraph ${name} may be unreferenced — verify usage`,
          ),
        );
      }
    }

    // Excessive GO TO
    if (gotoCount > 10) {
      findings.push(
        this.createFinding(
          filePath,
          undefined,
          'warning',
          'maintenance',
          'Excessive GO TO usage — program may benefit from restructuring',
        ),
      );
    }
  }

  /** CL-specific quality rules */
  private scanClRules(filePath: string, lines: string[], findings: Finding[]): void {
    let hasMonMsg = false;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const trimmed = line.trim().toUpperCase();
      if (trimmed.startsWith('/*')) continue;

      if (/\bMONMSG\b/.test(trimmed)) hasMonMsg = true;

      if (/\bGOTO\b/.test(trimmed)) {
        findings.push(
          this.createFinding(
            filePath,
            i + 1,
            'warning',
            'maintenance',
            'GOTO in CL program — consider using SUBR/ENDSUBR',
          ),
        );
      }

      if (
        /\bLIB\s*\(\s*[A-Z][A-Z0-9]{2,}\s*\)/i.test(trimmed) &&
        !/\*LIBL|\*CURLIB/.test(trimmed)
      ) {
        findings.push(
          this.createFinding(
            filePath,
            i + 1,
            'info',
            'maintenance',
            'Hardcoded library name — consider using *LIBL or a variable',
          ),
        );
      }
    }

    if (!hasMonMsg && lines.length > 20) {
      findings.push(
        this.createFinding(
          filePath,
          undefined,
          'warning',
          'security',
          'No MONMSG found — program lacks error handling',
        ),
      );
    }
  }

  private collectFiles(dir: string, maxDepth: number, depth: number = 0): string[] {
    if (depth > maxDepth) return [];
    const files: string[] = [];
    try {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (['node_modules', '.git', 'dist', '.OpenCob', 'coverage'].includes(entry.name)) continue;
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          files.push(...this.collectFiles(full, maxDepth, depth + 1));
        } else if (
          /\.(ts|tsx|js|jsx|py|java|go|cob|sbc|ccp|ccc|cbe|cbl|cpy|sqb|pco|cblcpy|rmc|obs|clle|clp|cmd|mnu|rpg|rpgle|sqlrpgle|sqlrpg|pli|pl1|inc|dds|pf|lf)$/i.test(
            entry.name,
          )
        ) {
          files.push(full);
        }
      }
    } catch {
      // Skip directories we can't read
    }
    return files;
  }
}
