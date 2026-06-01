/**
 * REFFLD Cross-File Resolver — Resolves DDS field lengths from referenced Physical Files.
 *
 * Ported from DriverX diagram_engine.py `_resolve_reffld_lengths()`.
 * Searches sibling directories for PF files, parses them, and resolves field lengths.
 * Also handles RFDUMMY(NNN) pattern for hardcoded length hints.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { parseDds, type DdsField, type DdsParseResult } from './dds-parser.js';

/** Cache of PF file field maps: fileName → { FIELDNAME → length } */
const REFFLD_CACHE = new Map<string, Map<string, number>>();

/** Pattern for RFDUMMY pseudo-field markers with embedded length */
const RE_RFDUMMY = /RFDUMMY(\d+)/i;

/**
 * Resolve field lengths for DDS fields that use REFFLD but have no fieldLength.
 * Mutates the fields in place (sets fieldLength where resolved).
 *
 * @param fields Array of DDS fields to resolve
 * @param sourcePath Path to the source DDS file (used to locate sibling PFs)
 * @param searchRoots Additional directories to search for PF files
 * @returns Number of fields successfully resolved
 */
export function resolveReffldLengths(
  fields: DdsField[],
  sourcePath: string,
  searchRoots?: string[],
): number {
  let resolved = 0;
  const moduleRoot = guessModuleRoot(sourcePath);
  const searchDirs = [path.dirname(sourcePath), moduleRoot, ...(searchRoots ?? [])].filter(Boolean);

  for (const field of fields) {
    // Skip fields that already have a length or don't reference another field
    if (field.fieldLength !== null || !field.refField) continue;

    // Try RFDUMMY pattern first (hardcoded length in field name)
    const dummyMatch = RE_RFDUMMY.exec(field.refField);
    if (dummyMatch) {
      field.fieldLength = parseInt(dummyMatch[1], 10);
      resolved++;
      continue;
    }

    // Also check if the field name itself is RFDUMMY pattern
    const nameDummyMatch = RE_RFDUMMY.exec(field.fieldName);
    if (nameDummyMatch && field.fieldLength === null) {
      field.fieldLength = parseInt(nameDummyMatch[1], 10);
      resolved++;
      continue;
    }

    // Parse REFFLD reference: "FIELDNAME FILENAME" or "FIELDNAME LIB/FILENAME"
    const parts = field.refField.trim().split(/\s+/);
    if (parts.length < 2) continue;

    const refFieldName = parts[0].split('/').pop()?.toUpperCase() ?? '';
    const refFileName = parts[1].split('/').pop()?.replace(/\*/g, '').toUpperCase() ?? '';

    if (!refFieldName || !refFileName) continue;

    // Lookup in cache
    const cacheKey = refFileName.toLowerCase();
    if (!REFFLD_CACHE.has(cacheKey)) {
      const fieldMap = parsePfForFields(refFileName, searchDirs);
      REFFLD_CACHE.set(cacheKey, fieldMap);
    }

    const resolvedLength = REFFLD_CACHE.get(cacheKey)?.get(refFieldName);
    if (resolvedLength !== undefined) {
      field.fieldLength = resolvedLength;
      resolved++;
    }
  }

  return resolved;
}

/**
 * Clear the REFFLD resolution cache.
 */
export function clearReffldCache(): void {
  REFFLD_CACHE.clear();
}

/**
 * Get current cache size (for diagnostics).
 */
export function getReffldCacheSize(): number {
  return REFFLD_CACHE.size;
}

// ── Internal Helpers ────────────────────────────────────────

/**
 * Search for a PF file by name and parse its fields into a lookup map.
 */
function parsePfForFields(pfName: string, searchDirs: string[]): Map<string, number> {
  const fieldMap = new Map<string, number>();
  const targetName = pfName.toUpperCase();
  const extensions = ['.pf', '.dds', '.PF', '.DDS'];

  for (const dir of searchDirs) {
    if (!dir || !fs.existsSync(dir)) continue;

    // Search current directory and one level of subdirectories
    const candidates = findPfFile(dir, targetName, extensions, 2);
    if (candidates.length === 0) continue;

    // Parse the first match
    const pfPath = candidates[0];
    try {
      const content = fs.readFileSync(pfPath, 'utf-8');
      const result: DdsParseResult = parseDds(content, pfPath);

      for (const fld of result.allFields) {
        if (fld.fieldLength !== null && fld.fieldName) {
          fieldMap.set(fld.fieldName.toUpperCase(), fld.fieldLength);
        }
      }
      break; // Found and parsed, stop searching
    } catch {
      continue; // Parse error, try next candidate
    }
  }

  return fieldMap;
}

/**
 * Recursively find a PF file by name in a directory tree.
 */
function findPfFile(
  dir: string,
  targetName: string,
  extensions: string[],
  maxDepth: number,
  currentDepth: number = 0,
): string[] {
  if (currentDepth > maxDepth) return [];

  const results: string[] = [];
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isFile()) {
      const baseName = path.basename(entry.name, path.extname(entry.name)).toUpperCase();
      const ext = path.extname(entry.name).toLowerCase();
      if (
        baseName === targetName &&
        (extensions.includes(ext) || extensions.includes(ext.toUpperCase()))
      ) {
        results.push(fullPath);
      }
    } else if (entry.isDirectory() && currentDepth < maxDepth) {
      // Skip obvious non-source directories
      if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
      results.push(...findPfFile(fullPath, targetName, extensions, maxDepth, currentDepth + 1));
    }
  }

  return results;
}

/**
 * Guess the module/project root from a source file path.
 * Walks up looking for common root markers (src/, QSRC/, QDDSSRC/).
 */
function guessModuleRoot(filePath: string): string {
  let dir = path.dirname(filePath);
  const srcMarkers = ['QSRC', 'QDDSSRC', 'QCLSRC', 'QRPGSRC', 'QRPGLESRC', 'src', 'source'];
  for (let i = 0; i < 5; i++) {
    const basename = path.basename(dir).toUpperCase();
    if (srcMarkers.some((m) => m.toUpperCase() === basename)) {
      return path.dirname(dir); // Return parent of the source folder
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return path.dirname(filePath);
}
