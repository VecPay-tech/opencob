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
    const isJcl = /\.(jcl|job|proc)$/i.test(filePath);
    const isRexx = /\.(rexx|rex|exec)$/i.test(filePath);
    const isNatural = /\.(nsp|nsa|nsg|nsl|nsh|nat)$/i.test(filePath);
    const isAsm = /\.(asm|hlasm|s|mac)$/i.test(filePath);
    const isLegacy =
      isCobol ||
      isCl ||
      isJcl ||
      isRexx ||
      isNatural ||
      isAsm ||
      /\.(rpg|rpgle|sqlrpgle|sqlrpg|pli|pl1|dds|pf|lf)$/i.test(filePath);

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
    } else if (isJcl) {
      this.scanJclRules(filePath, lines, fileFindings);
    } else if (isRexx) {
      this.scanRexxRules(filePath, lines, fileFindings);
    } else if (isNatural) {
      this.scanNaturalRules(filePath, lines, fileFindings);
    } else if (isAsm) {
      this.scanAsmRules(filePath, lines, fileFindings);
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
    const declarativeParagraphs = new Set<string>();
    const thruRanges: Array<{ from: string; to: string }> = [];
    let gotoCount = 0;
    let inDeclaratives = false;
    let passedProcedureDiv = false;
    let firstProcParagraph = '';
    // Track section membership: section name → list of paragraph names within it
    const sectionParagraphs = new Map<string, string[]>();
    let currentSection = '';
    let pendingPerform = ''; // For multi-line PERFORM...THRU

    // Resolve COPY book references to find PERFORM/GO TO in included code
    this.resolveCobolCopyBooks(filePath, lines, referencedParagraphs, thruRanges);

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

      // Track PROCEDURE DIVISION entry
      if (/^\s*PROCEDURE\s+DIVISION/.test(trimmedCode)) {
        passedProcedureDiv = true;
        continue;
      }

      // Track DECLARATIVES section (system-invoked, not dead code)
      if (/^\s*DECLARATIVES\s*\.\s*$/.test(trimmedCode)) {
        inDeclaratives = true;
        continue;
      }
      if (/^\s*END\s+DECLARATIVES\s*\.\s*$/.test(trimmedCode)) {
        inDeclaratives = false;
        currentSection = '';
        continue;
      }

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

      // Rule: PERFORM references (handle multi-line PERFORM...THRU)
      const performMatch = trimmedCode.match(/\bPERFORM\s+([A-Z0-9][A-Z0-9-]*)/);
      if (performMatch && performMatch[1] !== 'VARYING' && performMatch[1] !== 'UNTIL') {
        referencedParagraphs.add(performMatch[1]);
        const thruMatch = trimmedCode.match(/\bTHRU\s+([A-Z0-9][A-Z0-9-]*)/);
        if (thruMatch) {
          referencedParagraphs.add(thruMatch[1]);
          thruRanges.push({ from: performMatch[1], to: thruMatch[1] });
          pendingPerform = '';
        } else {
          // THRU may be on the next line
          pendingPerform = performMatch[1];
        }
      } else if (pendingPerform && /^\s*THRU\s+([A-Z0-9][A-Z0-9-]*)/.test(trimmedCode)) {
        // Continuation of previous PERFORM with THRU on this line
        const thruMatch = trimmedCode.match(/\bTHRU\s+([A-Z0-9][A-Z0-9-]*)/);
        if (thruMatch) {
          referencedParagraphs.add(thruMatch[1]);
          thruRanges.push({ from: pendingPerform, to: thruMatch[1] });
        }
        pendingPerform = '';
      } else {
        pendingPerform = '';
      }

      // Detect paragraph/section headers (skip division keywords)
      if (line.length > 7 && /[A-Z0-9]/.test(line[7] || '')) {
        const headerMatch = codeArea.match(/^\s{0,4}([A-Z0-9][A-Z0-9-]*)\s*(\.\s*$|SECTION\s*\.)/);
        if (
          headerMatch &&
          !/^(WORKING-STORAGE|LINKAGE|FILE|LOCAL-STORAGE|DATA|PROCEDURE|IDENTIFICATION|ENVIRONMENT|CONFIGURATION|INPUT-OUTPUT|FILE-CONTROL|I-O-CONTROL|REPORT|SCREEN|COMMUNICATION)$/.test(
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

          // Track section membership
          const isSection = /SECTION\s*\.$/.test(headerMatch[0]);
          if (isSection) {
            currentSection = paragraphName;
            sectionParagraphs.set(currentSection, []);
          } else if (currentSection) {
            sectionParagraphs.get(currentSection)!.push(paragraphName);
          }

          if (inDeclaratives) {
            declarativeParagraphs.add(paragraphName);
          }
          // First paragraph/section after PROCEDURE DIVISION is entry point
          if (passedProcedureDiv && !inDeclaratives && !firstProcParagraph) {
            firstProcParagraph = paragraphName;
          }
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
    // First, resolve PERFORM...THRU ranges — all paragraphs between
    // start and end of a THRU range are implicitly executed (fall-through)
    for (const range of thruRanges) {
      const fromIdx = paragraphNames.indexOf(range.from);
      const toIdx = paragraphNames.indexOf(range.to);
      if (fromIdx >= 0 && toIdx >= 0) {
        const start = Math.min(fromIdx, toIdx);
        const end = Math.max(fromIdx, toIdx);
        for (let idx = start; idx <= end; idx++) {
          referencedParagraphs.add(paragraphNames[idx]);
        }
      }
    }

    // Mark the entry point (first section/paragraph after PROCEDURE DIVISION)
    if (firstProcParagraph) {
      referencedParagraphs.add(firstProcParagraph);
      // Also mark the first paragraph inside the entry section
      const entryIdx = paragraphNames.indexOf(firstProcParagraph);
      if (entryIdx >= 0 && entryIdx + 1 < paragraphNames.length) {
        referencedParagraphs.add(paragraphNames[entryIdx + 1]);
      }
    }

    // When a SECTION is explicitly PERFORMed, all paragraphs within it are reachable.
    // Exception: the entry section (first after PROCEDURE DIVISION) — its paragraphs
    // are NOT all reachable just by being the entry point; control is managed via PERFORM/GO TO.
    for (const [sectionName, paragraphs] of sectionParagraphs) {
      if (referencedParagraphs.has(sectionName) && sectionName !== firstProcParagraph) {
        for (const para of paragraphs) {
          referencedParagraphs.add(para);
        }
      }
    }

    const COBOL_KEYWORDS = new Set([
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
      'FILE-CONTROL',
      'I-O-CONTROL',
    ]);
    // Build set of paragraphs inside dead sections (to avoid redundant reports)
    const insideDeadSection = new Set<string>();
    for (const [sectionName, paragraphs] of sectionParagraphs) {
      if (!referencedParagraphs.has(sectionName)) {
        for (const para of paragraphs) {
          insideDeadSection.add(para);
        }
      }
    }

    for (let idx = 1; idx < paragraphNames.length; idx++) {
      const name = paragraphNames[idx];
      if (
        !referencedParagraphs.has(name) &&
        !declarativeParagraphs.has(name) &&
        !insideDeadSection.has(name) &&
        !name.endsWith('-EXIT') &&
        !name.endsWith('-END') &&
        !COBOL_KEYWORDS.has(name)
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

  /**
   * Resolve COPY book references and extract PERFORM/GO TO from them.
   * This prevents false "dead code" findings when a paragraph is
   * PERFORMed from within an included copybook.
   */
  private resolveCobolCopyBooks(
    filePath: string,
    lines: string[],
    referencedParagraphs: Set<string>,
    thruRanges: Array<{ from: string; to: string }>,
  ): void {
    const sourceDir = path.dirname(filePath);
    // Walk up to find the workspace source root (look for common lib patterns)
    const sourceRoot = this.findSourceRoot(sourceDir);
    const searchDirs = sourceRoot ? [sourceDir, sourceRoot] : [sourceDir];

    for (const line of lines) {
      const codeArea = line.length > 6 ? line.substring(6) : '';
      if (line.length > 6 && line[6] === '*') continue;
      const trimmed = codeArea.trim().toUpperCase();

      // Match: COPY copyname OF libname.
      // or:    COPY copyname.
      const copyMatch = trimmed.match(
        /^\s*COPY\s+([A-Z0-9][A-Z0-9-]*)\s*(?:OF|IN)?\s*([A-Z0-9-]*)/,
      );
      if (!copyMatch) continue;

      const copyName = copyMatch[1].toLowerCase();
      const libName = (copyMatch[2] || '').toLowerCase();

      // Try to find the copybook file
      const copyPath = this.findCopyBook(copyName, libName, searchDirs);
      if (!copyPath) continue;

      // Extract PERFORM and GO TO references from the copybook
      try {
        const content = fs.readFileSync(copyPath, 'utf-8');
        const copyLines = content.split('\n');
        for (const cl of copyLines) {
          const ca = cl.length > 6 ? cl.substring(6) : '';
          if (cl.length > 6 && cl[6] === '*') continue;
          const ct = ca.trim().toUpperCase();

          const perfMatch = ct.match(/\bPERFORM\s+([A-Z0-9][A-Z0-9-]*)/);
          if (perfMatch && perfMatch[1] !== 'VARYING' && perfMatch[1] !== 'UNTIL') {
            referencedParagraphs.add(perfMatch[1]);
            const thruMatch = ct.match(/\bTHRU\s+([A-Z0-9][A-Z0-9-]*)/);
            if (thruMatch) {
              referencedParagraphs.add(thruMatch[1]);
              thruRanges.push({ from: perfMatch[1], to: thruMatch[1] });
            }
          }

          const gotoMatch = ct.match(/\bGO\s+TO\s+([A-Z0-9][A-Z0-9-]+)/);
          if (gotoMatch) referencedParagraphs.add(gotoMatch[1]);
        }
      } catch {
        // copybook not readable, skip
      }
    }
  }

  /**
   * Find the source root by walking up from a directory.
   * Looks for a directory named "source" or a directory that contains
   * multiple library-like subdirectories (with cpysrc/cblsrc children).
   */
  private findSourceRoot(dir: string): string | null {
    let current = dir;
    for (let i = 0; i < 8; i++) {
      const parent = path.dirname(current);
      if (parent === current) break;
      const baseName = path.basename(current).toLowerCase();
      if (baseName === 'source') return current;
      // Also check if current dir looks like a source root (has lib subdirs)
      try {
        const children = fs.readdirSync(current, { withFileTypes: true });
        const libDirs = children.filter(
          (c) => c.isDirectory() && fs.existsSync(path.join(current, c.name, 'cpysrc')),
        );
        if (libDirs.length >= 2) return current;
      } catch {
        // skip
      }
      current = parent;
    }
    return null;
  }

  /**
   * Locate a copybook file by name and optional library.
   * Searches the entire source root for all cpysrc directories.
   */
  private findCopyBook(name: string, lib: string, searchDirs: string[]): string | null {
    const extensions = ['.cpy', '.cbl', '.cbk', '.copy', ''];

    // First: try same directory as source file
    for (const dir of searchDirs) {
      for (const ext of extensions) {
        const candidate = path.join(dir, name + ext);
        if (fs.existsSync(candidate)) return candidate;
      }
    }

    // Second: if a specific library was given, try that library's cpysrc
    for (const dir of searchDirs) {
      if (lib && lib !== '*libl') {
        for (const sub of ['cpysrc', 'cblcpy', 'qcpysrc', '']) {
          for (const ext of extensions) {
            const candidate = path.join(dir, lib, sub, name + ext);
            if (fs.existsSync(candidate)) return candidate;
          }
        }
      }
    }

    // Third: search ALL library directories under the source root
    // This handles COPY ... OF *LIBL or when the library search didn't match
    for (const dir of searchDirs) {
      try {
        const libs = fs.readdirSync(dir, { withFileTypes: true });
        for (const libDir of libs) {
          if (!libDir.isDirectory()) continue;
          for (const sub of ['cpysrc', 'cblcpy', 'qcpysrc']) {
            for (const ext of extensions) {
              const candidate = path.join(dir, libDir.name, sub, name + ext);
              if (fs.existsSync(candidate)) return candidate;
            }
          }
        }
      } catch {
        // can't read directory, skip
      }
    }

    return null;
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

  /** JCL-specific quality rules */
  private scanJclRules(filePath: string, lines: string[], findings: Finding[]): void {
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (line.startsWith('//*')) continue;

      if (/DISP=\(NEW,DELETE\)/i.test(line)) {
        findings.push(
          this.createFinding(
            filePath,
            i + 1,
            'warning',
            'maintenance',
            'DD statement deletes dataset on normal termination — verify intent',
          ),
        );
      }

      if (/EXEC\s+PGM=IEFBR14/i.test(line)) {
        findings.push(
          this.createFinding(
            filePath,
            i + 1,
            'info',
            'maintenance',
            'IEFBR14 step — typically used for DD allocation/deletion only',
          ),
        );
      }
    }
  }

  /** REXX-specific quality rules */
  private scanRexxRules(filePath: string, lines: string[], findings: Finding[]): void {
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const trimmed = line.trim();
      if (trimmed.startsWith('/*') || trimmed.startsWith('--')) continue;

      if (/\bINTERPRET\b/i.test(trimmed)) {
        findings.push(
          this.createFinding(
            filePath,
            i + 1,
            'warning',
            'security',
            'INTERPRET executes dynamic code — review for injection risk',
          ),
        );
      }

      if (/\bPARSE\s+EXTERNAL\b/i.test(trimmed)) {
        findings.push(
          this.createFinding(
            filePath,
            i + 1,
            'info',
            'maintenance',
            'PARSE EXTERNAL reads from stdin — ensure caller provides input',
          ),
        );
      }
    }
  }

  /** NATURAL-specific quality rules */
  private scanNaturalRules(filePath: string, lines: string[], findings: Finding[]): void {
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const trimmed = line.trim();
      if (trimmed.startsWith('*')) continue;

      if (/\bDYNAMIC\b/i.test(trimmed)) {
        findings.push(
          this.createFinding(
            filePath,
            i + 1,
            'warning',
            'complexity',
            'DYNAMIC attribute — runtime-sized variable, watch memory allocation',
          ),
        );
      }

      if (/\bHISTOGRAM\b/i.test(trimmed)) {
        findings.push(
          this.createFinding(
            filePath,
            i + 1,
            'info',
            'maintenance',
            'HISTOGRAM performs an index scan — verify the DDM index exists',
          ),
        );
      }
    }
  }

  /** Assembler-specific quality rules */
  private scanAsmRules(filePath: string, lines: string[], findings: Finding[]): void {
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (line.startsWith('*') || line.trim() === '') continue;

      if (/\bMVC\s+\d+\([^,]+\),\s*\d+\(/i.test(line)) {
        findings.push(
          this.createFinding(
            filePath,
            i + 1,
            'warning',
            'maintenance',
            'MVC with explicit lengths — verify source and target lengths match',
          ),
        );
      }

      if (/\bBALR\s+14,0\b/i.test(line)) {
        findings.push(
          this.createFinding(
            filePath,
            i + 1,
            'info',
            'maintenance',
            'BALR 14,0 loads current PSW without branching — typically for base-register setup',
          ),
        );
      }
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
