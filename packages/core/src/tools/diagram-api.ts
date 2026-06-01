/**
 * OpenCob Diagram API — Stable contract for external consumers.
 *
 * Provides a clean interface matching Codex-style REST endpoints:
 * - listAvailableTypes(content, extension)
 * - generateDiagram(content, extension, type, sectionId?)
 * - listSections(content, extension)
 * - invalidateCache(content)
 *
 * All functions are synchronous (in-memory processing).
 * This module is safe to call from web servers, EE backend, or CLI.
 */

import {
  generateDiagramFromContent,
  getAvailableDiagramsFromContent,
  getSectionsFromContent,
  type SectionEntry,
} from './generate-diagram.js';
import { diagramCache } from './diagram-cache.js';
import { classifyExtension } from './diagram-types.js';
import type { DiagramType } from './diagram-types.js';

// ── Public API Types ────────────────────────────────────────

export interface DiagramAvailabilityResponse {
  /** File category: program, copybook, screen, dds, jcl, other, modern, unknown */
  category: string;
  /** Diagram types that are actually viable for this content */
  availableTypes: string[];
  /** Recommended default type based on content analysis */
  recommended: string;
  /** Types that are currently in the diagram cache (pre-rendered) */
  cachedTypes: string[];
  /** Extension classified info (null if modern/unknown) */
  fileInfo: {
    label: string;
    platform: string;
    language: string;
  } | null;
}

export interface DiagramGenerationResponse {
  success: boolean;
  /** Mermaid markdown or ASCII art content */
  content: string;
  /** Generation metadata */
  metadata?: {
    type: string;
    format: 'mermaid' | 'ascii';
    category: string;
    platform?: string;
    language?: string;
    nodeCount?: number;
    edgeCount?: number;
    [key: string]: unknown;
  };
  /** Error message if success is false */
  error?: string;
}

export interface DiagramSectionResponse {
  sections: SectionEntry[];
}

// ── Public API Functions ────────────────────────────────────

/**
 * List available diagram types for given source content and extension.
 * Equivalent to Codex GET /api/diagrams/{file_id}
 */
export function listAvailableTypes(
  content: string,
  extension: string,
): DiagramAvailabilityResponse {
  const ext = extension.replace(/^\./, '').toLowerCase();
  const availability = getAvailableDiagramsFromContent(content, ext);
  const info = classifyExtension(ext);

  // Check which types are currently cached for this content
  const cachedTypes: string[] = [];
  for (const dtype of availability.types) {
    if (diagramCache.get(content, dtype)) {
      cachedTypes.push(dtype);
    }
  }

  return {
    category: availability.category,
    availableTypes: availability.types,
    recommended: availability.recommended,
    cachedTypes,
    fileInfo: info ? { label: info.label, platform: info.platform, language: info.language } : null,
  };
}

/**
 * Generate a diagram from source content.
 * Equivalent to Codex GET /api/diagram/{file_id}/{type}
 */
export function generateDiagram(
  content: string,
  extension: string,
  type: string,
  sectionId?: number,
  direction?: string,
): DiagramGenerationResponse {
  const result = generateDiagramFromContent(
    content,
    extension,
    type as DiagramType,
    sectionId,
    direction,
  );

  if (!result.success) {
    return {
      success: false,
      content: '',
      error: result.content,
    };
  }

  return {
    success: true,
    content: result.content,
    metadata: result.metadata as DiagramGenerationResponse['metadata'],
  };
}

/**
 * List procedure sections/paragraphs for control_flow section selection.
 * Equivalent to DriverX sections_from_content()
 */
export function listSections(content: string, extension: string): DiagramSectionResponse {
  const sections = getSectionsFromContent(content, extension);
  return { sections };
}

/**
 * Invalidate cached diagram results for given content.
 * Call when file content changes.
 */
export function invalidateDiagramCache(content: string): void {
  diagramCache.invalidate(content);
}

/**
 * Clear the entire diagram cache.
 */
export function clearDiagramCache(): void {
  diagramCache.clear();
}
