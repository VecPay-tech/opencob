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
    const fullPath = path.resolve(this.workspaceRoot, filePath);
    if (!fs.existsSync(fullPath)) {
      this.findings.delete(filePath);
      return [];
    }

    const content = fs.readFileSync(fullPath, 'utf-8');
    const lines = content.split('\n');
    const fileFindings: Finding[] = [];

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const trimmed = line.trim();
      const lineNum = i + 1;

      // Security: Hardcoded secrets
      if (/(?:password|secret|token|api_key)\s*[:=]\s*['"][^'"]{4,}['"]/i.test(trimmed)) {
        fileFindings.push(this.createFinding(filePath, lineNum, 'error', 'security', 'Possible hardcoded secret'));
      }

      // Security: SQL injection patterns
      if (/(?:query|execute|sql)\s*\(\s*[`'"]\s*(?:SELECT|INSERT|UPDATE|DELETE).*\$\{/i.test(trimmed)) {
        fileFindings.push(this.createFinding(filePath, lineNum, 'error', 'security', 'Potential SQL injection — use parameterized queries'));
      }

      // Complexity: deeply nested code (5+ levels of indentation)
      const leadingSpaces = line.match(/^(\s*)/)?.[1]?.length ?? 0;
      const indentLevel = Math.floor(leadingSpaces / 2);
      if (indentLevel >= 6 && trimmed.length > 0) {
        fileFindings.push(this.createFinding(filePath, lineNum, 'warning', 'complexity', `Deeply nested code (${indentLevel} levels) — consider extracting`));
      }

      // Style: lines > 120 chars
      if (line.length > 150) {
        fileFindings.push(this.createFinding(filePath, lineNum, 'info', 'style', `Line length ${line.length} exceeds 150 characters`));
      }

      // Maintenance: TODO/FIXME/HACK markers
      const todoMatch = trimmed.match(/\b(TODO|FIXME|HACK|XXX)\b:?\s*(.*)/i);
      if (todoMatch) {
        fileFindings.push(this.createFinding(filePath, lineNum, 'info', 'maintenance', `${todoMatch[1]}: ${todoMatch[2] || '(no description)'}`));
      }

      // Dead code: commented-out code blocks
      if (/^\/\/\s*(const|let|var|function|class|import|export|if|for|while)\b/.test(trimmed)) {
        fileFindings.push(this.createFinding(filePath, lineNum, 'info', 'dead-code', 'Commented-out code — consider removing'));
      }
    }

    // File-level checks
    if (lines.length > 500) {
      fileFindings.push(this.createFinding(filePath, undefined, 'warning', 'complexity', `Large file (${lines.length} lines) — consider splitting`));
    }

    this.findings.set(filePath, fileFindings);
    return fileFindings;
  }

  /** Scan all supported files in the workspace */
  scanWorkspace(patterns: string[] = ['**/*.ts', '**/*.js', '**/*.py']): Finding[] {
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
        } else if (/\.(ts|tsx|js|jsx|py|java|go|cob|cbl|rpg)$/i.test(entry.name)) {
          files.push(full);
        }
      }
    } catch {
      // Skip directories we can't read
    }
    return files;
  }
}
