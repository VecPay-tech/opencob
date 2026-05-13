import * as fs from 'node:fs';
import * as path from 'node:path';
import type { CodeDefinition, FileDependency } from '../indexer/workspace-indexer.js';

/** RPG-specific code intelligence */
export interface RpgProcedure {
  name: string;
  line: number;
  endLine: number;
  type: 'procedure' | 'subroutine';
  parameters?: string[];
}

export interface RpgDataStructure {
  name: string;
  line: number;
  fields: Array<{ name: string; type: string; line: number }>;
}

export interface RpgIndicator {
  name: string;
  line: number;
  usage: 'set' | 'test';
}

export interface RpgProgram {
  filePath: string;
  format: 'free' | 'fixed' | 'mixed';
  procedures: RpgProcedure[];
  subroutines: RpgProcedure[];
  dataStructures: RpgDataStructure[];
  copyDirectives: Array<{ name: string; line: number; resolvedPath?: string }>;
  indicators: RpgIndicator[];
  fileDeclarations: Array<{ name: string; type: string; line: number }>;
  sqlStatements: Array<{ statement: string; line: number }>;
}

/**
 * RPG Language Parser — extracts structure from RPG ILE source files.
 * Supports both fixed-format (RPG III/IV) and free-format (ILE RPG).
 */
export class RpgParser {
  private copyPaths: string[];

  constructor(copyPaths: string[] = []) {
    this.copyPaths = copyPaths;
  }

  /** Parse an RPG source file */
  parse(content: string, filePath: string): RpgProgram {
    const lines = content.split('\n');
    const program: RpgProgram = {
      filePath,
      format: this.detectFormat(lines),
      procedures: [],
      subroutines: [],
      dataStructures: [],
      copyDirectives: [],
      indicators: [],
      fileDeclarations: [],
      sqlStatements: [],
    };

    if (program.format === 'free') {
      this.parseFreeFormat(lines, program);
    } else {
      this.parseFixedFormat(lines, program);
    }

    return program;
  }

  /** Extract code definitions for the indexer */
  extractDefinitions(program: RpgProgram): CodeDefinition[] {
    const defs: CodeDefinition[] = [];

    for (const proc of program.procedures) {
      defs.push({
        name: proc.name,
        kind: 'procedure',
        filePath: program.filePath,
        line: proc.line,
        endLine: proc.endLine,
        language: 'rpg',
      });
    }

    for (const sub of program.subroutines) {
      defs.push({
        name: sub.name,
        kind: 'subroutine',
        filePath: program.filePath,
        line: sub.line,
        endLine: sub.endLine,
        language: 'rpg',
      });
    }

    for (const ds of program.dataStructures) {
      defs.push({
        name: ds.name,
        kind: 'data-structure',
        filePath: program.filePath,
        line: ds.line,
        language: 'rpg',
      });
    }

    return defs;
  }

  /** Extract dependencies (/COPY, /INCLUDE) for the indexer */
  extractDependencies(program: RpgProgram): FileDependency[] {
    return program.copyDirectives.map((copy) => ({
      sourceFile: program.filePath,
      targetFile: copy.resolvedPath ?? copy.name,
      type: 'copy' as const,
    }));
  }

  // ── Private ─────────────────────────────────────────────────

  private detectFormat(lines: string[]): 'free' | 'fixed' | 'mixed' {
    let hasFixed = false;
    let hasFree = false;

    for (const line of lines.slice(0, 50)) {
      const trimmed = line.trim().toUpperCase();
      if (trimmed.startsWith('**FREE')) return 'free';
      // Fixed-format lines have spec type in column 6 (0-indexed col 5)
      if (line.length > 5) {
        const spec = line[5]?.toUpperCase();
        if (spec && 'HFDCIOPB'.includes(spec)) {
          hasFixed = true;
        }
      }
      if (trimmed.startsWith('DCL-') || trimmed.startsWith('CTL-OPT')) {
        hasFree = true;
      }
    }

    if (hasFree && hasFixed) return 'mixed';
    if (hasFree) return 'free';
    return 'fixed';
  }

  private parseFreeFormat(lines: string[], program: RpgProgram): void {
    let currentProc: RpgProcedure | null = null;
    let currentDs: RpgDataStructure | null = null;
    let currentSub: RpgProcedure | null = null;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const lineNum = i + 1;
      const trimmed = line.trim();
      const upper = trimmed.toUpperCase();

      // /COPY or /INCLUDE
      if (upper.startsWith('/COPY ') || upper.startsWith('/INCLUDE ')) {
        const target = trimmed.split(/\s+/)[1];
        if (target) {
          program.copyDirectives.push({
            name: target,
            line: lineNum,
            resolvedPath: this.resolveCopy(target),
          });
        }
        continue;
      }

      // DCL-PROC (procedure start)
      const procMatch = upper.match(/^DCL-PROC\s+(\S+)/);
      if (procMatch) {
        const origProcMatch = trimmed.match(/^DCL-PROC\s+(\S+)/i);
        currentProc = {
          name: this.cleanName(origProcMatch?.[1] ?? procMatch[1]),
          line: lineNum,
          endLine: lineNum,
          type: 'procedure',
        };
        continue;
      }

      // END-PROC
      if (upper.startsWith('END-PROC')) {
        if (currentProc) {
          currentProc.endLine = lineNum;
          program.procedures.push(currentProc);
          currentProc = null;
        }
        continue;
      }

      // DCL-DS (data structure start)
      const dsMatch = upper.match(/^DCL-DS\s+(\S+)/);
      if (dsMatch) {
        const origDsMatch = trimmed.match(/^DCL-DS\s+(\S+)/i);
        currentDs = {
          name: this.cleanName(origDsMatch?.[1] ?? dsMatch[1]),
          line: lineNum,
          fields: [],
        };
        continue;
      }

      // END-DS
      if (upper.startsWith('END-DS')) {
        if (currentDs) {
          program.dataStructures.push(currentDs);
          currentDs = null;
        }
        continue;
      }

      // DCL-S or DCL-C (standalone fields)
      if (currentDs) {
        const fieldMatch = trimmed.match(/^(\S+)\s+(.*)/);
        if (fieldMatch && !upper.startsWith('DCL-') && !upper.startsWith('END-')) {
          currentDs.fields.push({
            name: fieldMatch[1],
            type: fieldMatch[2].replace(/;$/, '').trim(),
            line: lineNum,
          });
        }
      }

      // BEGSR (subroutine start)
      const srMatch = upper.match(/^BEGSR\s+(\S+)/);
      if (srMatch) {
        const origSrMatch = trimmed.match(/^BEGSR\s+(\S+)/i);
        currentSub = {
          name: this.cleanName(origSrMatch?.[1] ?? srMatch[1]),
          line: lineNum,
          endLine: lineNum,
          type: 'subroutine',
        };
        continue;
      }

      // ENDSR
      if (upper.startsWith('ENDSR')) {
        if (currentSub) {
          currentSub.endLine = lineNum;
          program.subroutines.push(currentSub);
          currentSub = null;
        }
        continue;
      }

      // DCL-F (file declarations)
      const fileMatch = upper.match(/^DCL-F\s+(\S+)/);
      if (fileMatch) {
        program.fileDeclarations.push({
          name: fileMatch[1],
          type: 'file',
          line: lineNum,
        });
        continue;
      }

      // EXEC SQL
      if (upper.includes('EXEC SQL')) {
        program.sqlStatements.push({
          statement: trimmed,
          line: lineNum,
        });
      }

      // Indicators (*INxx)
      const indMatch = trimmed.match(/\*IN(\d{2})/g);
      if (indMatch) {
        for (const ind of indMatch) {
          const usage =
            upper.includes('IF') || upper.includes('WHEN') || upper.includes('DOW')
              ? 'test'
              : 'set';
          program.indicators.push({ name: ind, line: lineNum, usage });
        }
      }
    }
  }

  private parseFixedFormat(lines: string[], program: RpgProgram): void {
    let currentSub: RpgProcedure | null = null;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const lineNum = i + 1;

      // Skip comment lines (column 7 = *)
      if (line.length > 6 && line[6] === '*') continue;

      // Fixed format: column 6 (0-indexed 5) is the spec type
      const specType = line.length > 5 ? line[5]?.toUpperCase() : '';

      // H-spec (control)
      // F-spec (file declaration)
      if (specType === 'F' && line.length > 10) {
        const fileName = line.substring(6, 16).trim();
        if (fileName) {
          program.fileDeclarations.push({
            name: fileName,
            type: 'file',
            line: lineNum,
          });
        }
      }

      // D-spec (data definition)
      if (specType === 'D' && line.length > 25) {
        const name = line.substring(6, 21).trim();
        const dsType = line.substring(23, 25).trim().toUpperCase();
        if (name && dsType === 'DS') {
          program.dataStructures.push({
            name,
            line: lineNum,
            fields: [],
          });
        }
      }

      // C-spec (calculation) — subroutines
      if (specType === 'C') {
        const text = line.substring(6).toUpperCase();
        const origText = line.substring(6);
        const begSr = text.match(/BEGSR\s+(\S+)/);
        if (begSr) {
          // Extract name preserving original case
          const origBegSr = origText.match(/BEGSR\s+(\S+)/i);
          currentSub = {
            name: origBegSr?.[1] ?? begSr[1],
            line: lineNum,
            endLine: lineNum,
            type: 'subroutine',
          };
        }
        if (text.includes('ENDSR')) {
          if (currentSub) {
            currentSub.endLine = lineNum;
            program.subroutines.push(currentSub);
            currentSub = null;
          }
        }
      }

      // P-spec (procedure) — name in columns 7-21, type indicator after
      if (specType === 'P') {
        const pContent = line.substring(6);
        const name = pContent.substring(0, 15).trim();
        const rest = pContent.substring(15).trim().toUpperCase();
        // Type can be B (begin) or E (end), possibly preceded by spaces
        const hasBegin = rest.startsWith('B') || rest.includes(' B');
        const hasEnd = rest.startsWith('E') || rest.includes(' E');
        if (name && hasBegin) {
          program.procedures.push({
            name,
            line: lineNum,
            endLine: lineNum,
            type: 'procedure',
          });
        } else if (hasEnd && program.procedures.length > 0) {
          program.procedures[program.procedures.length - 1].endLine = lineNum;
        }
      }

      // /COPY and /INCLUDE directives
      const trimmed = line.trim().toUpperCase();
      if (trimmed.startsWith('/COPY') || trimmed.startsWith('/INCLUDE')) {
        const target = line.trim().split(/\s+/)[1];
        if (target) {
          program.copyDirectives.push({
            name: target,
            line: lineNum,
            resolvedPath: this.resolveCopy(target),
          });
        }
      }
    }
  }

  private cleanName(name: string): string {
    return name.replace(/[;:.]$/g, '');
  }

  private resolveCopy(name: string): string | undefined {
    const variants = [name, `${name}.rpgle`, `${name}.rpg`, `${name}.RPGLE`];

    for (const searchPath of this.copyPaths) {
      for (const variant of variants) {
        const fullPath = path.resolve(searchPath, variant);
        if (fs.existsSync(fullPath)) {
          return fullPath;
        }
      }
    }
    return undefined;
  }
}
