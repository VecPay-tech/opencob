import * as fs from 'node:fs';
import * as path from 'node:path';
import type { CodeDefinition, FileDependency } from '../indexer/workspace-indexer.js';

/** COBOL-specific code intelligence */
export interface CobolParagraph {
  name: string;
  line: number;
  endLine: number;
  performedBy: string[];
}

export interface CobolCopybook {
  name: string;
  line: number;
  resolvedPath?: string;
}

export interface CobolDataItem {
  level: number;
  name: string;
  line: number;
  picture?: string;
  usage?: string;
  occurs?: number;
  redefines?: string;
}

export interface CobolProgram {
  programId: string;
  filePath: string;
  divisions: { name: string; line: number }[];
  paragraphs: CobolParagraph[];
  sections: Array<{ name: string; line: number; endLine: number }>;
  copybooks: CobolCopybook[];
  dataItems: CobolDataItem[];
  execCics: Array<{ command: string; line: number }>;
  execSql: Array<{ statement: string; line: number }>;
  callStatements: Array<{ target: string; line: number }>;
  /** All PERFORM/GOTO references with source line (populated in second pass) */
  flowReferences: Array<{ target: string; refType: 'perform' | 'goto'; line: number }>;
}

/**
 * COBOL Language Parser — extracts structure from COBOL source files.
 * Handles Enterprise COBOL, COBOL-85, EXEC CICS, and EXEC SQL.
 */
export class CobolParser {
  private copybookPaths: string[];

  constructor(copybookPaths: string[] = []) {
    this.copybookPaths = copybookPaths;
  }

  /** Parse a COBOL source file */
  parse(content: string, filePath: string): CobolProgram {
    const lines = content.split('\n');
    const program: CobolProgram = {
      programId: '',
      filePath,
      divisions: [],
      paragraphs: [],
      sections: [],
      copybooks: [],
      dataItems: [],
      execCics: [],
      execSql: [],
      callStatements: [],
      flowReferences: [],
    };

    let inProcedureDivision = false;
    let currentParagraph: CobolParagraph | null = null;

    for (let i = 0; i < lines.length; i++) {
      const raw = lines[i];
      const lineNum = i + 1;

      // Skip sequence number area (columns 1-6) and indicator (column 7)
      // COBOL standard: columns 7-72 are the text area, 73-80 are sequence numbers
      const line =
        raw.length >= 72 ? raw.substring(6, 72) : raw.length > 6 ? raw.substring(6) : raw;
      const indicator = line.length > 0 ? line[0] : ' ';

      // Skip comment lines
      if (indicator === '*' || indicator === '/') continue;

      const text = line.substring(1).trim();
      if (!text) continue;
      const textUpper = text.toUpperCase();

      // PROGRAM-ID
      const pidMatch = textUpper.match(/PROGRAM-ID\.\s*(\S+)/);
      if (pidMatch) {
        program.programId = pidMatch[1].replace('.', '');
      }

      // Division headers
      const divMatch = textUpper.match(/^(IDENTIFICATION|ENVIRONMENT|DATA|PROCEDURE)\s+DIVISION/);
      if (divMatch) {
        program.divisions.push({ name: divMatch[1], line: lineNum });
        if (divMatch[1] === 'PROCEDURE') {
          inProcedureDivision = true;
        }
      }

      // COPY statements
      const copyMatch = textUpper.match(/COPY\s+(\S+)/);
      if (copyMatch) {
        const copybookName = copyMatch[1].replace('.', '');
        const resolved = this.resolveCopybook(copybookName);
        program.copybooks.push({
          name: copybookName,
          line: lineNum,
          resolvedPath: resolved,
        });
      }

      // Data items (01–49, 66, 77, 88 levels)
      const dataMatch = text.match(/^(\d{2})\s+(\S+)/);
      if (dataMatch && !inProcedureDivision) {
        const level = parseInt(dataMatch[1], 10);
        if ([1, 2, 3, 4, 5, 10, 15, 20, 25, 30, 49, 66, 77, 88].includes(level) || level <= 49) {
          const dataItem: CobolDataItem = {
            level,
            name: dataMatch[2].replace('.', ''),
            line: lineNum,
          };
          // Parse PIC clause
          const picMatch = textUpper.match(/PIC(?:TURE)?\s+IS\s+(\S+)|PIC(?:TURE)?\s+(\S+)/);
          if (picMatch) {
            dataItem.picture = (picMatch[1] ?? picMatch[2]).replace(/\.$/, '');
          }
          // Parse USAGE
          const usageMatch = textUpper.match(/USAGE\s+IS\s+(\S+)|USAGE\s+(\S+)/);
          if (usageMatch) {
            dataItem.usage = usageMatch[1] ?? usageMatch[2];
          }
          // COMP-3 / PACKED-DECIMAL
          if (textUpper.includes('COMP-3') || textUpper.includes('PACKED-DECIMAL')) {
            dataItem.usage = 'COMP-3';
          }
          // OCCURS
          const occursMatch = textUpper.match(/OCCURS\s+(\d+)/);
          if (occursMatch) {
            dataItem.occurs = parseInt(occursMatch[1], 10);
          }
          // REDEFINES
          const redefMatch = textUpper.match(/REDEFINES\s+(\S+)/);
          if (redefMatch) {
            dataItem.redefines = redefMatch[1];
          }
          program.dataItems.push(dataItem);
        }
      }

      // Sections in PROCEDURE DIVISION
      const sectionMatch = textUpper.match(/^(\S+)\s+SECTION\s*\./);
      if (sectionMatch && inProcedureDivision) {
        program.sections.push({ name: sectionMatch[1], line: lineNum, endLine: lineNum });
      }

      // Paragraphs in PROCEDURE DIVISION
      if (inProcedureDivision) {
        const paraMatch = text.match(/^([A-Za-z0-9-]+)\s*\.\s*$/);
        if (paraMatch && !textUpper.includes('SECTION')) {
          const paraName = paraMatch[1].toUpperCase();
          // Exclude COBOL scope terminators and keywords that look like paragraphs
          const COBOL_KEYWORDS = new Set([
            'END-IF',
            'END-PERFORM',
            'END-EVALUATE',
            'END-READ',
            'END-WRITE',
            'END-REWRITE',
            'END-DELETE',
            'END-START',
            'END-RETURN',
            'END-SEARCH',
            'END-CALL',
            'END-COMPUTE',
            'END-STRING',
            'END-UNSTRING',
            'END-MULTIPLY',
            'END-DIVIDE',
            'END-ADD',
            'END-SUBTRACT',
            'END-ACCEPT',
            'END-DISPLAY',
            'END-EXEC',
            'END-XML',
            'END-JSON',
            'END-INVOKE',
            'END-RECEIVE',
            'ELSE',
            'WHEN',
            'NOT',
            'CONTINUE',
            'NEXT',
            'EXIT',
            'STOP',
          ]);
          if (!COBOL_KEYWORDS.has(paraName)) {
            if (currentParagraph) {
              currentParagraph.endLine = lineNum - 1;
            }
            currentParagraph = {
              name: paraMatch[1],
              line: lineNum,
              endLine: lineNum,
              performedBy: [],
            };
            program.paragraphs.push(currentParagraph);
          }
        }
      }

      // PERFORM statements — collect reference for second-pass resolution
      const performMatch = textUpper.match(/PERFORM\s+([A-Z0-9][\w-]*)/);
      if (performMatch && inProcedureDivision) {
        const target = performMatch[1];
        // Skip keywords that look like targets (UNTIL, VARYING, etc.)
        if (!['UNTIL', 'VARYING', 'WITH', 'TEST', 'TIMES'].includes(target)) {
          program.flowReferences.push({ target, refType: 'perform', line: lineNum });
        }
      }

      // GO TO statements
      const gotoMatch = textUpper.match(/GO\s+TO\s+([A-Z0-9][\w-]*)/);
      if (gotoMatch && inProcedureDivision) {
        program.flowReferences.push({ target: gotoMatch[1], refType: 'goto', line: lineNum });
      }

      // CALL statements
      const callMatch = textUpper.match(/CALL\s+['"](\S+)['"]/);
      if (callMatch) {
        program.callStatements.push({
          target: callMatch[1],
          line: lineNum,
        });
      }

      // EXEC CICS
      if (textUpper.includes('EXEC CICS')) {
        const cicsMatch = textUpper.match(/EXEC\s+CICS\s+(\S+)/);
        program.execCics.push({
          command: cicsMatch?.[1] ?? 'UNKNOWN',
          line: lineNum,
        });
      }

      // EXEC SQL
      if (textUpper.includes('EXEC SQL')) {
        const sqlMatch = textUpper.match(/EXEC\s+SQL\s+(.*)/);
        program.execSql.push({
          statement: sqlMatch?.[1]?.trim() ?? '',
          line: lineNum,
        });
      }
    }

    // Close last paragraph
    if (currentParagraph) {
      currentParagraph.endLine = lines.length;
    }

    // ── Second pass: compute section endLines ──────────────────
    // All procedure-level items sorted by line
    const allProcItems = [
      ...program.sections.map((s) => ({ line: s.line, ref: s })),
      ...program.paragraphs.map((p) => ({ line: p.line, ref: null })),
    ].sort((a, b) => a.line - b.line);

    for (let si = 0; si < program.sections.length; si++) {
      const sec = program.sections[si];
      // Find next section or paragraph that starts after this section
      let nextStart = lines.length;
      for (const item of allProcItems) {
        if (item.line > sec.line) {
          // If it's another section, that's the boundary
          if (item.ref && item.ref !== sec) {
            nextStart = item.line - 1;
            break;
          }
        }
      }
      // Also check next section directly
      if (si + 1 < program.sections.length) {
        nextStart = Math.min(nextStart, program.sections[si + 1].line - 1);
      }
      sec.endLine = nextStart;
    }

    // ── Second pass: resolve performedBy using all parsed paragraphs ──
    const paraMap = new Map<string, CobolParagraph>();
    for (const para of program.paragraphs) {
      paraMap.set(para.name.toUpperCase(), para);
    }

    for (const ref of program.flowReferences) {
      if (ref.refType === 'perform') {
        const target = paraMap.get(ref.target);
        if (target) {
          // Find source paragraph by line containment
          let sourceName = 'unknown';
          for (const para of program.paragraphs) {
            if (ref.line >= para.line && ref.line <= para.endLine) {
              sourceName = para.name;
              break;
            }
          }
          if (!target.performedBy.includes(sourceName)) {
            target.performedBy.push(sourceName);
          }
        }
      }
    }

    return program;
  }

  /** Extract code definitions for the indexer */
  extractDefinitions(program: CobolProgram): CodeDefinition[] {
    const defs: CodeDefinition[] = [];

    for (const para of program.paragraphs) {
      defs.push({
        name: para.name,
        kind: 'paragraph',
        filePath: program.filePath,
        line: para.line,
        endLine: para.endLine,
        language: 'cobol',
      });
    }

    for (const section of program.sections) {
      defs.push({
        name: section.name,
        kind: 'section',
        filePath: program.filePath,
        line: section.line,
        language: 'cobol',
      });
    }

    return defs;
  }

  /** Extract dependencies (COPY/CALL) for the indexer */
  extractDependencies(program: CobolProgram): FileDependency[] {
    const deps: FileDependency[] = [];

    for (const copybook of program.copybooks) {
      deps.push({
        sourceFile: program.filePath,
        targetFile: copybook.resolvedPath ?? copybook.name,
        type: 'copy',
      });
    }

    for (const call of program.callStatements) {
      deps.push({
        sourceFile: program.filePath,
        targetFile: call.target,
        type: 'include',
      });
    }

    return deps;
  }

  /** Generate a human-readable explanation of a paragraph */
  explainParagraph(program: CobolProgram, paragraphName: string, sourceContent: string): string {
    const para = program.paragraphs.find(
      (p) => p.name.toUpperCase() === paragraphName.toUpperCase(),
    );
    if (!para) {
      return `Paragraph "${paragraphName}" not found in ${program.programId}.`;
    }

    const lines = sourceContent.split('\n');
    const paraLines = lines.slice(para.line - 1, para.endLine);
    const code = paraLines.join('\n');

    // Build explanation context
    const callers =
      para.performedBy.length > 0
        ? `Called by: ${para.performedBy.join(', ')}`
        : 'Not called by any other paragraph (entry point or dead code)';

    return [
      `## Paragraph: ${para.name}`,
      `**Program**: ${program.programId}`,
      `**Lines**: ${para.line}–${para.endLine}`,
      `**${callers}**`,
      '',
      '### Source Code',
      '```cobol',
      code,
      '```',
    ].join('\n');
  }

  /** Resolve a copybook name to a file path */
  private resolveCopybook(name: string): string | undefined {
    const variants = [`${name}.cpy`, `${name}.CPY`, `${name}.cob`, `${name}.COB`, name];

    for (const searchPath of this.copybookPaths) {
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
