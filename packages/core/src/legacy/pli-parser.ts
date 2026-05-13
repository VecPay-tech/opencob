import * as fs from 'node:fs';
import * as path from 'node:path';
import type { CodeDefinition, FileDependency } from '../indexer/workspace-indexer.js';

/**
 * PL/I Language Parser — extracts structure from PL/I source files.
 *
 * Supports:
 *  - PROCEDURE extraction (external and internal)
 *  - DECLARE / DCL statement parsing
 *  - %INCLUDE directive resolution
 *  - CALL statement chain analysis
 *  - EXEC SQL / EXEC CICS detection
 *  - Structure/record extraction
 *
 * Referenced in: OPENCOB_COMMUNITY_EDITION.md §Legacy Languages
 */

export interface PliProcedure {
  name: string;
  line: number;
  endLine: number;
  type: 'external' | 'internal';
  parameters: string[];
  returns?: string;
}

export interface PliDeclaration {
  name: string;
  type: string;
  line: number;
  attributes: string[];
  level?: number;
}

export interface PliStructure {
  name: string;
  line: number;
  members: Array<{ name: string; type: string; level: number; line: number }>;
}

export interface PliInclude {
  name: string;
  line: number;
  resolvedPath?: string;
}

export interface PliProgram {
  filePath: string;
  procedures: PliProcedure[];
  declarations: PliDeclaration[];
  structures: PliStructure[];
  includes: PliInclude[];
  callStatements: Array<{ target: string; line: number }>;
  execSql: Array<{ statement: string; line: number }>;
  execCics: Array<{ statement: string; line: number }>;
  entryPoints: string[];
}

export class PliParser {
  private includePaths: string[];

  constructor(includePaths: string[] = []) {
    this.includePaths = includePaths;
  }

  /** Parse a PL/I source file */
  parse(content: string, filePath: string): PliProgram {
    const lines = content.split('\n');
    const program: PliProgram = {
      filePath,
      procedures: [],
      declarations: [],
      structures: [],
      includes: [],
      callStatements: [],
      execSql: [],
      execCics: [],
      entryPoints: [],
    };

    let currentProc: PliProcedure | null = null;
    let currentStruct: PliStructure | null = null;
    let inExecBlock = false;
    let execBuffer = '';
    let execStartLine = 0;
    let execType: 'sql' | 'cics' | null = null;

    for (let i = 0; i < lines.length; i++) {
      const lineNum = i + 1;
      const raw = lines[i];
      const trimmed = raw.trim();

      // Skip comments (/* ... */ single line or PL/I-style)
      if (trimmed.startsWith('/*') && trimmed.endsWith('*/')) continue;
      if (trimmed.startsWith('//') || trimmed.startsWith('*')) continue;

      // ── EXEC SQL / EXEC CICS blocks ──────────────────────────────

      if (inExecBlock) {
        execBuffer += ' ' + trimmed;
        if (trimmed.includes(';')) {
          const stmt = execBuffer.replace(/\s+/g, ' ').trim().replace(/;$/, '');
          if (execType === 'sql') {
            program.execSql.push({ statement: stmt, line: execStartLine });
          } else if (execType === 'cics') {
            program.execCics.push({ statement: stmt, line: execStartLine });
          }
          inExecBlock = false;
          execBuffer = '';
          execType = null;
        }
        continue;
      }

      const execSqlMatch = trimmed.match(/^EXEC\s+SQL\b/i);
      if (execSqlMatch) {
        execStartLine = lineNum;
        execType = 'sql';
        execBuffer = trimmed;
        if (trimmed.includes(';')) {
          const stmt = execBuffer.replace(/\s+/g, ' ').trim().replace(/;$/, '');
          program.execSql.push({ statement: stmt, line: lineNum });
        } else {
          inExecBlock = true;
        }
        continue;
      }

      const execCicsMatch = trimmed.match(/^EXEC\s+CICS\b/i);
      if (execCicsMatch) {
        execStartLine = lineNum;
        execType = 'cics';
        execBuffer = trimmed;
        if (trimmed.includes(';')) {
          const stmt = execBuffer.replace(/\s+/g, ' ').trim().replace(/;$/, '');
          program.execCics.push({ statement: stmt, line: lineNum });
        } else {
          inExecBlock = true;
        }
        continue;
      }

      // ── %INCLUDE directives ──────────────────────────────────────

      const includeMatch = trimmed.match(/^%INCLUDE\s+(\S+)\s*;?/i);
      if (includeMatch) {
        const includeName = includeMatch[1].replace(/['"]/g, '').replace(/;$/, '');
        const resolvedPath = this.resolveInclude(includeName);
        program.includes.push({ name: includeName, line: lineNum, resolvedPath });
        continue;
      }

      // ── PROCEDURE declarations ───────────────────────────────────

      const procMatch = trimmed.match(
        /^(\w+)\s*:\s*(?:PROC(?:EDURE)?)\s*(?:\(([^)]*)\))?\s*(?:RETURNS\s*\(([^)]*)\))?\s*(?:OPTIONS\s*\([^)]*\))?\s*;?/i,
      );
      if (procMatch) {
        if (currentProc) {
          currentProc.endLine = lineNum - 1;
          program.procedures.push(currentProc);
        }

        const procName = procMatch[1];
        const params = procMatch[2]
          ? procMatch[2]
              .split(',')
              .map((p) => p.trim())
              .filter(Boolean)
          : [];
        const returns = procMatch[3]?.trim();

        currentProc = {
          name: procName,
          line: lineNum,
          endLine: lineNum,
          type: program.procedures.length === 0 ? 'external' : 'internal',
          parameters: params,
          returns,
        };

        if (program.procedures.length === 0) {
          program.entryPoints.push(procName);
        }
        continue;
      }

      // ── END PROCEDURE ─────────────────────────────────────────────

      const endProcMatch = trimmed.match(/^END\s+(\w+)\s*;?/i);
      if (endProcMatch && currentProc) {
        if (endProcMatch[1].toUpperCase() === currentProc.name.toUpperCase()) {
          currentProc.endLine = lineNum;
          program.procedures.push(currentProc);
          currentProc = null;
        }
      }

      // ── DECLARE / DCL statements ─────────────────────────────────

      const dclMatch = trimmed.match(/^(?:DECLARE|DCL)\s+(\d+\s+)?(\w+)\s*(.*?)\s*[,;]?$/i);
      if (dclMatch) {
        const level = dclMatch[1] ? parseInt(dclMatch[1].trim(), 10) : undefined;
        const name = dclMatch[2];
        const rest = dclMatch[3] ?? '';
        const attributes = rest.split(/\s+/).filter(Boolean);

        // Detect structure start (level 1 with no type = structure)
        if (level === 1 || rest.match(/\bSTRUCTURE\b/i)) {
          if (currentStruct) {
            program.structures.push(currentStruct);
          }
          currentStruct = { name, line: lineNum, members: [] };
          continue;
        }

        // Structure member
        if (currentStruct && level && level > 1) {
          currentStruct.members.push({
            name,
            type: attributes.join(' '),
            level,
            line: lineNum,
          });
          continue;
        }

        // End current structure if we hit a level-1 or non-level declaration
        if (currentStruct && !level) {
          program.structures.push(currentStruct);
          currentStruct = null;
        }

        program.declarations.push({
          name,
          type: this.inferType(attributes),
          line: lineNum,
          attributes,
          level,
        });
        continue;
      }

      // ── CALL statements ──────────────────────────────────────────

      // ── Structure member continuation (lines like "2 CUST_ID CHAR(10),")
      if (currentStruct) {
        const memberMatch = trimmed.match(/^(\d+)\s+(\w+)\s*(.*?)\s*[,;]?$/);
        if (memberMatch) {
          const memberLevel = parseInt(memberMatch[1], 10);
          const memberName = memberMatch[2];
          const memberAttrs = (memberMatch[3] ?? '').split(/\s+/).filter(Boolean);
          if (memberLevel > 1) {
            currentStruct.members.push({
              name: memberName,
              type: memberAttrs.length > 0 ? memberAttrs.join(' ') : 'UNKNOWN',
              level: memberLevel,
              line: lineNum,
            });
            // If line ends with ";", close the structure
            if (trimmed.endsWith(';')) {
              program.structures.push(currentStruct);
              currentStruct = null;
            }
            continue;
          }
        }
      }

      const callMatch = trimmed.match(/\bCALL\s+(\w+)\s*(?:\(|;)/i);
      if (callMatch) {
        program.callStatements.push({ target: callMatch[1], line: lineNum });
      }

      // ── ENTRY statements ─────────────────────────────────────────

      const entryMatch = trimmed.match(/^(\w+)\s*:\s*ENTRY\b/i);
      if (entryMatch) {
        program.entryPoints.push(entryMatch[1]);
      }
    }

    // Close any open procedure/structure
    if (currentProc) {
      currentProc.endLine = lines.length;
      program.procedures.push(currentProc);
    }
    if (currentStruct) {
      program.structures.push(currentStruct);
    }

    return program;
  }

  /** Extract CodeDefinitions for the workspace indexer */
  extractDefinitions(content: string, filePath: string): CodeDefinition[] {
    const program = this.parse(content, filePath);
    const defs: CodeDefinition[] = [];

    for (const proc of program.procedures) {
      defs.push({
        name: proc.name,
        kind: proc.type === 'external' ? 'procedure' : 'subroutine',
        line: proc.line,
        endLine: proc.endLine,
        filePath,
        language: 'pli',
      });
    }

    for (const struct of program.structures) {
      defs.push({
        name: struct.name,
        kind: 'data-structure',
        line: struct.line,
        filePath,
        language: 'pli',
      });
    }

    for (const entry of program.entryPoints) {
      if (!defs.find((d) => d.name === entry)) {
        defs.push({
          name: entry,
          kind: 'procedure',
          line: 1,
          filePath,
          language: 'pli',
        });
      }
    }

    return defs;
  }

  /** Extract FileDependencies for the workspace indexer */
  extractDependencies(content: string, filePath: string): FileDependency[] {
    const program = this.parse(content, filePath);
    const deps: FileDependency[] = [];

    for (const inc of program.includes) {
      deps.push({
        sourceFile: filePath,
        targetFile: inc.resolvedPath ?? inc.name,
        type: 'include',
      });
    }

    return deps;
  }

  /** Resolve a %INCLUDE path against configured include directories */
  private resolveInclude(name: string): string | undefined {
    const extensions = ['.pli', '.PLI', '.inc', '.INC', ''];

    for (const dir of this.includePaths) {
      for (const ext of extensions) {
        const candidate = path.join(dir, name + ext);
        if (fs.existsSync(candidate)) {
          return candidate;
        }
      }
    }

    return undefined;
  }

  /** Infer a simplified type string from PL/I attributes */
  private inferType(attributes: string[]): string {
    const joined = attributes.join(' ').toUpperCase();

    if (joined.includes('FIXED') && joined.includes('BIN')) return 'FIXED BINARY';
    if (joined.includes('FIXED') && joined.includes('DEC')) return 'FIXED DECIMAL';
    if (joined.includes('FLOAT')) return 'FLOAT';
    if (joined.includes('CHAR')) return 'CHARACTER';
    if (joined.includes('BIT')) return 'BIT';
    if (joined.includes('POINTER') || joined.includes('PTR')) return 'POINTER';
    if (joined.includes('FILE')) return 'FILE';
    if (joined.includes('ENTRY')) return 'ENTRY';
    if (joined.includes('PICTURE') || joined.includes('PIC')) return 'PICTURE';

    return attributes.length > 0 ? attributes.join(' ') : 'UNKNOWN';
  }
}
