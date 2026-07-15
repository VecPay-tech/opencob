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
import { diagramCache } from './diagram-cache.js';
import {
  type DiagramNode,
  type DiagramEdge,
  type DiagramData,
  type DiagramType,
  type LegacyDiagramType,
  type FileTypeInfo,
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
import {
  humanizeFieldLabel,
  assignFunctionKeyLabels,
  extractClDriverTitle,
  resolveHeaderValue,
  generateFieldLegend,
  type HeaderContext,
} from './dspf-enhancements.js';

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
      'Modern (TS/JS/Python/Java/Go): call-graph, dependency, structure, class.',
      'Use type "auto" to select the best diagram from code context, or "available" to list diagram types for a file.',
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
          'Diagram type (or "auto" to infer / "available" to list). Legacy: call_graph, dependency_map, structure_chart, procedure_flow, control_flow, field_hierarchy, file_io, copybook_tree, record_layout, screen_layout. Modern: call-graph, dependency, structure, class.',
        required: true,
      },
      {
        name: 'section_id',
        type: 'number',
        description:
          'For control_flow: index of the section/paragraph to diagram (0-based). Defaults to 0.',
        required: false,
      },
      {
        name: 'direction',
        type: 'string',
        description:
          'Override Mermaid graph direction. One of: TD (top-down), LR (left-right), RL (right-left), BT (bottom-top). Defaults to type-appropriate direction.',
        required: false,
      },
    ],
    async execute(params: Record<string, unknown>): Promise<ToolResult> {
      const filePath = params.path as string;
      let diagramType = params.type as string;
      const sectionId = params.section_id as number | undefined;
      const direction = params.direction as string | undefined;

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

      // ── "auto" meta-command ───────────────────────────────
      if (diagramType === 'auto') {
        diagramType = inferAutoDiagramType(fullPath, stat, workspaceRoot);
      }

      // ── Single file → check if legacy ─────────────────────
      if (!stat.isDirectory()) {
        const ext = path.extname(fullPath).slice(1).toLowerCase();
        if (ALL_LEGACY_EXTS.has(ext)) {
          return generateLegacyDiagram(
            fullPath,
            diagramType as LegacyDiagramType,
            workspaceRoot,
            sectionId,
            direction,
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
          direction,
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

const MODERN_EXTS = new Set(['ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs', 'py', 'java', 'go']);

function inferAutoDiagramType(fullPath: string, stat: fs.Stats, _root: string): string {
  if (stat.isDirectory()) {
    const files: string[] = [];
    collectFiles(fullPath, files, 2);
    const legacyCount = files.filter((f) => {
      const e = path.extname(f).slice(1).toLowerCase();
      return ALL_LEGACY_EXTS.has(e);
    }).length;
    // For legacy-heavy folders, dependency map tends to be the most informative first view.
    return legacyCount > 0 && legacyCount >= files.length * 0.5 ? 'dependency_map' : 'structure';
  }

  const ext = path.extname(fullPath).slice(1).toLowerCase();
  const info = classifyExtension(ext);
  if (info) {
    const candidates = DIAGRAM_TYPES[info.category] ?? [];
    const available = getActuallyAvailableDiagrams(fullPath, info, candidates);
    if (available.length === 0) return candidates[0] ?? 'dependency_map';

    const priorities: Record<string, string[]> = {
      program: [
        'control_flow',
        'procedure_flow',
        'call_graph',
        'dependency_map',
        'file_io',
        'field_hierarchy',
        'structure_chart',
        'copybook_tree',
      ],
      copybook: ['record_layout', 'field_hierarchy', 'dependency_map', 'copybook_tree'],
      screen: ['screen_layout', 'dependency_map', 'copybook_tree'],
      dds: ['record_layout', 'field_hierarchy'],
      jcl: ['dependency_map'],
      other: ['dependency_map', 'copybook_tree'],
    };
    const order = priorities[info.category] ?? candidates;
    for (const t of order) {
      if (available.includes(t)) return t;
    }
    return available[0];
  }

  if (MODERN_EXTS.has(ext)) {
    const content = safeReadFile(fullPath) ?? '';
    return inferModernTypeFromContent(content);
  }

  return 'structure';
}

function inferModernTypeFromContent(content: string): string {
  const hasClass = /\b(class|interface|extends|implements)\b/.test(content);
  if (hasClass) return 'class';

  const hasImports =
    /\bimport\s+.+\s+from\s+['"][^'"]+['"]/.test(content) ||
    /\brequire\s*\(\s*['"][^'"]+['"]\s*\)/.test(content) ||
    /\bfrom\s+[a-zA-Z0-9_.]+\s+import\s+/.test(content);
  if (hasImports) return 'dependency';

  const hasFunctions =
    /\bfunction\s+\w+/.test(content) ||
    /\bdef\s+\w+\s*\(/.test(content) ||
    /\bfunc\s+\w+\s*\(/.test(content);
  if (hasFunctions) return 'call-graph';

  return 'structure';
}

function inferLegacyTypeFromContent(info: FileTypeInfo, content: string): LegacyDiagramType {
  const upper = content.toUpperCase();

  if (info.category === 'screen') {
    return 'screen_layout';
  }
  if (info.category === 'dds' || info.category === 'copybook') {
    if (/^\s*\d{2}\s+\w/m.test(content)) return 'field_hierarchy';
    return 'record_layout';
  }

  // program category
  if (upper.includes('PROCEDURE DIVISION') || /^\s*PGM\b/im.test(content)) {
    return 'control_flow';
  }
  if (/CALL\s+['"]?\w/i.test(content) || /EXEC\s+CICS\s+(LINK|XCTL)/i.test(content)) {
    return 'call_graph';
  }
  if (/COPY\s+\w/i.test(content) || /\/COPY\s/i.test(content) || /%INCLUDE\s/i.test(content)) {
    return 'dependency_map';
  }
  if (upper.includes('SELECT') && upper.includes('ASSIGN')) {
    return 'file_io';
  }
  if (/^\s*\d{2}\s+\w/m.test(content)) {
    return 'field_hierarchy';
  }
  return 'structure_chart';
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
  const hasProcDiv = upper.includes('PROCEDURE DIVISION');

  for (const dtype of candidateTypes) {
    switch (dtype) {
      case 'call_graph':
        if (
          /CALL\s+['"]?\w/i.test(content) ||
          /EXEC\s+CICS\s+(LINK|XCTL)/i.test(content) ||
          /CALLP?\s+\w+\s*\(/i.test(content) ||
          /(?:dcl-proc\s+\w+|end-proc)/i.test(content)
        ) {
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
        if (!hasProcDiv) break;
        const paraCount = (content.match(/^.{6}\s{1,4}[A-Za-z0-9][\w-]+\s*\./gm) ?? []).length;
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
      case 'usage_map':
        if (
          /CALL\s+['"]?\w/i.test(content) ||
          /COPY\s+\w/i.test(content) ||
          (upper.includes('SELECT') && upper.includes('ASSIGN'))
        ) {
          available.push(dtype);
        }
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
  direction?: string,
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
    // Allow screen_layout for .dds files that are actually display files (detected by content)
    const isDdsDisplayFile =
      info.category === 'dds' &&
      diagramType === 'screen_layout' &&
      /DSPSIZ|WORKSTN|CF\d+\(/i.test(content);
    if (!isDdsDisplayFile) {
      return {
        success: false,
        content: `Error: diagram type "${diagramType}" not available for ${info.category} files (.${ext}). Available: ${validTypes.join(', ')}`,
      };
    }
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
    const hint = getDiagramRequirementHint(diagramType);
    return {
      success: false,
      content: `No data found for diagram type "${diagramType}" in this file.${hint}`,
    };
  }

  // Enrich dependency_map / copybook_tree with inbound references from workspace
  if (
    (diagramType === 'dependency_map' || diagramType === 'copybook_tree') &&
    data.nodes.length > 0
  ) {
    enrichWithInboundRefs(data, fullPath, root);
  }

  // Enrich usage_map with reverse references ("who uses me") from workspace
  if (diagramType === 'usage_map' && data.nodes.length > 0) {
    enrichUsageMapWithReverse(data, fullPath, root);
  }

  // For screen_layout, render ASCII art instead of Mermaid
  if (diagramType === 'screen_layout' && data.screen) {
    const ascii = screenLayoutToAscii(data, fullPath);
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
        screenFields: data.nodes,
        fieldCount: data.nodes.length,
      },
    };
  }

  // Collapse large procedure_flow diagrams (>100 nodes)
  if (diagramType === 'procedure_flow' && data.nodes.length > 100) {
    data = collapseProcedureFlow(data);
  }

  // Convert to Mermaid
  const mermaid = diagramDataToMermaid(diagramType, data, direction);
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
    case 'usage_map':
      return generateUsageMap(program.programId || path.basename(filePath), content);
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
    const isSection = !('performedBy' in item);
    nodes.push({
      id: `p${i}`,
      label: item.name,
      type: isSection ? 'section' : 'paragraph',
      startLine: item.line,
      endLine: item.endLine,
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
    // Compute endLine if needed
    let endLine = item.endLine;
    if (!endLine || endLine <= item.line) {
      endLine = i + 1 < allItems.length ? allItems[i + 1].line - 1 : item.line + 50;
    }
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

  // Add PERFORM and GO TO edges from flowReferences (two-pass resolved)
  const seenEdges = new Set<string>();
  for (const ref of program.flowReferences) {
    const targetNid = nameToNid[ref.target];
    if (!targetNid) continue;

    // Find source by line containment
    let sourceNid: string | null = null;
    for (let i = 0; i < allItems.length; i++) {
      const item = allItems[i];
      const itemEnd =
        item.endLine || (i + 1 < allItems.length ? allItems[i + 1].line - 1 : Infinity);
      if (ref.line >= item.line && ref.line <= itemEnd) {
        sourceNid = `p${i}`;
        break;
      }
    }
    if (!sourceNid || sourceNid === targetNid) continue;

    const edgeLabel = ref.refType === 'perform' ? 'PERFORM' : 'GO TO';
    const key = `${sourceNid}->${targetNid}:${ref.refType}`;
    if (!seenEdges.has(key)) {
      seenEdges.add(key);
      edges.push({
        source: sourceNid,
        target: targetNid,
        label: edgeLabel,
        edgeType: ref.refType === 'goto' ? 'goto' : 'perform',
      });
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
    ...program.sections.map((s) => ({ ...s, itemType: 'section' as const })),
    ...program.paragraphs.map((p) => ({ ...p, itemType: 'paragraph' as const })),
  ].sort((a, b) => a.line - b.line);

  if (procItems.length === 0) return null;

  // Compute endLine for items that may not have it set correctly
  const allLines = content.split('\n');
  for (let i = 0; i < procItems.length; i++) {
    if (!procItems[i].endLine || procItems[i].endLine <= procItems[i].line) {
      procItems[i].endLine = i + 1 < procItems.length ? procItems[i + 1].line - 1 : allLines.length;
    }
  }

  const targetIdx =
    sectionId !== undefined && sectionId >= 0 && sectionId < procItems.length ? sectionId : 0;
  const sec = procItems[targetIdx];

  const startLine = Math.max(0, sec.line - 1);
  const endLine = Math.min(allLines.length, sec.endLine);
  const rawLines = allLines.slice(startLine, endLine);

  // Strip COBOL sequence numbers and comments
  // Columns 1-6: sequence area, Col 7: indicator, Col 8-72: code, Col 73-80: identification area
  const hasRightSeq = rawLines.some(
    (l) => l.length > 72 && /^\d{6,8}$/.test(l.substring(72).trim()),
  );
  const stripped: string[] = [];
  for (const line of rawLines) {
    const text = line.length > 6 ? line.substring(6) : line;
    const indicator = text.length > 0 ? text[0] : ' ';
    if (indicator === '*' || indicator === '/' || !text.substring(1).trim()) {
      stripped.push('');
    } else {
      // Strip right-side sequence numbers (cols 73-80) if present
      let code = text.substring(1);
      if (hasRightSeq && line.length > 72) {
        code = line.substring(7, 72);
      }
      stripped.push(code.trim());
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
    // Strip columns 1-6 (sequence) and 73-80 (identification) for proper COBOL code area
    const raw = lines[i];
    const lineText =
      raw.length >= 72
        ? raw.substring(7, 72).trim()
        : raw.length > 6
          ? raw.substring(7).trim()
          : raw.trim();
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
    case 'usage_map':
      return generateUsageMap(
        path.basename(filePath, path.extname(filePath)).toUpperCase(),
        content,
      );
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
  _sectionId?: number,
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
  _info: FileTypeInfo,
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
    case 'usage_map':
      return generateUsageMap(
        path.basename(filePath, path.extname(filePath)).toUpperCase(),
        content,
      );
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

  // Extract CALLP, CALL, and bare procedure calls from RPG ILE free format
  // Matches: CALLP proc(...), CALL proc(...), or just proc(...)
  const callRegex = /(?:CALLP?\s+)?(?<![a-zA-Z0-9_-])([a-zA-Z_][a-zA-Z0-9_]*)\s*\(/gi;
  const lines = content.split('\n');
  const seen = new Set<string>();

  for (let i = 0; i < lines.length; i++) {
    callRegex.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = callRegex.exec(lines[i])) !== null) {
      const target = m[1].toUpperCase();
      // Skip language keywords and control structures
      if (
        [
          'IF',
          'FOR',
          'DOW',
          'DOU',
          'WHEN',
          'EVAL',
          'RETURN',
          'NOT',
          'AND',
          'OR',
          'SELECT',
          'CASE',
        ].includes(target)
      )
        continue;
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
  _info: FileTypeInfo,
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
    case 'usage_map':
      return generateUsageMap(
        path.basename(filePath, path.extname(filePath)).toUpperCase(),
        content,
      );
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

function diagramDataToMermaid(diagramType: string, data: DiagramData, direction?: string): string {
  // For control_flow, use the nested data
  const nodes = data.data?.nodes ?? data.nodes;
  const edges = data.data?.edges ?? data.edges;

  if (!nodes || nodes.length === 0) return '```mermaid\ngraph TD\n  empty["No data"]\n```';

  // Direction: user override > type-based default
  const VALID_DIRECTIONS = new Set(['TD', 'TB', 'LR', 'RL', 'BT']);
  let dirCode: string;
  if (direction && VALID_DIRECTIONS.has(direction.toUpperCase())) {
    dirCode = direction.toUpperCase();
  } else {
    const horizontalTypes = new Set([
      'file_io',
      'dependency_map',
      'copybook_tree',
      'call_graph',
      'usage_map',
    ]);
    dirCode = horizontalTypes.has(diagramType) ? 'LR' : 'TD';
  }

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

  // classDef for distinct node-type colors
  lines.push('');
  lines.push('    classDef decision fill:#4d3d15,color:#dcdcaa,stroke:#ce9178,stroke-width:2px');
  lines.push('    classDef callNode fill:#1e3a2e,color:#89d185,stroke:#6a9955,stroke-width:2px');
  lines.push('    classDef sectionNode fill:#2d1f54,color:#c586c0,stroke:#9b59b6,stroke-width:2px');
  lines.push(
    '    classDef paragraphNode fill:#1e3040,color:#9cdcfe,stroke:#569cd6,stroke-width:1px',
  );
  lines.push('    classDef ioNode fill:#3d2a1e,color:#ce9178,stroke:#d7956a,stroke-width:2px');
  lines.push(
    '    classDef terminalNode fill:#2d2d2d,color:#d4d4d4,stroke:#808080,stroke-width:2px',
  );
  lines.push('    classDef gotoNode fill:#4a1e1e,color:#f48771,stroke:#f14c4c,stroke-width:2px');
  lines.push('    classDef loopNode fill:#1e3a3a,color:#4ec9b0,stroke:#3fb5a0,stroke-width:2px');
  lines.push('    classDef fieldNode fill:#3d3415,color:#dcdcaa,stroke:#d7ba7d,stroke-width:1px');
  lines.push('    classDef groupNode fill:#264f78,color:#e0e0e0,stroke:#3794ff,stroke-width:1px');

  // Assign classes to nodes by type
  const typeToClass: Record<string, string> = {
    decision: 'decision',
    call: 'callNode',
    copybook: 'callNode',
    include: 'callNode',
    section: 'sectionNode',
    paragraph: 'paragraphNode',
    subroutine: 'paragraphNode',
    procedure: 'paragraphNode',
    io: 'ioNode',
    file: 'ioNode',
    terminal: 'terminalNode',
    merge: 'terminalNode',
    goto: 'gotoNode',
    loop: 'loopNode',
    field: 'fieldNode',
    group: 'groupNode',
    record: 'groupNode',
  };
  const classAssignments = new Map<string, string[]>();
  for (const n of nodes) {
    const cls = typeToClass[n.type ?? ''];
    if (cls) {
      if (!classAssignments.has(cls)) classAssignments.set(cls, []);
      classAssignments.get(cls)!.push(sanitizeMermaidId(n.id));
    }
  }
  for (const [cls, ids] of classAssignments) {
    lines.push(`    class ${ids.join(',')} ${cls}`);
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
  if (type === 'auto') {
    const firstFile = files[0];
    const firstContent = firstFile ? fs.readFileSync(firstFile, 'utf-8') : '';
    type = inferModernTypeFromContent(firstContent);
  }
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

function generateClassDiagram(files: string[], _root: string): string {
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
    case 'usage_map':
      return generateUsageMap(
        path.basename(fullPath, path.extname(fullPath)).toUpperCase(),
        content,
      );
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
    case 'usage_map':
      return generateUsageMap(
        path.basename(fullPath, path.extname(fullPath)).toUpperCase(),
        content,
      );
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
 * Enhanced with: label humanization, function key assignment, header value
 * resolution, CL driver title extraction, and field legend table.
 */
function screenLayoutToAscii(data: DiagramData, filePath?: string): string {
  const screen = data.screen;
  const rows = screen?.rows ?? 24;
  const cols = screen?.cols ?? 80;
  let title = screen?.title ?? '';
  let funcKeys = screen?.funcKeys ?? [];
  let screenTran = '';

  // CL driver title extraction (if we have a file path)
  if (filePath) {
    const driverInfo = extractClDriverTitle(filePath);
    if (driverInfo) {
      if (driverInfo.screenDesc) title = driverInfo.screenDesc;
      if (driverInfo.screenTran) screenTran = driverInfo.screenTran;
    }
  }

  // Header context for value resolution
  const headerCtx: HeaderContext = {
    screenTitle: title,
    screenTran,
    programName: screen?.title ?? '',
  };

  // Function key assignment from fields
  const fKeyFields = assignFunctionKeyLabels(
    data.nodes
      .filter((n) => n.row && n.col)
      .map((n) => ({
        fieldName: n.label || '',
        alias: n.alias,
        displayLabel: n.displayLabel,
        row: n.row!,
        col: n.col!,
        type: n.type ?? '',
      })),
  );
  if (fKeyFields.length > 0) {
    funcKeys = fKeyFields.map((f) => f.label);
  }

  // Create buffer (rows+1 x cols+1, 1-indexed)
  const buf: string[][] = Array.from({ length: rows + 1 }, () => Array(cols + 1).fill(' '));

  for (const n of data.nodes) {
    const r = n.row;
    const c = n.col;
    const length = n.length;
    const ntype = n.type ?? '';

    if (!r || r < 1 || r > rows || !c || c < 1) continue;

    // Humanize the display label
    let displayText: string;
    if (ntype === 'input') {
      displayText = '_'.repeat(Math.max(length ?? 1, 1));
    } else {
      // INITIAL value takes priority (explicit content from source)
      if (n.initial && n.initial.trim()) {
        displayText = n.initial;
      } else {
        // Try header value resolution for output fields without INITIAL
        const headerVal = resolveHeaderValue(n.label || n.alias || '', headerCtx);
        if (headerVal !== null) {
          displayText = headerVal;
        } else if (n.displayLabel && n.displayLabel.trim()) {
          displayText = humanizeFieldLabel(n.label || '', n.alias, n.displayLabel);
        } else {
          // Skip fields with no display content
          continue;
        }
      }
    }

    if (length && length > 0) {
      displayText = displayText.slice(0, length);
    }

    for (let i = 0; i < displayText.length; i++) {
      const pos = c + i;
      if (pos >= 1 && pos <= cols) {
        buf[r][pos] = displayText[i];
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
    const tranPart = screenTran ? ` (${screenTran})` : '';
    out.push(`  Screen: ${title}${tranPart}`);
  }
  if (funcKeys.length > 0) {
    out.push(`  Keys: ${funcKeys.join('  ')}`);
  }

  // Field legend table
  const legendFields = data.nodes
    .filter((n) => n.row && n.col && n.label)
    .map((n) => ({
      fieldName: n.label || '',
      displayLabel: humanizeFieldLabel(n.label || '', n.alias, n.displayLabel),
      type: n.type ?? '',
      row: n.row!,
      col: n.col!,
      length: n.length ?? 1,
      usage: n.usage,
      alias: n.alias,
    }));
  const legend = generateFieldLegend(legendFields);
  if (legend) {
    out.push(legend);
  }

  return out.join('\n');
}

// ══════════════════════════════════════════════════════════════
//  Collapsed Procedure Flow (>100 nodes)
// ══════════════════════════════════════════════════════════════

/**
 * Collapse a large procedure_flow diagram by grouping paragraphs into
 * their parent sections. Produces a section-level summary diagram where
 * each node shows the aggregated paragraph count.
 *
 * Algorithm:
 * 1. Identify section nodes vs paragraph nodes
 * 2. Group paragraphs under their nearest preceding section
 * 3. Orphan paragraphs go under a synthetic "MAIN" section
 * 4. Preserve cross-section PERFORM edges
 * 5. If collapse yields < 5 sections with one >100 paras, sub-group by prefix
 */
function collapseProcedureFlow(data: DiagramData): DiagramData {
  const nodes = data.nodes;
  const edges = data.edges;

  // Separate sections and paragraphs
  const sections: DiagramNode[] = [];
  const paragraphs: DiagramNode[] = [];
  for (const n of nodes) {
    if (n.type === 'section' || n.level === 1) {
      sections.push(n);
    } else {
      paragraphs.push(n);
    }
  }

  // If no section structure, group by prefix
  if (sections.length === 0) {
    return collapseProcedureFlowByPrefix(data);
  }

  // Assign paragraphs to sections by source order
  const sectionGroups = new Map<string, DiagramNode[]>();
  let currentSection: DiagramNode | null = null;
  const sortedAll = [...sections, ...paragraphs].sort(
    (a, b) => (a.startLine ?? 0) - (b.startLine ?? 0),
  );

  for (const node of sortedAll) {
    if (node.type === 'section' || node.level === 1) {
      currentSection = node;
      if (!sectionGroups.has(node.id)) {
        sectionGroups.set(node.id, []);
      }
    } else if (currentSection) {
      sectionGroups.get(currentSection.id)!.push(node);
    } else {
      // Orphan — assign to MAIN
      if (!sectionGroups.has('__main__')) sectionGroups.set('__main__', []);
      sectionGroups.get('__main__')!.push(node);
    }
  }

  // Build collapsed nodes
  const collapsedNodes: DiagramNode[] = [];
  const oldToNew = new Map<string, string>();

  if (sectionGroups.has('__main__')) {
    const orphans = sectionGroups.get('__main__')!;
    const mainId = 'collapsed_main';
    collapsedNodes.push({
      id: mainId,
      label: `MAIN (${orphans.length} para)`,
      type: 'section',
      startLine: 0,
      level: 1,
      lineCount: orphans.reduce((s, p) => s + (p.lineCount ?? 1), 0),
    });
    for (const p of orphans) oldToNew.set(p.id, mainId);
  }

  for (const sec of sections) {
    const paras = sectionGroups.get(sec.id) ?? [];
    const collapsedId = `collapsed_${sanitizeId(sec.label)}`;
    collapsedNodes.push({
      id: collapsedId,
      label: `${sec.label} (${paras.length} para)`,
      type: 'section',
      startLine: sec.startLine,
      level: 1,
      lineCount: paras.reduce((s, p) => s + (p.lineCount ?? 1), 0) + (sec.lineCount ?? 1),
    });
    oldToNew.set(sec.id, collapsedId);
    for (const p of paras) oldToNew.set(p.id, collapsedId);
  }

  // Build collapsed edges (cross-section PERFORMs only)
  const collapsedEdges: DiagramEdge[] = [];
  const seenEdges = new Set<string>();

  for (const e of edges) {
    const newSrc = oldToNew.get(e.source) ?? e.source;
    const newTgt = oldToNew.get(e.target) ?? e.target;
    if (newSrc === newTgt) continue; // Intra-section — skip
    if (e.edgeType === 'fallthrough') continue; // Skip fallthroughs between sections

    const key = `${newSrc}->${newTgt}`;
    if (seenEdges.has(key)) continue;
    seenEdges.add(key);

    collapsedEdges.push({
      source: newSrc,
      target: newTgt,
      label: e.label || 'PERFORM',
      edgeType: 'perform',
    });
  }

  // Add section-order fallthrough
  for (let i = 0; i < collapsedNodes.length - 1; i++) {
    const key = `${collapsedNodes[i].id}->${collapsedNodes[i + 1].id}`;
    if (!seenEdges.has(key)) {
      collapsedEdges.push({
        source: collapsedNodes[i].id,
        target: collapsedNodes[i + 1].id,
        edgeType: 'fallthrough',
      });
    }
  }

  // Sub-group check: if one section holds >100 paragraphs and < 5 total sections
  if (collapsedNodes.length < 5) {
    const largeSection = collapsedNodes.find(
      (n) => (sectionGroups.get(n.id.replace('collapsed_', '')) ?? []).length > 100,
    );
    if (largeSection) {
      // Already collapsed enough — the section label shows the count
      // No further sub-grouping needed for Mermaid readability
    }
  }

  return { nodes: collapsedNodes, edges: collapsedEdges };
}

/**
 * Fallback collapse: group paragraphs by first letter prefix when
 * no COBOL sections exist.
 */
function collapseProcedureFlowByPrefix(data: DiagramData): DiagramData {
  const nodes = data.nodes;
  const edges = data.edges;

  // Group by first character/number prefix pattern
  const prefixGroups = new Map<string, DiagramNode[]>();
  for (const n of nodes) {
    // Extract prefix: first 4 chars of paragraph name (common: 0000-, 1000-, A100-, etc.)
    const prefix = (n.label || '').slice(0, 4).replace(/[-_]$/, '');
    const groupKey = prefix || 'OTHER';
    if (!prefixGroups.has(groupKey)) prefixGroups.set(groupKey, []);
    prefixGroups.get(groupKey)!.push(n);
  }

  // If too many groups, use first 2 chars
  if (prefixGroups.size > 20) {
    prefixGroups.clear();
    for (const n of nodes) {
      const prefix = (n.label || '').slice(0, 2) || 'XX';
      if (!prefixGroups.has(prefix)) prefixGroups.set(prefix, []);
      prefixGroups.get(prefix)!.push(n);
    }
  }

  const collapsedNodes: DiagramNode[] = [];
  const oldToNew = new Map<string, string>();

  for (const [prefix, paras] of prefixGroups) {
    const collapsedId = `grp_${sanitizeId(prefix)}`;
    collapsedNodes.push({
      id: collapsedId,
      label: `${prefix}... (${paras.length} para)`,
      type: 'section',
      startLine: paras[0]?.startLine ?? 0,
      level: 1,
    });
    for (const p of paras) oldToNew.set(p.id, collapsedId);
  }

  // Cross-group edges
  const collapsedEdges: DiagramEdge[] = [];
  const seenEdges = new Set<string>();
  for (const e of edges) {
    if (e.edgeType === 'fallthrough') continue;
    const newSrc = oldToNew.get(e.source) ?? e.source;
    const newTgt = oldToNew.get(e.target) ?? e.target;
    if (newSrc === newTgt) continue;
    const key = `${newSrc}->${newTgt}`;
    if (seenEdges.has(key)) continue;
    seenEdges.add(key);
    collapsedEdges.push({ source: newSrc, target: newTgt, label: 'PERFORM', edgeType: 'perform' });
  }

  return { nodes: collapsedNodes, edges: collapsedEdges };
}

// ══════════════════════════════════════════════════════════════
//  Inbound Reference Enrichment (workspace scanning)
// ══════════════════════════════════════════════════════════════

/**
 * Scan workspace source files for COPY/INCLUDE/CALL references to the current file.
 * Adds inbound "user" nodes and edges to an existing dependency_map/copybook_tree.
 *
 * Enhanced: scans up to 3 directory levels and 500 files for broader coverage.
 */
function enrichWithInboundRefs(data: DiagramData, fullPath: string, root: string): void {
  const baseName = path.basename(fullPath, path.extname(fullPath)).toUpperCase();
  const parentDir = path.dirname(fullPath);
  const grandParentDir = path.dirname(parentDir);
  const greatGrandParent = path.dirname(grandParentDir);

  // Collect candidate directories to scan (up to 3 levels for broader workspace coverage)
  const scanDirs = [parentDir];
  if (grandParentDir !== parentDir && grandParentDir.startsWith(root)) {
    scanDirs.push(grandParentDir);
  }
  if (
    greatGrandParent !== grandParentDir &&
    greatGrandParent !== parentDir &&
    greatGrandParent.startsWith(root)
  ) {
    scanDirs.push(greatGrandParent);
  }

  const copyPattern = new RegExp(
    `(?:COPY|/COPY|%INCLUDE|CALL\\s+['"]?)${escapeRegExp(baseName)}\\b`,
    'i',
  );

  const sourceId = data.nodes[0]?.id;
  if (!sourceId) return;

  const seenUsers = new Set<string>();
  const maxScan = 500; // Extended from 200 for broader coverage
  let scanned = 0;

  for (const dir of scanDirs) {
    if (scanned >= maxScan) break;
    scanDirectoryForRefs(
      dir,
      fullPath,
      copyPattern,
      data,
      sourceId,
      seenUsers,
      maxScan,
      scanned,
      (count) => {
        scanned = count;
      },
      2,
      root,
    );
  }
}

/**
 * Recursively scan a directory for inbound references.
 */
function scanDirectoryForRefs(
  dir: string,
  selfPath: string,
  pattern: RegExp,
  data: DiagramData,
  sourceId: string,
  seenUsers: Set<string>,
  maxScan: number,
  currentCount: number,
  setCount: (n: number) => void,
  depthRemaining: number,
  root?: string,
): void {
  if (currentCount >= maxScan || depthRemaining < 0) return;

  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    if (currentCount >= maxScan) break;
    const entryPath = path.join(dir, entry.name);

    if (entry.isDirectory()) {
      if (['node_modules', '.git', 'dist', '.OpenCob'].includes(entry.name)) continue;
      if (depthRemaining > 0) {
        scanDirectoryForRefs(
          entryPath,
          selfPath,
          pattern,
          data,
          sourceId,
          seenUsers,
          maxScan,
          currentCount,
          setCount,
          depthRemaining - 1,
          root,
        );
      }
      continue;
    }

    // Skip self
    if (entryPath === selfPath) continue;

    // Only check legacy source files
    const entryExt = path.extname(entry.name).slice(1).toLowerCase();
    if (!ALL_LEGACY_EXTS.has(entryExt)) continue;

    currentCount++;
    setCount(currentCount);

    const entryContent = safeReadFile(entryPath);
    if (!entryContent) continue;

    if (pattern.test(entryContent)) {
      const userName = path.basename(entry.name, path.extname(entry.name)).toUpperCase();
      const nid = `usr_${sanitizeId(userName)}`;
      if (seenUsers.has(nid)) continue;
      seenUsers.add(nid);

      const fileId = root ? path.relative(root, entryPath).replace(/\\/g, '/') : undefined;
      data.nodes.push({ id: nid, label: userName, type: 'user', fileId });
      data.edges.push({
        source: nid,
        target: sourceId,
        label: 'COPIES',
        edgeType: 'inbound',
      });
    }
  }
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// ══════════════════════════════════════════════════════════════
//  Reverse Usage Map — "who calls/copies me" from workspace
// ══════════════════════════════════════════════════════════════

/**
 * Enrich a usage_map diagram with reverse references: files that CALL or COPY
 * the current file. Scans the workspace directory tree.
 */
function enrichUsageMapWithReverse(data: DiagramData, fullPath: string, root: string): void {
  const baseName = path.basename(fullPath, path.extname(fullPath)).toUpperCase();
  const parentDir = path.dirname(fullPath);
  const grandParentDir = path.dirname(parentDir);

  const scanDirs = [parentDir];
  if (grandParentDir !== parentDir && grandParentDir.startsWith(root)) {
    scanDirs.push(grandParentDir);
  }

  // Pattern: CALL 'BASENAME' or COPY BASENAME or /COPY BASENAME
  const refPattern = new RegExp(
    `(?:CALL\\s+['"]?${escapeRegExp(baseName)}|COPY\\s+${escapeRegExp(baseName)}|/COPY\\s+${escapeRegExp(baseName)}|%INCLUDE\\s+${escapeRegExp(baseName)}|CALL\\s+PGM\\(\\s*(?:\\w+/)?${escapeRegExp(baseName)})\\b`,
    'i',
  );

  const sourceId = data.nodes[0]?.id;
  if (!sourceId) return;

  const seenUsers = new Set<string>();
  const maxScan = 500;
  let scanned = 0;

  for (const dir of scanDirs) {
    if (scanned >= maxScan) break;
    scanDirectoryForUsageRefs(
      dir,
      fullPath,
      refPattern,
      data,
      sourceId,
      seenUsers,
      maxScan,
      scanned,
      (count) => {
        scanned = count;
      },
      2,
      root,
    );
  }
}

/**
 * Scan directory for files that reference the target (reverse usage_map).
 */
function scanDirectoryForUsageRefs(
  dir: string,
  selfPath: string,
  pattern: RegExp,
  data: DiagramData,
  sourceId: string,
  seenUsers: Set<string>,
  maxScan: number,
  currentCount: number,
  setCount: (n: number) => void,
  depthRemaining: number,
  root?: string,
): void {
  if (currentCount >= maxScan || depthRemaining < 0) return;

  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    if (currentCount >= maxScan) break;
    const entryPath = path.join(dir, entry.name);

    if (entry.isDirectory()) {
      if (['node_modules', '.git', 'dist', '.OpenCob'].includes(entry.name)) continue;
      if (depthRemaining > 0) {
        scanDirectoryForUsageRefs(
          entryPath,
          selfPath,
          pattern,
          data,
          sourceId,
          seenUsers,
          maxScan,
          currentCount,
          setCount,
          depthRemaining - 1,
          root,
        );
      }
      continue;
    }

    if (entryPath === selfPath) continue;

    const entryExt = path.extname(entry.name).slice(1).toLowerCase();
    if (!ALL_LEGACY_EXTS.has(entryExt)) continue;

    currentCount++;
    setCount(currentCount);

    const entryContent = safeReadFile(entryPath);
    if (!entryContent) continue;

    if (pattern.test(entryContent)) {
      const userName = path.basename(entry.name, path.extname(entry.name)).toUpperCase();
      const nid = `in_${sanitizeId(userName)}`;
      if (seenUsers.has(nid)) continue;
      seenUsers.add(nid);

      // Determine ref type
      const upper = entryContent.toUpperCase();
      const baseName = path.basename(selfPath, path.extname(selfPath)).toUpperCase();
      let refType = 'USES';
      if (new RegExp(`CALL\\s+['"]?${escapeRegExp(baseName)}`, 'i').test(upper)) refType = 'CALLS';
      else if (new RegExp(`COPY\\s+${escapeRegExp(baseName)}`, 'i').test(upper)) refType = 'COPIES';

      const fileId = root ? path.relative(root, entryPath).replace(/\\/g, '/') : undefined;
      data.nodes.push({ id: nid, label: userName, type: 'caller', fileId });
      data.edges.push({
        source: nid,
        target: sourceId,
        label: refType,
        edgeType: 'inbound',
      });
    }
  }
}

// ══════════════════════════════════════════════════════════════
//  Usage Map — "who uses me" via workspace-level scanning
// ══════════════════════════════════════════════════════════════

/**
 * Generate a usage_map diagram showing what the file exposes for external use
 * and what it depends on. For single-file context this shows:
 * - Outgoing calls (who I call)
 * - Outgoing copies (what I include)
 * - Exposed identifiers (program-id, exported sections)
 *
 * Full cross-file usage requires workspace indexing; this provides
 * a self-contained single-file perspective.
 */
function generateUsageMap(programName: string, content: string): DiagramData | null {
  const nodes: DiagramNode[] = [];
  const edges: DiagramEdge[] = [];
  const sourceId = `src_${sanitizeId(programName)}`;
  nodes.push({ id: sourceId, label: programName, type: 'target', startLine: 0 });

  // Outgoing CALLs — programs this file invokes
  const callMatches = content.matchAll(/CALL\s+['"]?(\w+)/gi);
  const seenCalls = new Set<string>();
  for (const m of callMatches) {
    const target = m[1].toUpperCase();
    if (seenCalls.has(target)) continue;
    seenCalls.add(target);
    const nid = `out_call_${sanitizeId(target)}`;
    nodes.push({ id: nid, label: target, type: 'call' });
    edges.push({ source: sourceId, target: nid, label: 'CALLS', edgeType: 'call' });
  }

  // CL CALL PGM
  const clCallMatches = content.matchAll(/CALL\s+PGM\(\s*(?:[\w*/]+\/)?\s*(\w+)/gi);
  for (const m of clCallMatches) {
    const target = m[1].toUpperCase();
    if (seenCalls.has(target)) continue;
    seenCalls.add(target);
    const nid = `out_call_${sanitizeId(target)}`;
    nodes.push({ id: nid, label: target, type: 'call' });
    edges.push({ source: sourceId, target: nid, label: 'CALLS', edgeType: 'call' });
  }

  // EXEC CICS LINK/XCTL
  const cicsMatches = content.matchAll(/EXEC\s+CICS\s+(LINK|XCTL)\s+PROGRAM\s*\(\s*['"]?(\w+)/gi);
  for (const m of cicsMatches) {
    const target = m[2].toUpperCase();
    if (seenCalls.has(target)) continue;
    seenCalls.add(target);
    const nid = `out_cics_${sanitizeId(target)}`;
    nodes.push({ id: nid, label: target, type: 'call' });
    edges.push({ source: sourceId, target: nid, label: `CICS ${m[1]}`, edgeType: 'call' });
  }

  // Outgoing COPYs — copybooks this file includes
  const copyMatches = content.matchAll(/(?:COPY|\/COPY|%INCLUDE)\s+(\w+)/gi);
  const seenCopies = new Set<string>();
  for (const m of copyMatches) {
    const target = m[1].toUpperCase();
    if (seenCopies.has(target)) continue;
    seenCopies.add(target);
    const nid = `out_copy_${sanitizeId(target)}`;
    nodes.push({ id: nid, label: target, type: 'copybook' });
    edges.push({ source: sourceId, target: nid, label: 'COPIES', edgeType: 'copy' });
  }

  // File I/O targets
  const selectMatches = content.matchAll(/SELECT\s+(\S+)\s+ASSIGN/gi);
  for (const m of selectMatches) {
    const target = m[1].toUpperCase();
    const nid = `out_file_${sanitizeId(target)}`;
    nodes.push({ id: nid, label: target, type: 'file' });
    edges.push({ source: sourceId, target: nid, label: 'FILE I/O', edgeType: 'file' });
  }

  if (nodes.length <= 1) return null;
  return { nodes, edges };
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
  direction?: string,
): { success: boolean; content: string; metadata?: Record<string, unknown> } {
  const ext = extension.replace(/^\./, '').toLowerCase();
  const requestedType = String(diagramType);

  // Check cache first
  const cached = diagramCache.get(content, requestedType, sectionId, direction);
  if (cached) {
    return { success: true, content: cached.content, metadata: cached.metadata };
  }

  const info = classifyExtension(ext);
  if (!info && !MODERN_EXTS.has(ext)) {
    return { success: false, content: `Error: unrecognized extension .${ext}` };
  }

  // Modern language content path
  if (!info && MODERN_EXTS.has(ext)) {
    const selectedType =
      requestedType === 'auto' ? inferModernTypeFromContent(content) : requestedType;
    const mermaid = generateModernMermaidFromContent(content, selectedType, ext);
    const metadata = {
      type: selectedType,
      format: 'mermaid',
      category: 'modern',
      language: ext,
    };
    diagramCache.set(content, requestedType, mermaid, metadata, sectionId, direction);
    return { success: true, content: mermaid, metadata };
  }

  const legacyInfo = info;
  if (!legacyInfo) {
    return { success: false, content: `Error: unrecognized extension .${ext}` };
  }

  // Create a synthetic path for parsers that need it
  const syntheticPath = `/tmp/opencob_virtual/source.${ext}`;

  const validTypes = DIAGRAM_TYPES[legacyInfo.category] ?? [];
  const selectedLegacyType =
    requestedType === 'auto' ? inferLegacyTypeFromContent(legacyInfo, content) : requestedType;
  const legacyType = selectedLegacyType as LegacyDiagramType;
  if (!validTypes.includes(legacyType)) {
    // Allow screen_layout for .dds content that is actually a display file
    const isDdsDisplayFile =
      legacyInfo.category === 'dds' &&
      legacyType === 'screen_layout' &&
      /DSPSIZ|WORKSTN|CF\d+\(/i.test(content);
    if (!isDdsDisplayFile) {
      return {
        success: false,
        content: `Error: diagram type "${selectedLegacyType}" not available for ${legacyInfo.category} files. Available: ${validTypes.join(', ')}`,
      };
    }
  }

  let data: DiagramData | null = null;

  if (COBOL_EXTS.has(ext)) {
    const parser = new CobolParser();
    const _program = parser.parse(content, syntheticPath);
    data = generateCobolDiagram(syntheticPath, content, legacyType, legacyInfo, sectionId);
  } else if (CL_EXTS.has(ext)) {
    data = generateClDiagram(syntheticPath, content, legacyType, legacyInfo, sectionId);
  } else if (RPG_EXTS.has(ext)) {
    data = generateRpgDiagram(syntheticPath, content, legacyType, legacyInfo);
  } else if (PLI_EXTS.has(ext)) {
    data = generatePliDiagram(syntheticPath, content, legacyType, legacyInfo);
  } else if (BMS_EXTS.has(ext)) {
    data = generateBmsDiagram(syntheticPath, content, legacyType);
  } else if (DDS_EXTS.has(ext)) {
    data = generateDdsDiagram(syntheticPath, content, legacyType);
  }

  if (!data || (data.nodes.length === 0 && !data.data)) {
    const hint = getDiagramRequirementHint(selectedLegacyType);
    return {
      success: false,
      content: `No data found for diagram type "${selectedLegacyType}" in this content.${hint}`,
    };
  }

  // For screen_layout, render ASCII art
  if (selectedLegacyType === 'screen_layout' && data.screen) {
    const ascii = screenLayoutToAscii(data);
    const metadata = {
      type: selectedLegacyType,
      format: 'ascii',
      category: legacyInfo.category,
      platform: legacyInfo.platform,
      language: legacyInfo.language,
      screen: data.screen,
      screenFields: data.nodes,
      fieldCount: data.nodes.length,
    };
    diagramCache.set(content, requestedType, ascii, metadata, sectionId, direction);
    return { success: true, content: ascii, metadata };
  }

  // Collapse large procedure_flow
  if (selectedLegacyType === 'procedure_flow' && data.nodes.length > 100) {
    data = collapseProcedureFlow(data);
  }

  const mermaid = diagramDataToMermaid(legacyType, data, direction);

  // Build node-to-line map for click navigation
  const nodeLines: Record<string, number> = {};
  const nodeFiles: Record<string, string> = {};
  for (const node of data.nodes) {
    if (node.startLine && node.startLine > 0) {
      nodeLines[node.id] = node.startLine;
    }
    // External references: call/copybook/file nodes without startLine
    if (
      (node.type === 'call' || node.type === 'copybook' || node.type === 'file') &&
      !node.startLine
    ) {
      nodeFiles[node.id] = node.label;
    }
  }

  const metadata = {
    type: selectedLegacyType,
    format: 'mermaid',
    category: legacyInfo.category,
    platform: legacyInfo.platform,
    language: legacyInfo.language,
    nodeCount: data.nodes?.length ?? 0,
    edgeCount: data.edges?.length ?? 0,
    nodeLines,
    nodeFiles,
  };
  diagramCache.set(content, requestedType, mermaid, metadata, sectionId, direction);
  return { success: true, content: mermaid, metadata };
}

/**
 * Return a human-friendly hint explaining what the file needs for a given diagram type.
 */
function getDiagramRequirementHint(diagramType: string): string {
  const hints: Record<string, string> = {
    call_graph: ' Requires CALL statements (e.g., CALL "PROGRAM-NAME").',
    dependency_map: ' Requires COPY/INCLUDE statements referencing external copybooks.',
    copybook_tree: ' Requires COPY/INCLUDE statements.',
    file_io: ' Requires SELECT...ASSIGN or FD statements referencing files.',
    control_flow: ' Requires a PROCEDURE DIVISION with IF/EVALUATE/PERFORM control structures.',
    procedure_flow: ' Requires a PROCEDURE DIVISION with multiple paragraphs or sections.',
    structure_chart: ' Requires a PROCEDURE DIVISION with PERFORM targets.',
    field_hierarchy: ' Requires DATA DIVISION with level-number field definitions.',
    record_layout: ' Requires record format definitions (A R recordname) with fields.',
    screen_layout: ' Requires screen field definitions with row/column positions.',
    usage_map: ' Requires CALL, COPY, or file I/O statements.',
  };
  return (
    hints[diagramType] ?? ' The file may not contain the required constructs for this diagram type.'
  );
}

function generateModernMermaidFromContent(
  content: string,
  type: string,
  extension: string,
): string {
  const virtualPath = `source.${extension}`;
  const files = [virtualPath];
  const readMap = new Map<string, string>([[virtualPath, content]]);

  const read = (file: string): string => readMap.get(file) ?? '';

  if (type === 'auto') {
    type = inferModernTypeFromContent(content);
  }

  switch (type) {
    case 'dependency': {
      const lines = ['graph TD'];
      const nodeId = sanitizeId(virtualPath);
      lines.push(`  ${nodeId}["${virtualPath}"]`);
      const importRegex =
        /(?:import\s+.*from\s+['"]([^'"]+)['"]|require\s*\(\s*['"]([^'"]+)['"]\s*\)|from\s+([a-zA-Z0-9_.]+)\s+import\s+)/g;
      let match;
      while ((match = importRegex.exec(content)) !== null) {
        const dep = match[1] ?? match[2] ?? match[3];
        const depId = sanitizeId(`dep_${dep}`);
        lines.push(`  ${nodeId} --> ${depId}["${dep}"]`);
      }
      return '```mermaid\n' + lines.join('\n') + '\n```';
    }
    case 'class': {
      const lines = ['classDiagram'];
      const classRegex =
        /(?:export\s+)?(?:abstract\s+)?class\s+(\w+)(?:\s+extends\s+(\w+))?(?:\s+implements\s+([\w,\s]+))?/g;
      let match;
      while ((match = classRegex.exec(content)) !== null) {
        const className = match[1];
        lines.push(`  class ${className}`);
        if (match[2]) lines.push(`  ${match[2]} <|-- ${className}`);
        if (match[3]) {
          const interfaces = match[3].split(',').map((s) => s.trim());
          for (const iface of interfaces) lines.push(`  ${iface} <|.. ${className}`);
        }
      }
      return lines.length > 1
        ? '```mermaid\n' + lines.join('\n') + '\n```'
        : '```mermaid\nclassDiagram\n  class NoClassesFound\n```';
    }
    case 'structure':
      return '```mermaid\ngraph TD\n  root["' + virtualPath + '"]\n```';
    case 'call-graph':
    default: {
      const lines = ['graph LR'];
      const contentRead = read(files[0]);
      const funcRegex =
        /(?:export\s+)?(?:async\s+)?function\s+(\w+)|(?:export\s+)?const\s+(\w+)\s*=\s*(?:async\s+)?|\bdef\s+(\w+)\s*\(|\bfunc\s+(\w+)\s*\(/g;
      let match;
      while ((match = funcRegex.exec(contentRead)) !== null) {
        const funcName = match[1] ?? match[2] ?? match[3] ?? match[4];
        if (!funcName) continue;
        const nodeId = sanitizeId(`fn:${funcName}`);
        lines.push(`  ${nodeId}["${funcName}"]`);
      }
      return lines.length > 1
        ? '```mermaid\n' + lines.join('\n') + '\n```'
        : '```mermaid\ngraph LR\n  NoFunctionsFound["No functions found"]\n```';
    }
  }
}

// ══════════════════════════════════════════════════════════════
//  Public API: content-based availability detection
// ══════════════════════════════════════════════════════════════

/**
 * Given raw source content and an extension, return only the diagram types
 * that are actually viable (evidence-based).
 *
 * For legacy files: probes content for calls, copies, sections, fields, etc.
 * For modern files: probes for classes, imports, functions, etc.
 */
export function getAvailableDiagramsFromContent(
  content: string,
  extension: string,
): { category: string; types: string[]; recommended: string } {
  const ext = extension.replace(/^\./, '').toLowerCase();
  const info = classifyExtension(ext);

  if (info) {
    const candidates = DIAGRAM_TYPES[info.category] ?? [];
    const available = getActuallyAvailableDiagramsFromContent(info, candidates, content);
    const recommended = inferLegacyTypeFromContent(info, content);
    return { category: info.category, types: available, recommended };
  }

  if (MODERN_EXTS.has(ext)) {
    const available = getModernAvailableTypes(content);
    const recommended = inferModernTypeFromContent(content);
    return { category: 'modern', types: available, recommended };
  }

  return { category: 'unknown', types: [], recommended: 'structure' };
}

/**
 * Evidence-based availability for legacy files using content probing.
 */
function getActuallyAvailableDiagramsFromContent(
  info: FileTypeInfo,
  candidateTypes: string[],
  content: string,
): string[] {
  const available: string[] = [];
  const upper = content.toUpperCase();
  const hasProcDiv = upper.includes('PROCEDURE DIVISION');

  // For .dds files that are actually display files, include screen_layout
  let candidates = candidateTypes;
  if (
    info.category === 'dds' &&
    !candidateTypes.includes('screen_layout') &&
    /DSPSIZ|WORKSTN|CF\d+\(/i.test(content)
  ) {
    candidates = [...candidateTypes, 'screen_layout'];
  }

  for (const dtype of candidates) {
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
        if (!hasProcDiv) break;
        const paraCount = (content.match(/^.{6}\s{1,4}[A-Za-z0-9][\w-]+\s*\./gm) ?? []).length;
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
        available.push(dtype);
        break;
      case 'record_layout':
        available.push(dtype);
        break;
      case 'usage_map':
        if (
          /CALL\s+['"]?\w/i.test(content) ||
          /COPY\s+\w/i.test(content) ||
          (upper.includes('SELECT') && upper.includes('ASSIGN'))
        ) {
          available.push(dtype);
        }
        break;
      default:
        available.push(dtype);
    }
  }
  return available;
}

/**
 * Evidence-based availability for modern language files.
 * Returns only types whose constructs are actually present.
 */
function getModernAvailableTypes(content: string): string[] {
  const available: string[] = [];

  const hasClass = /\b(class|interface|extends|implements)\b/.test(content);
  if (hasClass) available.push('class');

  const hasImports =
    /\bimport\s+.+\s+from\s+['"][^'"]+['"]/.test(content) ||
    /\brequire\s*\(\s*['"][^'"]+['"]\s*\)/.test(content) ||
    /\bfrom\s+[a-zA-Z0-9_.]+\s+import\s+/.test(content);
  if (hasImports) available.push('dependency');

  const hasFunctions =
    /\bfunction\s+\w+/.test(content) ||
    /\bdef\s+\w+\s*\(/.test(content) ||
    /\bfunc\s+\w+\s*\(/.test(content) ||
    /(?:export\s+)?const\s+\w+\s*=\s*(?:async\s+)?\(/.test(content);
  if (hasFunctions) available.push('call-graph');

  // structure is always available as a fallback
  available.push('structure');

  return available;
}

// ══════════════════════════════════════════════════════════════
//  Section extraction for control_flow picker
// ══════════════════════════════════════════════════════════════

export interface SectionEntry {
  id: number;
  name: string;
  type: string;
  startLine: number;
  endLine: number;
}

/**
 * Extract procedure sections/paragraphs from source content.
 * Returns list suitable for user selection in control_flow diagrams.
 */
export function getSectionsFromContent(content: string, extension: string): SectionEntry[] {
  const ext = extension.replace(/^\./, '').toLowerCase();
  const info = classifyExtension(ext);
  if (!info) return [];

  if (COBOL_EXTS.has(ext)) {
    const parser = new CobolParser();
    const program = parser.parse(content, `virtual.${ext}`);
    // Show only sections in the dropdown (not individual paragraphs)
    // If no sections exist, fall back to paragraphs
    const items =
      program.sections.length > 0
        ? program.sections.map((s) => ({ ...s, itemType: 'section' as const, endLine: s.line }))
        : program.paragraphs.map((p) => ({ ...p, itemType: 'paragraph' as const }));
    const sorted = items.sort((a, b) => a.line - b.line);

    return sorted.map((item, i) => ({
      id: i,
      name: item.name,
      type: item.itemType,
      startLine: item.line,
      endLine: item.endLine,
    }));
  }

  if (CL_EXTS.has(ext)) {
    // CL programs typically have a single PGM block; extract subroutines
    const sections: SectionEntry[] = [];
    const subRegex = /^\s*(\w+):\s*(?:SUBR|DO\b)/gim;
    const lines = content.split('\n');
    let id = 0;
    for (let i = 0; i < lines.length; i++) {
      subRegex.lastIndex = 0;
      const m = subRegex.exec(lines[i]);
      if (m) {
        sections.push({
          id: id++,
          name: m[1],
          type: 'subroutine',
          startLine: i + 1,
          endLine: i + 1,
        });
      }
    }
    // Add PGM as the first entry if no subroutines found
    if (sections.length === 0) {
      sections.push({ id: 0, name: 'PGM', type: 'program', startLine: 1, endLine: lines.length });
    }
    return sections;
  }

  if (RPG_EXTS.has(ext)) {
    const parser = new RpgParser();
    const program = parser.parse(content, `virtual.${ext}`);
    return program.procedures.map((p, i) => ({
      id: i,
      name: p.name,
      type: 'procedure',
      startLine: p.line,
      endLine: p.endLine ?? p.line,
    }));
  }

  return [];
}
