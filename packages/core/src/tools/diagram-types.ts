/**
 * Diagram Engine Type Definitions & Extension Dispatch
 *
 * Ported from DriverX diagram_engine.py — provides extension-aware
 * classification and diagram type routing for legacy source files.
 */

// ── Node & Edge types for diagram data ──────────────────────

export interface DiagramNode {
  id: string;
  label: string;
  type: string;
  startLine?: number;
  endLine?: number;
  level?: number;
  lineCount?: number;
  pic?: string;
  usage?: string;
  redefines?: string;
  occurs?: number;
  row?: number;
  col?: number;
  length?: number;
  attrb?: string;
  initial?: string;
  displayLabel?: string;
  fieldType?: string;
  decimalPos?: number;
  alias?: string;
}

export interface DiagramEdge {
  source: string;
  target: string;
  label?: string;
  edgeType?: string;
  line?: number;
}

export interface DiagramData {
  nodes: DiagramNode[];
  edges: DiagramEdge[];
  screen?: ScreenMeta;
  diagram_type?: string;
  section_id?: number;
  section_name?: string;
  sections?: SectionInfo[];
  data?: { nodes: DiagramNode[]; edges: DiagramEdge[] };
}

export interface ScreenMeta {
  rows: number;
  cols: number;
  title: string;
  platform: '3270' | '5250';
  funcKeys?: string[];
}

export interface SectionInfo {
  id: number;
  name: string;
  type: string;
  startLine: number;
  endLine: number;
}

// ── File type classification ────────────────────────────────

export type FileCategory = 'program' | 'copybook' | 'screen' | 'dds' | 'jcl' | 'other';
export type Platform = 'mainframe' | 'as400' | 'both';
export type Language = 'cobol' | 'bms' | 'dds' | 'cl' | 'rpg' | 'asm' | 'jcl' | 'pli' | 'generic';

export interface FileTypeInfo {
  extension: string;
  label: string;
  category: FileCategory;
  platform: Platform;
  language: Language;
}

/**
 * Extension-to-file-type mapping. Covers mainframe (z/OS) and AS/400 (IBM i) extensions.
 */
export const FILE_TYPES: Record<string, FileTypeInfo> = {
  // Mainframe COBOL
  cob: {
    extension: 'cob',
    label: 'COBOL Program',
    category: 'program',
    platform: 'mainframe',
    language: 'cobol',
  },
  sbc: {
    extension: 'sbc',
    label: 'COBOL Copybook',
    category: 'copybook',
    platform: 'mainframe',
    language: 'cobol',
  },
  ccp: {
    extension: 'ccp',
    label: 'CICS Program',
    category: 'program',
    platform: 'mainframe',
    language: 'cobol',
  },
  ccc: {
    extension: 'ccc',
    label: 'CICS Copybook',
    category: 'copybook',
    platform: 'mainframe',
    language: 'cobol',
  },
  cbe: {
    extension: 'cbe',
    label: 'COBOL (batch)',
    category: 'program',
    platform: 'mainframe',
    language: 'cobol',
  },
  rmc: {
    extension: 'rmc',
    label: 'COBOL (RM variant)',
    category: 'program',
    platform: 'mainframe',
    language: 'cobol',
  },

  // Mainframe screens / assembler
  map: {
    extension: 'map',
    label: 'BMS Map',
    category: 'screen',
    platform: 'mainframe',
    language: 'bms',
  },
  rma: {
    extension: 'rma',
    label: 'Assembler (RM)',
    category: 'program',
    platform: 'mainframe',
    language: 'asm',
  },
  asm: {
    extension: 'asm',
    label: 'Assembler',
    category: 'program',
    platform: 'mainframe',
    language: 'asm',
  },

  // AS/400 COBOL
  cbl: {
    extension: 'cbl',
    label: 'COBOL/400 Program',
    category: 'program',
    platform: 'as400',
    language: 'cobol',
  },
  cpy: {
    extension: 'cpy',
    label: 'COBOL Copybook (400)',
    category: 'copybook',
    platform: 'as400',
    language: 'cobol',
  },
  cblcpy: {
    extension: 'cblcpy',
    label: 'COBOL Copybook (long)',
    category: 'copybook',
    platform: 'as400',
    language: 'cobol',
  },
  sqb: {
    extension: 'sqb',
    label: 'COBOL (SQL embedded)',
    category: 'program',
    platform: 'as400',
    language: 'cobol',
  },
  pco: {
    extension: 'pco',
    label: 'COBOL (precompiled)',
    category: 'program',
    platform: 'as400',
    language: 'cobol',
  },
  obs: {
    extension: 'obs',
    label: 'Object Source (COBOL)',
    category: 'program',
    platform: 'as400',
    language: 'cobol',
  },

  // AS/400 CL
  clle: {
    extension: 'clle',
    label: 'CL Program (ILE)',
    category: 'program',
    platform: 'as400',
    language: 'cl',
  },
  clp: {
    extension: 'clp',
    label: 'CL Program',
    category: 'program',
    platform: 'as400',
    language: 'cl',
  },
  cmd: {
    extension: 'cmd',
    label: 'Command Definition',
    category: 'program',
    platform: 'as400',
    language: 'cl',
  },
  mnu: {
    extension: 'mnu',
    label: 'Menu Source (CL)',
    category: 'program',
    platform: 'as400',
    language: 'cl',
  },

  // AS/400 DDS
  dds: {
    extension: 'dds',
    label: 'Data Description (DDS)',
    category: 'dds',
    platform: 'as400',
    language: 'dds',
  },
  pf: {
    extension: 'pf',
    label: 'Physical File (DDS)',
    category: 'dds',
    platform: 'as400',
    language: 'dds',
  },
  lf: {
    extension: 'lf',
    label: 'Logical File (DDS)',
    category: 'dds',
    platform: 'as400',
    language: 'dds',
  },
  dspf: {
    extension: 'dspf',
    label: 'Display File (DDS)',
    category: 'screen',
    platform: 'as400',
    language: 'dds',
  },
  prtf: {
    extension: 'prtf',
    label: 'Print File (DDS)',
    category: 'dds',
    platform: 'as400',
    language: 'dds',
  },

  // RPG variants
  rpg: {
    extension: 'rpg',
    label: 'RPG Program',
    category: 'program',
    platform: 'as400',
    language: 'rpg',
  },
  rpgle: {
    extension: 'rpgle',
    label: 'RPG LE Program',
    category: 'program',
    platform: 'as400',
    language: 'rpg',
  },
  sqlrpgle: {
    extension: 'sqlrpgle',
    label: 'SQL RPG LE Program',
    category: 'program',
    platform: 'as400',
    language: 'rpg',
  },
  sqlrpg: {
    extension: 'sqlrpg',
    label: 'SQL RPG Program',
    category: 'program',
    platform: 'as400',
    language: 'rpg',
  },

  // PL/I
  pli: {
    extension: 'pli',
    label: 'PL/I Program',
    category: 'program',
    platform: 'mainframe',
    language: 'pli',
  },
  pl1: {
    extension: 'pl1',
    label: 'PL/I Program',
    category: 'program',
    platform: 'mainframe',
    language: 'pli',
  },
  inc: {
    extension: 'inc',
    label: 'PL/I Include',
    category: 'copybook',
    platform: 'mainframe',
    language: 'pli',
  },
};

/**
 * Diagram types available per file category.
 */
export const DIAGRAM_TYPES: Record<FileCategory, string[]> = {
  program: [
    'call_graph',
    'dependency_map',
    'structure_chart',
    'procedure_flow',
    'control_flow',
    'field_hierarchy',
    'file_io',
    'copybook_tree',
  ],
  copybook: ['record_layout', 'field_hierarchy', 'dependency_map', 'copybook_tree'],
  screen: ['screen_layout', 'dependency_map', 'copybook_tree'],
  dds: ['record_layout', 'field_hierarchy'],
  jcl: ['dependency_map'],
  other: ['dependency_map', 'copybook_tree'],
};

/** All valid legacy diagram types */
export type LegacyDiagramType =
  | 'call_graph'
  | 'dependency_map'
  | 'structure_chart'
  | 'procedure_flow'
  | 'control_flow'
  | 'field_hierarchy'
  | 'file_io'
  | 'copybook_tree'
  | 'record_layout'
  | 'screen_layout';

/** Modern language diagram types (kept for backward compat) */
export type ModernDiagramType = 'call-graph' | 'dependency' | 'structure' | 'class';

/** All diagram types */
export type DiagramType = LegacyDiagramType | ModernDiagramType;

// ── Extension group sets ────────────────────────────────────

export const COBOL_EXTS = new Set([
  'cob',
  'sbc',
  'ccp',
  'ccc',
  'cbe',
  'cbl',
  'cpy',
  'sqb',
  'pco',
  'cblcpy',
  'rmc',
  'obs',
]);

export const CL_EXTS = new Set(['clle', 'clp', 'cmd', 'mnu']);

export const BMS_EXTS = new Set(['map', 'asm', 'rma']);

export const DDS_EXTS = new Set(['dds', 'pf', 'lf', 'dspf', 'prtf']);

export const RPG_EXTS = new Set(['rpg', 'rpgle', 'sqlrpgle', 'sqlrpg']);

export const PLI_EXTS = new Set(['pli', 'pl1', 'inc']);

/** All legacy file extensions recognized by the diagram engine */
export const ALL_LEGACY_EXTS = new Set([
  ...COBOL_EXTS,
  ...CL_EXTS,
  ...BMS_EXTS,
  ...DDS_EXTS,
  ...RPG_EXTS,
  ...PLI_EXTS,
]);

/**
 * Classify a file extension to its FileTypeInfo.
 * Returns undefined for unrecognized extensions.
 */
export function classifyExtension(ext: string): FileTypeInfo | undefined {
  return FILE_TYPES[ext.toLowerCase().replace(/^\./, '')];
}

/**
 * Get available diagram types for a given file extension.
 */
export function getAvailableDiagramTypes(ext: string): string[] {
  const info = classifyExtension(ext);
  if (!info) return [];
  return DIAGRAM_TYPES[info.category] ?? [];
}
