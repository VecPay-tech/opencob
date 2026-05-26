/**
 * Generate Diagram Tool — Extension-aware diagram generation engine.
 *
 * Ported from DriverX diagram_engine.py. Supports both:
 * 1. Legacy languages (COBOL, CL, RPG, PL/I, BMS, DDS) with rich diagram types
 * 2. Modern languages (TS/JS/Python/Java/Go) with generic diagrams
 *
 * Legacy diagram types (per file category):
 *   program:  call_graph, dependency_map, structure_chart, procedure_flow,
 *             control_flow, field_hierarchy, file_io, copybook_tree
 *   copybook: record_layout, field_hierarchy, dependency_map, copybook_tree
 *   screen:   screen_layout, dependency_map, copybook_tree
 *   dds:      record_layout, field_hierarchy
 *
 * Modern diagram types:
 *   call-graph, dependency, structure, class
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Tool, ToolResult } from './types.js';
import {
  type DiagramNode,
  type DiagramEdge,
  type DiagramData,
  type DiagramType,
  type LegacyDiagramType,
  type FileTypeInfo,
  FILE_TYPES,
  DIAGRAM_TYPES,
  ALL_LEGACY_EXTS,
  COBOL_EXTS,
  CL_EXTS,
  RPG_EXTS,
  PLI_EXTS,
  BMS_EXTS,
  DDS_EXTS,
  classifyExtension,
  getAvailableDiagramTypes,
} from './diagram-types.js';
import { parseControlFlow, parseClControlFlow } from './flow-parser.js';
import { CobolParser, type CobolProgram } from '../legacy/cobol-parser.js';
import { RpgParser, type RpgProgram } from '../legacy/rpg-parser.js';
import { PliParser, type PliProgram } from '../legacy/pli-parser.js';
import { parseBmsMap, type BmsParseResult } from '../legacy/bms-parser.js';
import { parseDds, type DdsParseResult } from '../legacy/dds-parser.js';

/**
 * Generate Mermaid diagrams from source code.
 *
 * Supports legacy languages with extension-aware routing and modern languages
 * with generic regex-based parsing.
 */
export function createGenerateDiagramTool(workspaceRoot: string): Tool {
  return {
    name: 'generate_diagram',
    group: 'analysis',
    description: [
      'Generate a Mermaid diagram from source files.',
      'Legacy (COBOL/CL/RPG/PL-I): call_graph, dependency_map, structure_chart, procedure_flow, control_flow, field_hierarchy, file_io, copybook_tree, record_layout, screen_layout.',
      'Modern (TS/JS/Python/Java): call-graph, dependency, structure, class.',
      'Use type "available" to list diagram types for a file.',
    ].join(' '),
    parameters: [
      {
        name: 'path',
        type: 'string',
        description: 'File or directory path relative to workspace root',
        required: true,
      },
      {
        name: 'type',
        type: 'string',
        description:
          'Diagram type (or "available" to list). Legacy: call_graph, dependency_map, structure_chart, procedure_flow, control_flow, field_hierarchy, file_io, copybook_tree, record_layout, screen_layout. Modern: call-graph, dependency, structure, class.',
        required: true,
      },
      {
        name: 'section_id',
        type: 'number',
        description:
          'For control_flow: index of the section/paragraph to diagram (0-based). Defaults to 0.',
        required: false,
      },
    ],
    async execute(params: Record<string, unknown>): Promise<ToolResult> {
      const filePath = params.path as string;
      const diagramType = params.type as string;
      const sectionId = params.section_id as number | undefined;

      if (!filePath) return { success: false, content: 'Error: path is required' };
      if (!diagramType) return { success: false, content: 'Error: type is required' };

      const fullPath = path.resolve(workspaceRoot, filePath);
      if (!fullPath.startsWith(path.resolve(workspaceRoot))) {
        return { success: false, content: 'Error: path traversal not allowed' };
      }

      if (!fs.existsSync(fullPath)) {
        return { success: false, content: `Error: path not found: ${filePath}` };
      }

      // ── "available" meta-command ──────────────────────────
      if (diagramType === 'available') {
        return handleAvailable(fullPath, workspaceRoot);
      }

      const stat = fs.statSync(fullPath);

      // ── Single file → check if legacy ─────────────────────
      if (!stat.isDirectory()) {
        const ext = path.extname(fullPath).slice(1).toLowerCase();
        if (ALL_LEGACY_EXTS.has(ext)) {
          return generateLegacyDiagram(
            fullPath,
            diagramType as LegacyDiagramType,
            workspaceRoot,
            sectionId,
          );
        }
      }

      // ── Directory or modern file → collect and generate ───
      const files: string[] = [];
      if (stat.isDirectory()) {
        collectFiles(fullPath, files, 3);
      } else {
        files.push(fullPath);
      }

      // Check if directory contains predominantly legacy files
      const legacyFiles = files.filter((f) => {
        const e = path.extname(f).slice(1).toLowerCase();
        return ALL_LEGACY_EXTS.has(e);
      });

      if (legacyFiles.length > 0 && legacyFiles.length >= files.length * 0.5) {
        // Legacy-dominant directory: generate per first file or aggregate
        return generateLegacyDiagram(
          legacyFiles[0],
          diagramType as LegacyDiagramType,
          workspaceRoot,
          sectionId,
        );
      }

      // Modern diagrams
      const mermaid = generateModernMermaid(files, diagramType, workspaceRoot);
      return {
        success: true,
        content: mermaid,
        metadata: { type: diagramType, fileCount: files.length, mode: 'modern' },
      };
    },
  };
}

// ══════════════════════════════════════════════════════════════
//  "available" command — list what diagrams are possible
// ══════════════════════════════════════════════════════════════

function handleAvailable(fullPath: string, root: string): ToolResult {
  const stat = fs.statSync(fullPath);
  if (stat.isDirectory()) {
    const files: string[] = [];
    collectFiles(fullPath, files, 2);
    const extSet = new Set(files.map((f) => path.extname(f).slice(1).toLowerCase()));
    const available: Record<string, string[]> = {};
    for (const ext of extSet) {
      const types = getAvailableDiagramTypes(ext);
      if (types.length > 0) available[ext] = types;
    }
    if (Object.keys(available).length === 0) {
      available['modern'] = ['call-graph', 'dependency', 'structure', 'class'];
    }
    return {
      success: true,
      content: JSON.stringify(available, null, 2),
      metadata: { fileCount: files.length },
    };
  }

  const ext = path.extname(fullPath).slice(1).toLowerCase();
  const info = classifyExtension(ext);
  if (info) {
    const types = DIAGRAM_TYPES[info.category] ?? [];
    // Filter by actual content availability
    const actuallyAvailable = getActuallyAvailableDiagrams(fullPath, info, types);
    return {
      success: true,
      content: JSON.stringify(
        {
          file: path.relative(root, fullPath),
          extension: ext,
          category: info.category,
          platform: info.platform,
          language: info.language,
          available_types: actuallyAvailable,
        },
        null,
        2,
      ),
    };
  }

  return {
    success: true,
    content: JSON.stringify(
      {
        file: path.relative(root, fullPath),
        extension: ext,
        category: 'modern',
        available_types: ['call-graph', 'dependency', 'structure', 'class'],
      },
      null,
      2,
    ),
  };
}

function getActuallyAvailableDiagrams(
  fullPath: string,
  info: FileTypeInfo,
  candidateTypes: string[],
): string[] {
  const content = safeReadFile(fullPath);
  if (!content) return candidateTypes; // If can't read, return all candidates

  const available: string[] = [];
  const upper = content.toUpperCase();

  for (const dtype of candidateTypes) {
    switch (dtype) {
      case 'call_graph':
        if (/CALL\s+['"]?\w/i.test(content) || /EXEC\s+CICS\s+(LINK|XCTL)/i.test(content)) {
          available.push(dtype);
        }
        break;
      case 'dependency_map':
      case 'copybook_tree':
        if (
          /COPY\s+\w/i.test(content) ||
          /\/COPY\s/i.test(content) ||
          /%INCLUDE\s/i.test(content)
        ) {
          available.push(dtype);
        }
        break;
      case 'structure_chart':
      case 'procedure_flow': {
        const paraCount = (content.match(/^\s{6}\s[A-Z0-9][\w-]+\s*\.\s*$/gm) ?? []).length;
        const sectionCount = (upper.match(/\bSECTION\s*\./g) ?? []).length;
        if (paraCount >= 2 || sectionCount >= 1) available.push(dtype);
        break;
      }
      case 'control_flow':
        if (upper.includes('PROCEDURE DIVISION') || /^\s*PGM\b/im.test(content)) {
          available.push(dtype);
        }
        break;
      case 'field_hierarchy':
        if (/^\s*\d{2}\s+\w/m.test(content)) available.push(dtype);
        break;
      case 'file_io':
        if (upper.includes('SELECT') && upper.includes('ASSIGN')) available.push(dtype);
        break;
      case 'screen_layout':
        available.push(dtype); // Always available for screen/dspf files
        break;
      case 'record_layout':
        available.push(dtype); // Always available for dds/copybook files
        break;
      default:
        available.push(dtype);
    }
  }
  return available;
}

// ══════════════════════════════════════════════════════════════
//  Legacy Diagram Generation
// ══════════════════════════════════════════════════════════════

function generateLegacyDiagram(
  fullPath: string,
  diagramType: LegacyDiagramType,
  root: string,
  sectionId?: number,
): ToolResult {
  const ext = path.extname(fullPath).slice(1).toLowerCase();
  const info = classifyExtension(ext);
  if (!info) {
    return { success: false, content: `Error: unrecognized extension .${ext}` };
  }

  const content = safeReadFile(fullPath);
  if (!content) {
    return { success: false, content: `Error: cannot read file` };
  }

  // Check if requested diagram type is valid for this category
  const validTypes = DIAGRAM_TYPES[info.category] ?? [];
  if (!validTypes.includes(diagramType)) {
    return {
      success: false,
      content: `Error: diagram type "${diagramType}" not available for ${info.category} files (.${ext}). Available: ${validTypes.join(', ')}`,
    };
  }

  let data: DiagramData | null = null;

  if (COBOL_EXTS.has(ext)) {
    data = generateCobolDiagram(fullPath, content, diagramType, info, sectionId);
  } else if (CL_EXTS.has(ext)) {
    data = generateClDiagram(fullPath, content, diagramType, info, sectionId);
  } else if (RPG_EXTS.has(ext)) {
    data = generateRpgDiagram(fullPath, content, diagramType, info);
  } else if (PLI_EXTS.has(ext)) {
    data = generatePliDiagram(fullPath, content, diagramType, info);
  } else if (BMS_EXTS.has(ext)) {
    data = generateBmsDiagram(fullPath, content, diagramType);
  } else if (DDS_EXTS.has(ext)) {
    data = generateDdsDiagram(fullPath, content, diagramType);
  }

  if (!data || (data.nodes.length === 0 && !data.data)) {
    return {
      success: false,
      content: `No data found for diagram type "${diagramType}" in this file. The file may not contain the required constructs.`,
    };
  }

  // For screen_layout, render ASCII art instead of Mermaid
  if (diagramType === 'screen_layout' && data.screen) {
    const ascii = screenLayoutToAscii(data);
    const relPath = path.relative(root, fullPath);
    return {
      success: true,
      content: ascii,
      metadata: {
        type: diagramType,
        format: 'ascii',
        file: relPath,
        category: info.category,
        platform: info.platform,
        language: info.language,
        screen: data.screen,
        fieldCount: data.nodes.length,
      },
    };
  }

  // Convert to Mermaid
  const mermaid = diagramDataToMermaid(diagramType, data);
  const relPath = path.relative(root, fullPath);

  return {
    success: true,
    content: mermaid,
    metadata: {
      type: diagramType,
      format: 'mermaid',
      file: relPath,
      category: info.category,
      platform: info.platform,
      language: info.language,
      nodeCount: data.nodes?.length ?? data.data?.nodes?.length ?? 0,
      edgeCount: data.edges?.length ?? data.data?.edges?.length ?? 0,
      ...(data.sections ? { sections: data.sections } : {}),
      ...(data.section_name ? { section_name: data.section_name } : {}),
    },
  };
}

// ── COBOL Diagram Generators ────────────────────────────────

function generateCobolDiagram(
  filePath: string,
  content: string,
  diagramType: LegacyDiagramType,
  info: FileTypeInfo,
  sectionId?: number,
): DiagramData | null {
  const parser = new CobolParser();
  const program = parser.parse(content, filePath);

  switch (diagramType) {
    case 'call_graph':
      return generateCobolCallGraph(program);
    case 'dependency_map':
    case 'copybook_tree':
      return generateCobolDependencyMap(program);
    case 'structure_chart':
      return generateCobolStructureChart(program);
    case 'procedure_flow':
      return generateCobolProcedureFlow(program);
    case 'control_flow':
      return generateCobolControlFlow(program, content, info, sectionId);
    case 'field_hierarchy':
    case 'record_layout':
      return generateCobolFieldHierarchy(program);
    case 'file_io':
      return generateCobolFileIo(program, content);
    default:
      return null;
  }
}

function generateCobolCallGraph(program: CobolProgram): DiagramData | null {
  const calls = program.callStatements;
  const cicsLinks = program.execCics.filter((c) => c.command === 'LINK' || c.command === 'XCTL');
  if (calls.length === 0 && cicsLinks.length === 0) return null;

  const nodes: DiagramNode[] = [];
  const edges: DiagramEdge[] = [];
  const sourceId = `src_${sanitizeId(program.programId || 'PROGRAM')}`;
  nodes.push({ id: sourceId, label: program.programId || 'PROGRAM', type: 'source', startLine: 0 });

  const seen = new Set<string>();
  for (const call of calls) {
    const nid = `c_${sanitizeId(call.target)}`;
    if (!seen.has(nid)) {
      seen.add(nid);
      nodes.push({ id: nid, label: call.target, type: 'call', startLine: call.line });
    }
    edges.push({ source: sourceId, target: nid, label: 'CALL', line: call.line });
  }
  for (const cics of cicsLinks) {
    const target = cics.command; // simplified — actual target extraction would need more parsing
    const nid = `cics_${sanitizeId(target)}_${cics.line}`;
    nodes.push({ id: nid, label: `CICS ${target}`, type: 'call', startLine: cics.line });
    edges.push({ source: sourceId, target: nid, label: 'EXEC CICS', line: cics.line });
  }

  return { nodes, edges };
}

function generateCobolDependencyMap(program: CobolProgram): DiagramData | null {
  if (program.copybooks.length === 0) return null;

  const nodes: DiagramNode[] = [];
  const edges: DiagramEdge[] = [];
  const sourceId = `src_${sanitizeId(program.programId || 'PROGRAM')}`;
  nodes.push({ id: sourceId, label: program.programId || 'PROGRAM', type: 'source', startLine: 0 });

  const seen = new Set<string>();
  for (const copy of program.copybooks) {
    const nid = `cp_${sanitizeId(copy.name)}`;
    if (!seen.has(nid)) {
      seen.add(nid);
      nodes.push({ id: nid, label: copy.name, type: 'copybook', startLine: copy.line });
    }
    edges.push({ source: sourceId, target: nid, label: 'COPY', line: copy.line });
  }

  return { nodes, edges };
}

function generateCobolStructureChart(program: CobolProgram): DiagramData | null {
  const items = [...program.sections, ...program.paragraphs];
  if (items.length < 2) return null;

  const nodes: DiagramNode[] = [];
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    const isSection = 'line' in item && !('performedBy' in item);
    nodes.push({
      id: `p${i}`,
      label: item.name,
      type: isSection ? 'section' : 'paragraph',
      startLine: item.line,
      endLine: 'endLine' in item ? (item as { endLine: number }).endLine : item.line,
      level: isSection ? 1 : 2,
    });
  }

  return { nodes, edges: [] };
}

function generateCobolProcedureFlow(program: CobolProgram): DiagramData | null {
  const allItems = [
    ...program.sections.map((s) => ({ ...s, itemType: 'section' as const })),
    ...program.paragraphs.map((p) => ({ ...p, itemType: 'paragraph' as const })),
  ].sort((a, b) => a.line - b.line);

  if (allItems.length < 2) return null;

  const nodes: DiagramNode[] = [];
  const edges: DiagramEdge[] = [];
  const nameToNid: Record<string, string> = {};

  for (let i = 0; i < allItems.length; i++) {
    const item = allItems[i];
    const nid = `p${i}`;
    const endLine = 'endLine' in item ? item.endLine : item.line;
    nodes.push({
      id: nid,
      label: item.name,
      type: item.itemType,
      startLine: item.line,
      endLine,
      level: item.itemType === 'section' ? 1 : 2,
      lineCount: Math.max(1, endLine - item.line + 1),
    });
    nameToNid[item.name.toUpperCase()] = nid;
  }

  // Add PERFORM edges
  const seenEdges = new Set<string>();
  for (const para of program.paragraphs) {
    if (para.performedBy.length > 0) {
      const targetNid = nameToNid[para.name.toUpperCase()];
      if (!targetNid) continue;
      for (const caller of para.performedBy) {
        const sourceNid = nameToNid[caller.toUpperCase()];
        if (!sourceNid || sourceNid === targetNid) continue;
        const key = `${sourceNid}->${targetNid}:perform`;
        if (!seenEdges.has(key)) {
          seenEdges.add(key);
          edges.push({
            source: sourceNid,
            target: targetNid,
            label: 'PERFORM',
            edgeType: 'perform',
          });
        }
      }
    }
  }

  // Add fallthrough edges
  for (let i = 0; i < allItems.length - 1; i++) {
    const srcNid = `p${i}`;
    const tgtNid = `p${i + 1}`;
    const key = `${srcNid}->${tgtNid}:fallthrough`;
    if (!seenEdges.has(key)) {
      seenEdges.add(key);
      edges.push({ source: srcNid, target: tgtNid, label: '', edgeType: 'fallthrough' });
    }
  }

  return { nodes, edges };
}

function generateCobolControlFlow(
  program: CobolProgram,
  content: string,
  info: FileTypeInfo,
  sectionId?: number,
): DiagramData | null {
  const procItems = [
    ...program.sections.map((s) => ({ ...s, itemType: 'section' as const, endLine: s.line })),
    ...program.paragraphs.map((p) => ({ ...p, itemType: 'paragraph' as const })),
  ].sort((a, b) => a.line - b.line);

  if (procItems.length === 0) return null;

  const allLines = content.split('\n');
  const targetIdx =
    sectionId !== undefined && sectionId >= 0 && sectionId < procItems.length ? sectionId : 0;
  const sec = procItems[targetIdx];

  const startLine = Math.max(0, sec.line - 1);
  const endLine = Math.min(allLines.length, sec.endLine);
  const rawLines = allLines.slice(startLine, endLine);

  // Strip COBOL sequence numbers and comments
  const stripped: string[] = [];
  for (const line of rawLines) {
    const text = line.length > 6 ? line.substring(6) : line;
    const indicator = text.length > 0 ? text[0] : ' ';
    if (indicator === '*' || indicator === '/' || !text.substring(1).trim()) {
      stripped.push('');
    } else {
      stripped.push(text.substring(1).trim());
    }
  }

  const flowData = parseControlFlow(stripped, sec.line, sec.name);

  const sections: Array<{
    id: number;
    name: string;
    type: string;
    startLine: number;
    endLine: number;
  }> = procItems.map((s, i) => ({
    id: i,
    name: s.name,
    type: s.itemType,
    startLine: s.line,
    endLine: s.endLine,
  }));

  return {
    nodes: flowData.nodes,
    edges: flowData.edges,
    diagram_type: 'control_flow',
    section_id: targetIdx,
    section_name: sec.name,
    sections,
    data: flowData,
  };
}

function generateCobolFieldHierarchy(program: CobolProgram): DiagramData | null {
  if (program.dataItems.length === 0) return null;

  const nodes: DiagramNode[] = [];
  const edges: DiagramEdge[] = [];
  const stack: Array<{ level: number; id: string }> = [];

  for (let i = 0; i < program.dataItems.length; i++) {
    const item = program.dataItems[i];
    const nid = `d${i}`;
    const lvl = item.level;
    const nodeType = lvl === 1 || lvl === 77 ? 'record' : item.picture ? 'field' : 'group';

    nodes.push({
      id: nid,
      label: item.name,
      type: nodeType,
      level: lvl,
      pic: item.picture,
      usage: item.usage,
      redefines: item.redefines,
      occurs: item.occurs,
      startLine: item.line,
    });

    // Build hierarchy edges based on level numbers
    while (stack.length > 0 && stack[stack.length - 1].level >= lvl) {
      stack.pop();
    }
    if (stack.length > 0) {
      edges.push({ source: stack[stack.length - 1].id, target: nid });
    }
    stack.push({ level: lvl, id: nid });
  }

  return { nodes, edges };
}

function generateCobolFileIo(program: CobolProgram, content: string): DiagramData | null {
  // Extract SELECT statements from ENVIRONMENT DIVISION
  const selectRegex = /SELECT\s+(\S+)\s+ASSIGN\s+(?:TO\s+)?(\S+)/gi;
  const matches: Array<{ fileName: string; assignTo: string; line: number }> = [];
  const lines = content.split('\n');

  for (let i = 0; i < lines.length; i++) {
    const lineText = lines[i].length > 6 ? lines[i].substring(7).trim() : lines[i].trim();
    selectRegex.lastIndex = 0;
    const m = selectRegex.exec(lineText);
    if (m) {
      matches.push({
        fileName: m[1].replace(/\.$/, ''),
        assignTo: m[2].replace(/\.$/, ''),
        line: i + 1,
      });
    }
  }

  // Also check for multi-line SELECT statements (strip sequence numbers in cols 73-80)
  const strippedLines = lines.map((l) => (l.length >= 72 ? l.substring(0, 72) : l));
  const fullText = strippedLines.join(' ').toUpperCase();
  const selectMatches = fullText.matchAll(/SELECT\s+(\S+)\s+ASSIGN\s+(?:TO\s+)?(\S+)/g);
  for (const sm of selectMatches) {
    const fn = sm[1].replace(/\.$/, '');
    if (!matches.some((m) => m.fileName.toUpperCase() === fn)) {
      matches.push({ fileName: fn, assignTo: sm[2].replace(/\.$/, ''), line: 0 });
    }
  }

  if (matches.length === 0) return null;

  const nodes: DiagramNode[] = [];
  const edges: DiagramEdge[] = [];
  const sourceId = `src_${sanitizeId(program.programId || 'PROGRAM')}`;
  nodes.push({
    id: sourceId,
    label: program.programId || 'PROGRAM',
    type: 'program',
    startLine: 0,
  });

  for (const m of matches) {
    const nid = `io_${sanitizeId(m.fileName)}`;
    nodes.push({
      id: nid,
      label: `${m.fileName}\n(${m.assignTo})`,
      type: 'file',
      startLine: m.line,
    });
    edges.push({ source: sourceId, target: nid, label: 'SELECT', line: m.line });
  }

  return { nodes, edges };
}

// ── CL Diagram Generators ───────────────────────────────────

function generateClDiagram(
  filePath: string,
  content: string,
  diagramType: LegacyDiagramType,
  info: FileTypeInfo,
  sectionId?: number,
): DiagramData | null {
  switch (diagramType) {
    case 'call_graph':
      return generateClCallGraph(content, filePath);
    case 'dependency_map':
    case 'copybook_tree':
      return generateClDependencyMap(content, filePath);
    case 'structure_chart':
      return generateClStructureChart(content);
    case 'procedure_flow':
      return generateClProcedureFlow(content);
    case 'control_flow':
      return generateClControlFlow(content, filePath, sectionId);
    default:
      return null;
  }
}

function generateClCallGraph(content: string, filePath: string): DiagramData | null {
  const nodes: DiagramNode[] = [];
  const edges: DiagramEdge[] = [];
  const programName = path.basename(filePath, path.extname(filePath)).toUpperCase();
  const sourceId = `src_${sanitizeId(programName)}`;
  nodes.push({ id: sourceId, label: programName, type: 'source', startLine: 0 });

  const seen = new Set<string>();
  const lines = content.split('\n');
  const callRegex = /CALL\s+PGM\(\s*(?:[\w*/]+\/)?\s*(\w+)/gi;
  const sbmRegex = /SBMJOB\s+.*CMD\(\s*CALL\s+PGM\(\s*(?:[\w*/]+\/)?\s*(\w+)/gi;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    let m: RegExpExecArray | null;

    callRegex.lastIndex = 0;
    while ((m = callRegex.exec(line)) !== null) {
      const target = m[1].toUpperCase();
      const nid = `c_${sanitizeId(target)}`;
      if (!seen.has(nid)) {
        seen.add(nid);
        nodes.push({ id: nid, label: target, type: 'call', startLine: i + 1 });
      }
      edges.push({ source: sourceId, target: nid, label: 'CALL PGM', line: i + 1 });
    }

    sbmRegex.lastIndex = 0;
    while ((m = sbmRegex.exec(line)) !== null) {
      const target = m[1].toUpperCase();
      const nid = `sbm_${sanitizeId(target)}`;
      if (!seen.has(nid)) {
        seen.add(nid);
        nodes.push({ id: nid, label: target, type: 'call', startLine: i + 1 });
      }
      edges.push({ source: sourceId, target: nid, label: 'SBMJOB', line: i + 1 });
    }
  }

  return nodes.length > 1 ? { nodes, edges } : null;
}

function generateClDependencyMap(content: string, filePath: string): DiagramData | null {
  // CL doesn't typically have COPY, but check for included files
  const nodes: DiagramNode[] = [];
  const edges: DiagramEdge[] = [];
  const programName = path.basename(filePath, path.extname(filePath)).toUpperCase();
  const sourceId = `src_${sanitizeId(programName)}`;
  nodes.push({ id: sourceId, label: programName, type: 'source', startLine: 0 });

  // DCLF (Declare File) references
  const dclfRegex = /DCLF\s+FILE\(\s*(?:[\w*/]+\/)?\s*(\w+)/gi;
  const lines = content.split('\n');
  const seen = new Set<string>();

  for (let i = 0; i < lines.length; i++) {
    dclfRegex.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = dclfRegex.exec(lines[i])) !== null) {
      const target = m[1].toUpperCase();
      const nid = `f_${sanitizeId(target)}`;
      if (!seen.has(nid)) {
        seen.add(nid);
        nodes.push({ id: nid, label: target, type: 'file', startLine: i + 1 });
      }
      edges.push({ source: sourceId, target: nid, label: 'DCLF', line: i + 1 });
    }
  }

  return nodes.length > 1 ? { nodes, edges } : null;
}

function generateClStructureChart(content: string): DiagramData | null {
  const nodes: DiagramNode[] = [];
  const lines = content.split('\n');
  const subrRegex = /^\s*SUBR\s+SUBR\(\s*(\w+)\s*\)/i;
  let idx = 0;

  for (let i = 0; i < lines.length; i++) {
    const m = subrRegex.exec(lines[i]);
    if (m) {
      nodes.push({
        id: `s${idx}`,
        label: m[1],
        type: 'subroutine',
        startLine: i + 1,
        level: 2,
      });
      idx++;
    }
  }

  if (nodes.length === 0) return null;
  // Add main program node
  nodes.unshift({ id: 'main', label: 'MAIN', type: 'section', startLine: 1, level: 1 });
  return { nodes, edges: [] };
}

function generateClProcedureFlow(content: string): DiagramData | null {
  // CL doesn't have paragraphs — use subroutines + labels
  const nodes: DiagramNode[] = [];
  const edges: DiagramEdge[] = [];
  const lines = content.split('\n');
  const labelRegex = /^(\s*)(\w+):\s*(.*)/;
  const subrRegex = /^\s*SUBR\s+SUBR\(\s*(\w+)\s*\)/i;
  let idx = 0;

  for (let i = 0; i < lines.length; i++) {
    let m = subrRegex.exec(lines[i]);
    if (m) {
      nodes.push({ id: `p${idx}`, label: m[1], type: 'subroutine', startLine: i + 1, level: 2 });
      idx++;
      continue;
    }
    m = labelRegex.exec(lines[i]);
    if (m) {
      nodes.push({ id: `p${idx}`, label: m[2], type: 'label', startLine: i + 1, level: 2 });
      idx++;
    }
  }

  if (nodes.length < 2) return null;

  // Add fallthrough edges
  for (let i = 0; i < nodes.length - 1; i++) {
    edges.push({ source: nodes[i].id, target: nodes[i + 1].id, edgeType: 'fallthrough' });
  }

  return { nodes, edges };
}

function generateClControlFlow(
  content: string,
  filePath: string,
  sectionId?: number,
): DiagramData | null {
  const lines = content.split('\n');
  const stripped = lines.map((line) => line.trimEnd());

  const flowData = parseClControlFlow(stripped, 1, path.basename(filePath, path.extname(filePath)));

  if (flowData.nodes.length === 0) return null;

  return {
    nodes: flowData.nodes,
    edges: flowData.edges,
    diagram_type: 'control_flow',
    data: flowData,
  };
}

// ── RPG Diagram Generators ──────────────────────────────────

function generateRpgDiagram(
  filePath: string,
  content: string,
  diagramType: LegacyDiagramType,
  info: FileTypeInfo,
): DiagramData | null {
  const parser = new RpgParser();
  const program = parser.parse(content, filePath);

  switch (diagramType) {
    case 'call_graph':
      return generateRpgCallGraph(program, content, filePath);
    case 'dependency_map':
    case 'copybook_tree':
      return generateRpgDependencyMap(program, filePath);
    case 'structure_chart':
      return generateRpgStructureChart(program);
    case 'procedure_flow':
      return generateRpgProcedureFlow(program);
    case 'field_hierarchy':
    case 'record_layout':
      return generateRpgFieldHierarchy(program);
    case 'file_io':
      return generateRpgFileIo(program);
    default:
      return null;
  }
}

function generateRpgCallGraph(
  program: RpgProgram,
  content: string,
  filePath: string,
): DiagramData | null {
  const nodes: DiagramNode[] = [];
  const edges: DiagramEdge[] = [];
  const programName = path.basename(filePath, path.extname(filePath)).toUpperCase();
  const sourceId = `src_${sanitizeId(programName)}`;
  nodes.push({ id: sourceId, label: programName, type: 'source', startLine: 0 });

  // Extract CALLP and CALL from content
  const callRegex = /CALLP?\s+(\w+)\s*\(/gi;
  const lines = content.split('\n');
  const seen = new Set<string>();

  for (let i = 0; i < lines.length; i++) {
    callRegex.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = callRegex.exec(lines[i])) !== null) {
      const target = m[1].toUpperCase();
      if (['IF', 'FOR', 'DOW', 'DOU', 'WHEN', 'EVAL', 'RETURN'].includes(target)) continue;
      const nid = `c_${sanitizeId(target)}`;
      if (!seen.has(nid)) {
        seen.add(nid);
        nodes.push({ id: nid, label: target, type: 'call', startLine: i + 1 });
      }
      edges.push({ source: sourceId, target: nid, label: 'CALL', line: i + 1 });
    }
  }

  return nodes.length > 1 ? { nodes, edges } : null;
}

function generateRpgDependencyMap(program: RpgProgram, filePath: string): DiagramData | null {
  if (program.copyDirectives.length === 0) return null;

  const nodes: DiagramNode[] = [];
  const edges: DiagramEdge[] = [];
  const programName = path.basename(filePath, path.extname(filePath)).toUpperCase();
  const sourceId = `src_${sanitizeId(programName)}`;
  nodes.push({ id: sourceId, label: programName, type: 'source', startLine: 0 });

  const seen = new Set<string>();
  for (const copy of program.copyDirectives) {
    const nid = `cp_${sanitizeId(copy.name)}`;
    if (!seen.has(nid)) {
      seen.add(nid);
      nodes.push({ id: nid, label: copy.name, type: 'copybook', startLine: copy.line });
    }
    edges.push({ source: sourceId, target: nid, label: '/COPY', line: copy.line });
  }

  return { nodes, edges };
}

function generateRpgStructureChart(program: RpgProgram): DiagramData | null {
  const items = [...program.procedures, ...program.subroutines];
  if (items.length < 2) return null;

  const nodes: DiagramNode[] = [];
  for (let i = 0; i < items.length; i++) {
    nodes.push({
      id: `p${i}`,
      label: items[i].name,
      type: items[i].type,
      startLine: items[i].line,
      endLine: items[i].endLine,
      level: items[i].type === 'procedure' ? 1 : 2,
    });
  }

  return { nodes, edges: [] };
}

function generateRpgProcedureFlow(program: RpgProgram): DiagramData | null {
  const items = [...program.procedures, ...program.subroutines].sort((a, b) => a.line - b.line);
  if (items.length < 2) return null;

  const nodes: DiagramNode[] = [];
  const edges: DiagramEdge[] = [];

  for (let i = 0; i < items.length; i++) {
    nodes.push({
      id: `p${i}`,
      label: items[i].name,
      type: items[i].type,
      startLine: items[i].line,
      endLine: items[i].endLine,
      lineCount: Math.max(1, items[i].endLine - items[i].line + 1),
    });
  }

  // Fallthrough edges
  for (let i = 0; i < items.length - 1; i++) {
    edges.push({ source: `p${i}`, target: `p${i + 1}`, edgeType: 'fallthrough' });
  }

  return { nodes, edges };
}

function generateRpgFieldHierarchy(program: RpgProgram): DiagramData | null {
  if (program.dataStructures.length === 0) return null;

  const nodes: DiagramNode[] = [];
  const edges: DiagramEdge[] = [];
  let idx = 0;

  for (const ds of program.dataStructures) {
    const dsNid = `d${idx}`;
    nodes.push({ id: dsNid, label: ds.name, type: 'record', startLine: ds.line, level: 1 });
    idx++;

    for (const field of ds.fields) {
      const fNid = `d${idx}`;
      nodes.push({ id: fNid, label: field.name, type: 'field', startLine: field.line, level: 2 });
      edges.push({ source: dsNid, target: fNid });
      idx++;
    }
  }

  return { nodes, edges };
}

function generateRpgFileIo(program: RpgProgram): DiagramData | null {
  if (program.fileDeclarations.length === 0) return null;

  const nodes: DiagramNode[] = [];
  const edges: DiagramEdge[] = [];
  nodes.push({ id: 'src', label: 'PROGRAM', type: 'program', startLine: 0 });

  for (let i = 0; i < program.fileDeclarations.length; i++) {
    const fd = program.fileDeclarations[i];
    const nid = `io_${i}`;
    nodes.push({ id: nid, label: fd.name, type: 'file', startLine: fd.line });
    edges.push({ source: 'src', target: nid, label: 'DCL-F', line: fd.line });
  }

  return { nodes, edges };
}

// ── PL/I Diagram Generators ─────────────────────────────────

function generatePliDiagram(
  filePath: string,
  content: string,
  diagramType: LegacyDiagramType,
  info: FileTypeInfo,
): DiagramData | null {
  const parser = new PliParser();
  const program = parser.parse(content, filePath);

  switch (diagramType) {
    case 'call_graph':
      return generatePliCallGraph(program, filePath);
    case 'dependency_map':
    case 'copybook_tree':
      return generatePliDependencyMap(program, filePath);
    case 'structure_chart':
      return generatePliStructureChart(program);
    case 'procedure_flow':
      return generatePliProcedureFlow(program);
    case 'field_hierarchy':
    case 'record_layout':
      return generatePliFieldHierarchy(program);
    default:
      return null;
  }
}

function generatePliCallGraph(program: PliProgram, filePath: string): DiagramData | null {
  if (program.callStatements.length === 0) return null;

  const nodes: DiagramNode[] = [];
  const edges: DiagramEdge[] = [];
  const programName = path.basename(filePath, path.extname(filePath)).toUpperCase();
  const sourceId = `src_${sanitizeId(programName)}`;
  nodes.push({ id: sourceId, label: programName, type: 'source', startLine: 0 });

  const seen = new Set<string>();
  for (const call of program.callStatements) {
    const nid = `c_${sanitizeId(call.target)}`;
    if (!seen.has(nid)) {
      seen.add(nid);
      nodes.push({ id: nid, label: call.target, type: 'call', startLine: call.line });
    }
    edges.push({ source: sourceId, target: nid, label: 'CALL', line: call.line });
  }

  return { nodes, edges };
}

function generatePliDependencyMap(program: PliProgram, filePath: string): DiagramData | null {
  if (program.includes.length === 0) return null;

  const nodes: DiagramNode[] = [];
  const edges: DiagramEdge[] = [];
  const programName = path.basename(filePath, path.extname(filePath)).toUpperCase();
  const sourceId = `src_${sanitizeId(programName)}`;
  nodes.push({ id: sourceId, label: programName, type: 'source', startLine: 0 });

  const seen = new Set<string>();
  for (const inc of program.includes) {
    const nid = `inc_${sanitizeId(inc.name)}`;
    if (!seen.has(nid)) {
      seen.add(nid);
      nodes.push({ id: nid, label: inc.name, type: 'copybook', startLine: inc.line });
    }
    edges.push({ source: sourceId, target: nid, label: '%INCLUDE', line: inc.line });
  }

  return { nodes, edges };
}

function generatePliStructureChart(program: PliProgram): DiagramData | null {
  if (program.procedures.length < 2) return null;

  const nodes: DiagramNode[] = [];
  for (let i = 0; i < program.procedures.length; i++) {
    const proc = program.procedures[i];
    nodes.push({
      id: `p${i}`,
      label: proc.name,
      type: proc.type,
      startLine: proc.line,
      endLine: proc.endLine,
      level: proc.type === 'external' ? 1 : 2,
    });
  }

  return { nodes, edges: [] };
}

function generatePliProcedureFlow(program: PliProgram): DiagramData | null {
  if (program.procedures.length < 2) return null;

  const nodes: DiagramNode[] = [];
  const edges: DiagramEdge[] = [];

  for (let i = 0; i < program.procedures.length; i++) {
    const proc = program.procedures[i];
    nodes.push({
      id: `p${i}`,
      label: proc.name,
      type: proc.type,
      startLine: proc.line,
      endLine: proc.endLine,
      lineCount: Math.max(1, proc.endLine - proc.line + 1),
    });
  }

  for (let i = 0; i < program.procedures.length - 1; i++) {
    edges.push({ source: `p${i}`, target: `p${i + 1}`, edgeType: 'fallthrough' });
  }

  return { nodes, edges };
}

function generatePliFieldHierarchy(program: PliProgram): DiagramData | null {
  if (program.structures.length === 0) return null;

  const nodes: DiagramNode[] = [];
  const edges: DiagramEdge[] = [];
  let idx = 0;

  for (const struct of program.structures) {
    const structNid = `d${idx}`;
    nodes.push({
      id: structNid,
      label: struct.name,
      type: 'record',
      startLine: struct.line,
      level: 1,
    });
    idx++;

    for (const member of struct.members) {
      const mNid = `d${idx}`;
      nodes.push({
        id: mNid,
        label: member.name,
        type: 'field',
        startLine: member.line,
        level: member.level,
      });
      edges.push({ source: structNid, target: mNid });
      idx++;
    }
  }

  return { nodes, edges };
}

// ══════════════════════════════════════════════════════════════
//  Mermaid Conversion
// ══════════════════════════════════════════════════════════════

function diagramDataToMermaid(diagramType: string, data: DiagramData): string {
  // For control_flow, use the nested data
  const nodes = data.data?.nodes ?? data.nodes;
  const edges = data.data?.edges ?? data.edges;

  if (!nodes || nodes.length === 0) return '```mermaid\ngraph TD\n  empty["No data"]\n```';

  // Direction based on diagram type
  const horizontalTypes = new Set(['file_io', 'dependency_map', 'copybook_tree', 'call_graph']);
  const dirCode = horizontalTypes.has(diagramType) ? 'LR' : 'TD';

  const lines: string[] = [`graph ${dirCode}`];

  // Render nodes with shapes based on type
  for (const n of nodes) {
    lines.push(nodeShape(n));
  }

  // Render edges with labels and styles
  for (const e of edges) {
    const src = sanitizeMermaidId(e.source);
    const tgt = sanitizeMermaidId(e.target);
    const elabel = sanitizeMermaidLabel(e.label ?? '');
    const etype = e.edgeType ?? '';

    let arrow: string;
    if (etype === 'goto' || etype === 'loop_back' || elabel.toUpperCase() === 'GOTO') {
      arrow = elabel ? `-. ${elabel} .->` : '-.->';
    } else if (etype === 'true') {
      arrow = `-- ${elabel || 'Y'} -->`;
    } else if (etype === 'false') {
      arrow = `-- ${elabel || 'N'} -->`;
    } else if (etype === 'when') {
      arrow = `-- ${elabel} -->`;
    } else if (etype === 'fallthrough') {
      arrow = '-->';
    } else if (elabel) {
      arrow = `-- ${elabel} -->`;
    } else {
      arrow = '-->';
    }
    lines.push(`    ${src} ${arrow} ${tgt}`);
  }

  // Style source nodes
  const sourceIds = nodes
    .filter((n) => n.type === 'source' || n.type === 'program')
    .map((n) => sanitizeMermaidId(n.id));
  if (sourceIds.length > 0) {
    lines.push(`    style ${sourceIds.join(',')} fill:#0078d4,color:#fff,stroke:#005a9e`);
  }

  // Add section info as comment if control_flow
  if (data.sections && data.section_name) {
    lines.push('');
    lines.push(`%% Section: ${data.section_name} (id=${data.section_id})`);
    lines.push(
      `%% Available sections: ${data.sections.map((s) => `${s.id}:${s.name}`).join(', ')}`,
    );
  }

  return '```mermaid\n' + lines.join('\n') + '\n```';
}

function nodeShape(node: DiagramNode): string {
  const nid = sanitizeMermaidId(node.id);
  const label = sanitizeMermaidLabel(node.label || node.id);
  const ntype = node.type ?? '';

  switch (ntype) {
    case 'source':
    case 'program':
    case 'main':
      return `    ${nid}("${label}")`;
    case 'decision':
      return `    ${nid}{"${label}"}`;
    case 'group':
    case 'record':
      return `    ${nid}("${label}")`;
    case 'terminal':
      return `    ${nid}(["${label}"])`;
    case 'merge':
      return label ? `    ${nid}(("${label}"))` : `    ${nid}((" "))`;
    case 'call':
    case 'copybook':
    case 'include':
      return `    ${nid}[["${label}"]]`;
    case 'loop':
      return `    ${nid}(["${label}"])`;
    case 'io':
    case 'file':
      return `    ${nid}[/"${label}"/]`;
    case 'goto':
      return `    ${nid}{{"${label}"}}`;
    case 'section':
      return `    ${nid}(["${label}"])`;
    case 'paragraph':
    case 'subroutine':
    case 'procedure':
      return `    ${nid}["${label}"]`;
    case 'field':
      return `    ${nid}{{"${label}"}}`;
    default:
      return `    ${nid}["${label}"]`;
  }
}

// ══════════════════════════════════════════════════════════════
//  Modern Language Diagrams (backward compatible)
// ══════════════════════════════════════════════════════════════

function generateModernMermaid(files: string[], type: string, root: string): string {
  switch (type) {
    case 'dependency':
      return generateDependencyDiagram(files, root);
    case 'structure':
      return generateStructureDiagram(files, root);
    case 'class':
      return generateClassDiagram(files, root);
    case 'call-graph':
    default:
      return generateCallGraphDiagram(files, root);
  }
}

function generateDependencyDiagram(files: string[], root: string): string {
  const lines = ['graph TD'];
  const nodes = new Set<string>();
  const edges = new Set<string>();

  for (const file of files) {
    const content = fs.readFileSync(file, 'utf-8');
    const relPath = path.relative(root, file).replace(/\\/g, '/');
    const nodeId = sanitizeId(relPath);
    nodes.add(nodeId);

    const importRegex =
      /(?:import\s+.*from\s+['"]([^'"]+)['"]|require\s*\(\s*['"]([^'"]+)['"]\s*\))/g;
    let match;
    while ((match = importRegex.exec(content)) !== null) {
      const importPath = match[1] ?? match[2];
      if (importPath.startsWith('.')) {
        const resolved = path.resolve(path.dirname(file), importPath).replace(/\\/g, '/');
        const resolvedRel = path.relative(root, resolved).replace(/\\/g, '/');
        const targetId = sanitizeId(resolvedRel);
        edges.add(`  ${nodeId} --> ${targetId}`);
      }
    }
  }

  for (const nodeId of nodes) {
    lines.push(`  ${nodeId}["${unsanitizeId(nodeId)}"]`);
  }
  for (const edge of edges) {
    lines.push(edge);
  }

  return '```mermaid\n' + lines.join('\n') + '\n```';
}

function generateStructureDiagram(files: string[], root: string): string {
  const lines = ['graph TD'];
  const dirs = new Map<string, string[]>();

  for (const file of files) {
    const relPath = path.relative(root, file).replace(/\\/g, '/');
    const dir = path.dirname(relPath);
    const list = dirs.get(dir) ?? [];
    list.push(path.basename(relPath));
    dirs.set(dir, list);
  }

  for (const [dir, dirFiles] of dirs) {
    const dirId = sanitizeId(dir);
    lines.push(`  subgraph ${dirId}["${dir}"]`);
    for (const f of dirFiles.slice(0, 15)) {
      const fileId = sanitizeId(`${dir}/${f}`);
      lines.push(`    ${fileId}["${f}"]`);
    }
    if (dirFiles.length > 15) {
      lines.push(`    more_${dirId}["... +${dirFiles.length - 15} more"]`);
    }
    lines.push('  end');
  }

  return '```mermaid\n' + lines.join('\n') + '\n```';
}

function generateClassDiagram(files: string[], root: string): string {
  const lines = ['classDiagram'];

  for (const file of files) {
    const content = fs.readFileSync(file, 'utf-8');
    const classRegex =
      /(?:export\s+)?(?:abstract\s+)?class\s+(\w+)(?:\s+extends\s+(\w+))?(?:\s+implements\s+([\w,\s]+))?/g;
    let match;
    while ((match = classRegex.exec(content)) !== null) {
      const className = match[1];
      lines.push(`  class ${className}`);

      if (match[2]) {
        lines.push(`  ${match[2]} <|-- ${className}`);
      }
      if (match[3]) {
        const interfaces = match[3].split(',').map((s) => s.trim());
        for (const iface of interfaces) {
          lines.push(`  ${iface} <|.. ${className}`);
        }
      }

      // Extract methods
      const contentLines = content.split('\n');
      const startLine = content.slice(0, match.index).split('\n').length - 1;
      let braceCount = 0;
      let started = false;
      for (let i = startLine; i < contentLines.length && i < startLine + 100; i++) {
        const line = contentLines[i];
        const opens = (line.match(/{/g) ?? []).length;
        const closes = (line.match(/}/g) ?? []).length;
        if (opens > 0) started = true;
        braceCount += opens - closes;

        const mMatch = line.match(
          /^\s+(?:public\s+|private\s+|protected\s+)?(?:static\s+)?(?:async\s+)?(\w+)\s*\(/,
        );
        if (mMatch && mMatch[1] !== 'constructor' && started) {
          lines.push(`  ${className} : +${mMatch[1]}()`);
        }

        if (started && braceCount <= 0) break;
      }
    }
  }

  if (lines.length === 1) {
    return '```mermaid\nclassDiagram\n  class NoClassesFound\n```';
  }

  return '```mermaid\n' + lines.join('\n') + '\n```';
}

function generateCallGraphDiagram(files: string[], root: string): string {
  const lines = ['graph LR'];
  const calls = new Set<string>();

  for (const file of files) {
    const content = fs.readFileSync(file, 'utf-8');
    const relPath = path.relative(root, file).replace(/\\/g, '/');

    const funcRegex =
      /(?:export\s+)?(?:async\s+)?function\s+(\w+)|(?:export\s+)?const\s+(\w+)\s*=\s*(?:async\s+)?/g;
    let match;
    while ((match = funcRegex.exec(content)) !== null) {
      const funcName = match[1] ?? match[2];
      if (!funcName) continue;

      const nodeId = sanitizeId(`${relPath}:${funcName}`);
      lines.push(`  ${nodeId}["${funcName}"]`);

      const afterFunc = content.slice(match.index);
      const callRegex = /\b(\w+)\s*\(/g;
      let callMatch;
      let lineCount = 0;
      while ((callMatch = callRegex.exec(afterFunc)) !== null && lineCount < 50) {
        const calledFunc = callMatch[1];
        if (
          ['if', 'for', 'while', 'switch', 'catch', 'return', 'new', funcName].includes(calledFunc)
        )
          continue;
        const targetId = sanitizeId(`call:${calledFunc}`);
        calls.add(`  ${nodeId} --> ${targetId}["${calledFunc}"]`);
        lineCount++;
      }
    }
  }

  for (const call of Array.from(calls).slice(0, 50)) {
    lines.push(call);
  }

  return '```mermaid\n' + lines.join('\n') + '\n```';
}

// ══════════════════════════════════════════════════════════════
//  Utilities
// ══════════════════════════════════════════════════════════════

function collectFiles(dir: string, files: string[], maxDepth: number, depth: number = 0): void {
  if (depth > maxDepth) return;
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (['node_modules', '.git', 'dist', '.OpenCob'].includes(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      collectFiles(full, files, maxDepth, depth + 1);
    } else if (
      /\.(ts|js|py|java|go|cob|cbl|ccp|cbe|sbc|ccc|rpg|rpgle|sqlrpgle|clle|clp|pf|lf|dspf|prtf|dds|map|cpy|pli|pl1|inc|pco|sqb|obs)$/i.test(
        entry.name,
      )
    ) {
      files.push(full);
    }
  }
}

function sanitizeId(id: string): string {
  return id.replace(/[^a-zA-Z0-9]/g, '_');
}

function unsanitizeId(id: string): string {
  return id.replace(/_/g, '/');
}

function sanitizeMermaidId(rawId: string): string {
  return rawId.replace(/[^a-zA-Z0-9_]/g, '_');
}

function sanitizeMermaidLabel(label: string): string {
  return label.replace(/"/g, "'").replace(/\n/g, ' ').replace(/\[/g, '(').replace(/]/g, ')').trim();
}

function safeReadFile(filePath: string): string | null {
  try {
    return fs.readFileSync(filePath, 'utf-8');
  } catch {
    // Fallback to latin-1 for legacy mainframe files
    try {
      return fs.readFileSync(filePath, 'latin1');
    } catch {
      return null;
    }
  }
}

// ══════════════════════════════════════════════════════════════
//  BMS Diagram Generators (3270 screen maps)
// ══════════════════════════════════════════════════════════════

function generateBmsDiagram(
  fullPath: string,
  content: string,
  diagramType: LegacyDiagramType,
): DiagramData | null {
  const parsed = parseBmsMap(content);

  switch (diagramType) {
    case 'screen_layout':
      return generateBmsScreenLayout(parsed, fullPath);
    case 'dependency_map':
    case 'copybook_tree':
      return generateBmsDependencyMap(parsed, fullPath);
    default:
      return null;
  }
}

function generateBmsScreenLayout(parsed: BmsParseResult, filePath: string): DiagramData | null {
  if (parsed.fields.length === 0) return null;

  const nodes: DiagramNode[] = [];
  for (let i = 0; i < parsed.fields.length; i++) {
    const mf = parsed.fields[i];
    const fieldType = mf.attrb && mf.attrb.toUpperCase().includes('UNPROT') ? 'input' : 'output';
    // For output fields with INITIAL, use the INITIAL text as display
    const displayLabel = fieldType === 'output' && mf.initialVal ? mf.initialVal : undefined;
    nodes.push({
      id: `m${i}`,
      label: mf.fieldName || mf.mapName,
      displayLabel,
      type: fieldType,
      startLine: mf.startLine,
      row: mf.row ?? undefined,
      col: mf.col ?? undefined,
      length: mf.length ?? undefined,
      attrb: mf.attrb || undefined,
      initial: mf.initialVal || undefined,
    });
  }

  const programId = path.basename(filePath, path.extname(filePath)).toUpperCase();

  return {
    nodes,
    edges: [],
    screen: {
      rows: 24,
      cols: 80,
      title: programId,
      platform: '3270',
      funcKeys: [],
    },
  };
}

function generateBmsDependencyMap(parsed: BmsParseResult, filePath: string): DiagramData | null {
  const nodes: DiagramNode[] = [];
  const edges: DiagramEdge[] = [];
  const programId = path.basename(filePath, path.extname(filePath)).toUpperCase();
  const sourceId = `src_${sanitizeId(programId)}`;
  nodes.push({ id: sourceId, label: programId, type: 'source', startLine: 0 });

  for (const map of parsed.maps) {
    const mapId = `map_${sanitizeId(map.name)}`;
    nodes.push({ id: mapId, label: map.name, type: 'screen', startLine: map.startLine });
    edges.push({ source: sourceId, target: mapId, label: 'contains' });
  }

  return nodes.length > 1 ? { nodes, edges } : null;
}

// ══════════════════════════════════════════════════════════════
//  DDS Diagram Generators (AS/400 Physical/Logical/Display/Print)
// ══════════════════════════════════════════════════════════════

function generateDdsDiagram(
  fullPath: string,
  content: string,
  diagramType: LegacyDiagramType,
): DiagramData | null {
  const parsed = parseDds(content, fullPath);

  switch (diagramType) {
    case 'screen_layout':
      return generateDdsScreenLayout(parsed, fullPath);
    case 'record_layout':
      return generateDdsRecordLayout(parsed);
    case 'field_hierarchy':
      return generateDdsFieldHierarchy(parsed);
    case 'dependency_map':
    case 'copybook_tree':
      return generateDdsDependencyMap(parsed, fullPath);
    default:
      return null;
  }
}

function generateDdsScreenLayout(parsed: DdsParseResult, filePath: string): DiagramData | null {
  // Only DSPF files have screen positions
  const positioned = parsed.allFields.filter((f) => f.row !== null && f.col !== null);
  if (positioned.length === 0) return null;

  const nodes: DiagramNode[] = [];
  for (let i = 0; i < positioned.length; i++) {
    const d = positioned[i];
    const usage = (d.usage || '').toUpperCase();
    const fieldType = d.isConstant
      ? 'constant'
      : usage === 'B' || usage === 'I'
        ? 'input'
        : 'output';
    const length = d.fieldLength || d.constantLength || 1;
    const label = d.fieldName || d.textDesc || d.constantKeyword || '';
    const displayLabel = d.isConstant
      ? d.textDesc || d.constantKeyword || ''
      : d.textDesc || d.alias || d.fieldName || '';

    nodes.push({
      id: `sf${i}`,
      label,
      displayLabel,
      type: fieldType,
      startLine: d.startLine,
      row: d.row ?? undefined,
      col: d.col ?? undefined,
      length,
      usage,
      alias: d.alias || undefined,
      attrb: d.colHeading || undefined,
      initial: d.isConstant ? d.textDesc : undefined,
    });
  }

  const programId = path.basename(filePath, path.extname(filePath)).toUpperCase();
  const meta = parsed.screenMeta;

  return {
    nodes,
    edges: [],
    screen: {
      rows: meta?.rows ?? 24,
      cols: meta?.cols ?? 80,
      title: programId,
      platform: '5250',
      funcKeys: meta?.funcKeys ?? [],
    },
  };
}

function generateDdsRecordLayout(parsed: DdsParseResult): DiagramData | null {
  if (parsed.records.length === 0) return null;

  const nodes: DiagramNode[] = [];
  const edges: DiagramEdge[] = [];

  for (const rec of parsed.records) {
    const recId = `rec_${sanitizeId(rec.name)}`;
    nodes.push({ id: recId, label: rec.name, type: 'record', startLine: rec.startLine });

    for (const field of rec.fields) {
      if (!field.fieldName) continue;
      const fid = `fld_${sanitizeId(rec.name)}_${sanitizeId(field.fieldName)}`;
      const lengthStr = field.fieldLength
        ? ` (${field.fieldType || 'A'}${field.fieldLength}${field.decimalPos ? ',' + field.decimalPos : ''})`
        : '';
      nodes.push({
        id: fid,
        label: `${field.fieldName}${lengthStr}`,
        type: 'field',
        startLine: field.startLine,
      });
      edges.push({ source: recId, target: fid });
    }

    // Key fields
    for (const key of rec.keys) {
      const keyId = `key_${sanitizeId(rec.name)}_${sanitizeId(key)}`;
      nodes.push({ id: keyId, label: `KEY: ${key}`, type: 'key', startLine: 0 });
      edges.push({ source: recId, target: keyId, label: 'key' });
    }
  }

  return nodes.length > 0 ? { nodes, edges } : null;
}

function generateDdsFieldHierarchy(parsed: DdsParseResult): DiagramData | null {
  if (parsed.allFields.length === 0) return null;

  const nodes: DiagramNode[] = [];
  const edges: DiagramEdge[] = [];

  const fileId = `file_${sanitizeId(parsed.programId)}`;
  nodes.push({ id: fileId, label: parsed.programId, type: 'source', startLine: 0 });

  for (const rec of parsed.records) {
    const recId = `rec_${sanitizeId(rec.name)}`;
    nodes.push({ id: recId, label: rec.name, type: 'record', startLine: rec.startLine });
    edges.push({ source: fileId, target: recId });

    for (const field of rec.fields) {
      if (!field.fieldName) continue;
      const fid = `fld_${sanitizeId(rec.name)}_${sanitizeId(field.fieldName)}`;
      nodes.push({ id: fid, label: field.fieldName, type: 'field', startLine: field.startLine });
      edges.push({ source: recId, target: fid });
    }
  }

  return nodes.length > 1 ? { nodes, edges } : null;
}

function generateDdsDependencyMap(parsed: DdsParseResult, filePath: string): DiagramData | null {
  if (parsed.references.length === 0) return null;

  const nodes: DiagramNode[] = [];
  const edges: DiagramEdge[] = [];
  const programId = path.basename(filePath, path.extname(filePath)).toUpperCase();
  const sourceId = `src_${sanitizeId(programId)}`;
  nodes.push({ id: sourceId, label: programId, type: 'source', startLine: 0 });

  const seen = new Set<string>();
  for (const ref of parsed.references) {
    if (seen.has(ref.target)) continue;
    seen.add(ref.target);
    const refId = `ref_${sanitizeId(ref.target)}`;
    nodes.push({ id: refId, label: ref.target, type: 'include', startLine: ref.line });
    edges.push({ source: sourceId, target: refId, label: ref.type });
  }

  return nodes.length > 1 ? { nodes, edges } : null;
}

// ══════════════════════════════════════════════════════════════
//  Screen Layout ASCII Art Renderer
// ══════════════════════════════════════════════════════════════

/**
 * Render a screen_layout diagram as ASCII art (24x80 or 27x132 terminal).
 * Matches DriverX _screen_layout_to_ascii() output format.
 */
function screenLayoutToAscii(data: DiagramData): string {
  const screen = data.screen;
  const rows = screen?.rows ?? 24;
  const cols = screen?.cols ?? 80;
  const title = screen?.title ?? '';
  const funcKeys = screen?.funcKeys ?? [];

  // Create buffer (rows+1 x cols+1, 1-indexed)
  const buf: string[][] = Array.from({ length: rows + 1 }, () => Array(cols + 1).fill(' '));

  for (const n of data.nodes) {
    const r = (n as any).row as number | undefined;
    const c = (n as any).col as number | undefined;
    const length = (n as any).length as number | undefined;
    const displayLabel = (n as any).displayLabel ?? n.label ?? '';
    const ntype = n.type ?? '';

    if (!r || r < 1 || r > rows || !c || c < 1) continue;

    let text: string;
    if (ntype === 'input') {
      text = '_'.repeat(Math.max(length ?? 1, 1));
    } else if (displayLabel.trim()) {
      text = displayLabel;
    } else {
      continue;
    }

    if (length && length > 0) {
      text = text.slice(0, length);
    }

    for (let i = 0; i < text.length; i++) {
      const pos = c + i;
      if (pos >= 1 && pos <= cols) {
        buf[r][pos] = text[i];
      }
    }
  }

  const out: string[] = [];
  const border = '+' + '-'.repeat(cols) + '+';
  out.push(border);
  for (let r = 1; r <= rows; r++) {
    out.push('|' + buf[r].slice(1, cols + 1).join('') + '|');
  }
  out.push(border);
  if (title) {
    out.push(`  Screen: ${title}`);
  }
  if (funcKeys.length > 0) {
    out.push(`  Keys: ${funcKeys.join(', ')}`);
  }

  return out.join('\n');
}

// ══════════════════════════════════════════════════════════════
//  Content-based diagram generation (no file on disk)
// ══════════════════════════════════════════════════════════════

/**
 * Generate a diagram from raw source content without requiring a file on disk.
 * Used for IBM i source members fetched via SSH or Object Browser.
 */
export function generateDiagramFromContent(
  content: string,
  extension: string,
  diagramType: DiagramType,
  sectionId?: number,
): { success: boolean; content: string; metadata?: Record<string, unknown> } {
  const ext = extension.replace(/^\./, '').toLowerCase();
  const info = classifyExtension(ext);
  if (!info) {
    return { success: false, content: `Error: unrecognized extension .${ext}` };
  }

  // Create a synthetic path for parsers that need it
  const syntheticPath = `/tmp/opencob_virtual/source.${ext}`;

  const validTypes = DIAGRAM_TYPES[info.category] ?? [];
  const legacyType = diagramType as LegacyDiagramType;
  if (!validTypes.includes(legacyType)) {
    return {
      success: false,
      content: `Error: diagram type "${diagramType}" not available for ${info.category} files. Available: ${validTypes.join(', ')}`,
    };
  }

  let data: DiagramData | null = null;

  if (COBOL_EXTS.has(ext)) {
    const parser = new CobolParser();
    const program = parser.parse(content, syntheticPath);
    data = generateCobolDiagram(syntheticPath, content, legacyType, info, sectionId);
  } else if (CL_EXTS.has(ext)) {
    data = generateClDiagram(syntheticPath, content, legacyType, info, sectionId);
  } else if (RPG_EXTS.has(ext)) {
    data = generateRpgDiagram(syntheticPath, content, legacyType, info);
  } else if (PLI_EXTS.has(ext)) {
    data = generatePliDiagram(syntheticPath, content, legacyType, info);
  } else if (BMS_EXTS.has(ext)) {
    data = generateBmsDiagram(syntheticPath, content, legacyType);
  } else if (DDS_EXTS.has(ext)) {
    data = generateDdsDiagram(syntheticPath, content, legacyType);
  }

  if (!data || (data.nodes.length === 0 && !data.data)) {
    return {
      success: false,
      content: `No data found for diagram type "${diagramType}" in this content.`,
    };
  }

  // For screen_layout, render ASCII art
  if (diagramType === 'screen_layout' && data.screen) {
    const ascii = screenLayoutToAscii(data);
    return {
      success: true,
      content: ascii,
      metadata: {
        type: diagramType,
        format: 'ascii',
        category: info.category,
        platform: info.platform,
        language: info.language,
        screen: data.screen,
        fieldCount: data.nodes.length,
      },
    };
  }

  const mermaid = diagramDataToMermaid(legacyType, data);
  return {
    success: true,
    content: mermaid,
    metadata: {
      type: diagramType,
      format: 'mermaid',
      category: info.category,
      platform: info.platform,
      language: info.language,
      nodeCount: data.nodes?.length ?? 0,
      edgeCount: data.edges?.length ?? 0,
    },
  };
}
