/**
 * Diagram Parity Test Suite
 *
 * Validates OpenCob diagram engine behavior against Codex/DriverX baseline:
 * - Extension coverage (all legacy + modern recognized)
 * - Diagram type coverage per category
 * - Availability detection rules (content-based)
 * - API contract shape
 * - Cache behavior
 * - Section extraction
 */

import { describe, it, expect } from 'vitest';
import {
  classifyExtension,
  getAvailableDiagramTypes,
  ALL_LEGACY_EXTS,
  COBOL_EXTS,
  CL_EXTS,
  RPG_EXTS,
  PLI_EXTS,
  BMS_EXTS,
  DDS_EXTS,
  DIAGRAM_TYPES,
  FILE_TYPES,
} from '../src/tools/diagram-types.js';
import {
  generateDiagramFromContent,
  getAvailableDiagramsFromContent,
  getSectionsFromContent,
} from '../src/tools/generate-diagram.js';
import { DiagramCache } from '../src/tools/diagram-cache.js';
import {
  listAvailableTypes,
  generateDiagram,
  listSections,
  invalidateDiagramCache,
  clearDiagramCache,
} from '../src/tools/diagram-api.js';

// ══════════════════════════════════════════════════════════════
//  Extension Coverage
// ══════════════════════════════════════════════════════════════

describe('Extension Coverage', () => {
  const EXPECTED_LEGACY_EXTS = [
    // COBOL family
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
    // CL family
    'clle',
    'clp',
    'cmd',
    'mnu',
    // BMS/ASM
    'map',
    'asm',
    'rma',
    // DDS
    'dds',
    'pf',
    'lf',
    'dspf',
    'prtf',
    // RPG
    'rpg',
    'rpgle',
    'sqlrpgle',
    'sqlrpg',
    // PL/I
    'pli',
    'pl1',
    'inc',
  ];

  it('should recognize all legacy extensions from DriverX/Codex', () => {
    for (const ext of EXPECTED_LEGACY_EXTS) {
      const info = classifyExtension(ext);
      expect(info, `Extension .${ext} should be classified`).toBeDefined();
      expect(info!.extension).toBe(ext);
    }
  });

  it('ALL_LEGACY_EXTS should contain all expected extensions', () => {
    for (const ext of EXPECTED_LEGACY_EXTS) {
      expect(ALL_LEGACY_EXTS.has(ext), `.${ext} should be in ALL_LEGACY_EXTS`).toBe(true);
    }
  });

  it('should have correct category assignments matching DriverX', () => {
    // Programs
    expect(classifyExtension('cob')?.category).toBe('program');
    expect(classifyExtension('ccp')?.category).toBe('program');
    expect(classifyExtension('clle')?.category).toBe('program');
    expect(classifyExtension('rpgle')?.category).toBe('program');
    expect(classifyExtension('pli')?.category).toBe('program');

    // Copybooks
    expect(classifyExtension('sbc')?.category).toBe('copybook');
    expect(classifyExtension('cpy')?.category).toBe('copybook');
    expect(classifyExtension('inc')?.category).toBe('copybook');

    // Screens
    expect(classifyExtension('map')?.category).toBe('screen');
    expect(classifyExtension('dspf')?.category).toBe('screen');

    // DDS
    expect(classifyExtension('pf')?.category).toBe('dds');
    expect(classifyExtension('lf')?.category).toBe('dds');
  });

  it('extension group sets should be non-overlapping', () => {
    const sets = [COBOL_EXTS, CL_EXTS, RPG_EXTS, PLI_EXTS, BMS_EXTS, DDS_EXTS];
    const all = new Set<string>();
    for (const s of sets) {
      for (const ext of s) {
        expect(all.has(ext), `Extension .${ext} appears in multiple groups`).toBe(false);
        all.add(ext);
      }
    }
  });
});

// ══════════════════════════════════════════════════════════════
//  Diagram Type Coverage
// ══════════════════════════════════════════════════════════════

describe('Diagram Type Coverage', () => {
  it('program category should have all expected types including usage_map', () => {
    const types = DIAGRAM_TYPES.program;
    expect(types).toContain('call_graph');
    expect(types).toContain('dependency_map');
    expect(types).toContain('structure_chart');
    expect(types).toContain('procedure_flow');
    expect(types).toContain('control_flow');
    expect(types).toContain('field_hierarchy');
    expect(types).toContain('file_io');
    expect(types).toContain('copybook_tree');
    expect(types).toContain('usage_map');
  });

  it('copybook category should have record_layout and usage_map', () => {
    const types = DIAGRAM_TYPES.copybook;
    expect(types).toContain('record_layout');
    expect(types).toContain('field_hierarchy');
    expect(types).toContain('usage_map');
  });

  it('screen category should have screen_layout', () => {
    const types = DIAGRAM_TYPES.screen;
    expect(types).toContain('screen_layout');
    expect(types).toContain('usage_map');
  });

  it('dds category should have record_layout and field_hierarchy', () => {
    const types = DIAGRAM_TYPES.dds;
    expect(types).toContain('record_layout');
    expect(types).toContain('field_hierarchy');
    expect(types).toContain('usage_map');
  });

  it('getAvailableDiagramTypes returns correct types for each category', () => {
    expect(getAvailableDiagramTypes('cob')).toEqual(DIAGRAM_TYPES.program);
    expect(getAvailableDiagramTypes('sbc')).toEqual(DIAGRAM_TYPES.copybook);
    expect(getAvailableDiagramTypes('map')).toEqual(DIAGRAM_TYPES.screen);
    expect(getAvailableDiagramTypes('pf')).toEqual(DIAGRAM_TYPES.dds);
  });

  it('unknown extensions return empty array', () => {
    expect(getAvailableDiagramTypes('xyz')).toEqual([]);
    expect(getAvailableDiagramTypes('pdf')).toEqual([]);
  });
});

// ══════════════════════════════════════════════════════════════
//  Availability Detection Rules
// ══════════════════════════════════════════════════════════════

describe('Availability Detection Rules', () => {
  const COBOL_WITH_CALLS = `
       IDENTIFICATION DIVISION.
       PROGRAM-ID. TESTPGM.
       PROCEDURE DIVISION.
       MAIN-PARA.
           CALL 'SUBPROG1'
           CALL 'SUBPROG2'
           STOP RUN.
  `;

  const COBOL_WITH_COPY = `
       IDENTIFICATION DIVISION.
       PROGRAM-ID. TESTPGM.
       DATA DIVISION.
       WORKING-STORAGE SECTION.
       COPY MYCOPY.
       01 WS-FIELD PIC X(10).
       PROCEDURE DIVISION.
       MAIN-PARA.
           DISPLAY WS-FIELD
           STOP RUN.
  `;

  const COBOL_COPYBOOK = `
       01 CUSTOMER-RECORD.
          05 CUST-ID     PIC 9(8).
          05 CUST-NAME   PIC X(30).
          05 CUST-ADDR   PIC X(50).
  `;

  const MODERN_TS = `
import { something } from './module';
import { other } from 'external-lib';

export class MyService extends BaseService implements IService {
  async function doWork(): Promise<void> {
    return;
  }
}

export function helper() { return 42; }
  `;

  const MODERN_PY = `
from typing import List
import os

def process_items(items: List[str]) -> None:
    for item in items:
        print(item)

class DataProcessor:
    def __init__(self):
        pass
  `;

  it('COBOL with CALLs should detect call_graph availability', () => {
    const result = getAvailableDiagramsFromContent(COBOL_WITH_CALLS, 'cob');
    expect(result.types).toContain('call_graph');
    expect(result.types).toContain('control_flow');
  });

  it('COBOL with COPY should detect dependency_map/copybook_tree', () => {
    const result = getAvailableDiagramsFromContent(COBOL_WITH_COPY, 'cob');
    expect(result.types).toContain('dependency_map');
    expect(result.types).toContain('copybook_tree');
  });

  it('COBOL copybook should detect field_hierarchy', () => {
    const result = getAvailableDiagramsFromContent(COBOL_COPYBOOK, 'sbc');
    expect(result.types).toContain('field_hierarchy');
  });

  it('TypeScript with classes should detect class type', () => {
    const result = getAvailableDiagramsFromContent(MODERN_TS, 'ts');
    expect(result.category).toBe('modern');
    expect(result.types).toContain('class');
    expect(result.types).toContain('dependency');
    expect(result.types).toContain('call-graph');
    expect(result.types).toContain('structure');
  });

  it('Python with classes and imports should detect class and dependency', () => {
    const result = getAvailableDiagramsFromContent(MODERN_PY, 'py');
    expect(result.types).toContain('class');
    expect(result.types).toContain('dependency');
    expect(result.types).toContain('call-graph');
  });

  it('should return recommended type based on content', () => {
    const callResult = getAvailableDiagramsFromContent(COBOL_WITH_CALLS, 'cob');
    expect(callResult.recommended).toBe('control_flow');

    const tsResult = getAvailableDiagramsFromContent(MODERN_TS, 'ts');
    expect(tsResult.recommended).toBe('class');
  });

  it('unknown extension returns empty types', () => {
    const result = getAvailableDiagramsFromContent('some content', 'xyz');
    expect(result.category).toBe('unknown');
    expect(result.types).toEqual([]);
  });
});

// ══════════════════════════════════════════════════════════════
//  Diagram Generation (API Shape)
// ══════════════════════════════════════════════════════════════

describe('Diagram Generation', () => {
  const COBOL_PROGRAM = `
       IDENTIFICATION DIVISION.
       PROGRAM-ID. SAMPLE.
       DATA DIVISION.
       WORKING-STORAGE SECTION.
       01 WS-VAR PIC X(10).
       PROCEDURE DIVISION.
       MAIN-PARA.
           CALL 'TARGET1'
           PERFORM SUB-PARA
           STOP RUN.
       SUB-PARA.
           DISPLAY WS-VAR.
  `;

  it('generates Mermaid content for call_graph', () => {
    const result = generateDiagramFromContent(COBOL_PROGRAM, 'cob', 'call_graph');
    expect(result.success).toBe(true);
    expect(result.content).toContain('```mermaid');
    expect(result.metadata?.type).toBe('call_graph');
    expect(result.metadata?.format).toBe('mermaid');
  });

  it('generates dependency diagram for modern TypeScript', () => {
    const ts = `import { foo } from './bar';\nimport os from 'os';`;
    const result = generateDiagramFromContent(ts, 'ts', 'dependency');
    expect(result.success).toBe(true);
    expect(result.content).toContain('```mermaid');
  });

  it('auto type selects appropriate diagram', () => {
    const result = generateDiagramFromContent(COBOL_PROGRAM, 'cob', 'auto');
    expect(result.success).toBe(true);
    expect(result.metadata?.type).toBeDefined();
  });

  it('returns error for invalid type + category combination', () => {
    const copybook = `       01 REC. 05 FLD PIC X(5).`;
    const result = generateDiagramFromContent(copybook, 'sbc', 'call_graph');
    expect(result.success).toBe(false);
  });

  it('returns error for unrecognized extension', () => {
    const result = generateDiagramFromContent('content', 'xyz', 'auto');
    expect(result.success).toBe(false);
  });
});

// ══════════════════════════════════════════════════════════════
//  Cache Behavior
// ══════════════════════════════════════════════════════════════

describe('Diagram Cache', () => {
  it('caches and retrieves diagram results', () => {
    const cache = new DiagramCache();
    const content = 'test content';
    cache.set(content, 'call_graph', '```mermaid\ngraph LR\n```', { type: 'call_graph' });

    const entry = cache.get(content, 'call_graph');
    expect(entry).toBeDefined();
    expect(entry!.content).toContain('mermaid');
  });

  it('returns undefined for uncached content', () => {
    const cache = new DiagramCache();
    expect(cache.get('unknown', 'call_graph')).toBeUndefined();
  });

  it('invalidates cache for specific content', () => {
    const cache = new DiagramCache();
    const content = 'test';
    cache.set(content, 'call_graph', 'diagram1');
    cache.set(content, 'dependency', 'diagram2');

    cache.invalidate(content);
    expect(cache.get(content, 'call_graph')).toBeUndefined();
    expect(cache.get(content, 'dependency')).toBeUndefined();
  });

  it('respects TTL expiration', () => {
    const cache = new DiagramCache(1); // 1ms TTL
    cache.set('content', 'type', 'result');

    // Wait for expiry
    const start = Date.now();
    while (Date.now() - start < 5) {
      /* spin */
    }

    expect(cache.get('content', 'type')).toBeUndefined();
  });

  it('evicts oldest when at capacity', () => {
    const cache = new DiagramCache();
    // Fill beyond capacity
    for (let i = 0; i < 101; i++) {
      cache.set(`content_${i}`, 'type', `result_${i}`);
    }
    expect(cache.size).toBeLessThanOrEqual(100);
  });

  it('integrates with generateDiagramFromContent (second call is cached)', () => {
    clearDiagramCache();
    const ts = `import { x } from './y';`;
    const r1 = generateDiagramFromContent(ts, 'ts', 'dependency');
    const r2 = generateDiagramFromContent(ts, 'ts', 'dependency');
    expect(r1.content).toBe(r2.content);
  });
});

// ══════════════════════════════════════════════════════════════
//  Section Extraction
// ══════════════════════════════════════════════════════════════

describe('Section Extraction', () => {
  const COBOL_WITH_SECTIONS = `
       IDENTIFICATION DIVISION.
       PROGRAM-ID. SECTPGM.
       PROCEDURE DIVISION.
       INIT-SECTION SECTION.
       INIT-PARA.
           DISPLAY 'INIT'.
       PROCESS-SECTION SECTION.
       PROCESS-PARA.
           DISPLAY 'PROCESS'.
       CLEANUP-PARA.
           STOP RUN.
  `;

  it('extracts COBOL sections and paragraphs', () => {
    const sections = getSectionsFromContent(COBOL_WITH_SECTIONS, 'cob');
    expect(sections.length).toBeGreaterThan(0);
    const names = sections.map((s) => s.name);
    expect(names.some((n) => n.includes('INIT'))).toBe(true);
  });

  it('returns empty for unrecognized extension', () => {
    const sections = getSectionsFromContent('content', 'xyz');
    expect(sections).toEqual([]);
  });

  it('returns array with id, name, type, startLine, endLine', () => {
    const sections = getSectionsFromContent(COBOL_WITH_SECTIONS, 'cob');
    if (sections.length > 0) {
      const s = sections[0];
      expect(s).toHaveProperty('id');
      expect(s).toHaveProperty('name');
      expect(s).toHaveProperty('type');
      expect(s).toHaveProperty('startLine');
      expect(s).toHaveProperty('endLine');
    }
  });
});

// ══════════════════════════════════════════════════════════════
//  Stable API Contract
// ══════════════════════════════════════════════════════════════

describe('Diagram API Contract', () => {
  it('listAvailableTypes returns correct shape', () => {
    const result = listAvailableTypes('       CALL "X". COPY Y.', 'cob');
    expect(result).toHaveProperty('category');
    expect(result).toHaveProperty('availableTypes');
    expect(result).toHaveProperty('recommended');
    expect(result).toHaveProperty('fileInfo');
    expect(Array.isArray(result.availableTypes)).toBe(true);
  });

  it('generateDiagram returns correct success shape', () => {
    const result = generateDiagram(`import { x } from './y';`, 'ts', 'dependency');
    expect(result.success).toBe(true);
    expect(result.content.length).toBeGreaterThan(0);
    expect(result.metadata).toBeDefined();
    expect(result.metadata!.type).toBe('dependency');
  });

  it('generateDiagram returns correct error shape', () => {
    const result = generateDiagram('content', 'xyz', 'auto');
    expect(result.success).toBe(false);
    expect(result.error).toBeDefined();
    expect(result.content).toBe('');
  });

  it('listSections returns correct shape', () => {
    const result = listSections('       PGM\n       ENDPGM', 'clle');
    expect(result).toHaveProperty('sections');
    expect(Array.isArray(result.sections)).toBe(true);
  });

  it('invalidateDiagramCache does not throw', () => {
    expect(() => invalidateDiagramCache('any content')).not.toThrow();
  });

  it('clearDiagramCache does not throw', () => {
    expect(() => clearDiagramCache()).not.toThrow();
  });
});
