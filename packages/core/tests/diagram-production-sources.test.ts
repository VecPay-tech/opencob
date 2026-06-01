/**
 * Exhaustive diagram generation test against production COBOL/CL/DDS sources.
 *
 * Scans C:\Paytech\worldline\asccend\source\ recursively and attempts ALL
 * diagram types (including 'auto') for EVERY file. Verifies ZERO thrown
 * exceptions from production code — "not supported" or "no data" returns are
 * fine, but crashes are not.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'fs';
import { join, extname, relative } from 'path';
import {
  generateDiagramFromContent,
  getAvailableDiagramsFromContent,
} from '../src/tools/generate-diagram.js';

const SOURCE_ROOT = 'C:\\Paytech\\worldline\\asccend\\source';

// All legacy diagram types + auto
const ALL_DIAGRAM_TYPES = [
  'auto',
  'call_graph',
  'dependency_map',
  'structure_chart',
  'procedure_flow',
  'control_flow',
  'field_hierarchy',
  'file_io',
  'copybook_tree',
  'record_layout',
  'screen_layout',
  'usage_map',
] as const;

// Supported extensions for diagram generation
const SUPPORTED_EXTS = new Set([
  '.cbl',
  '.cpy',
  '.clp',
  '.clle',
  '.dds',
  '.dspf',
  '.prtf',
  '.pf',
  '.lf',
  '.cmd',
  '.mnu',
]);

interface SourceFile {
  path: string;
  rel: string;
  ext: string;
}

function collectFiles(dir: string, maxPerExt: number = 100): SourceFile[] {
  const extCounts = new Map<string, number>();
  const files: SourceFile[] = [];

  function walk(d: string) {
    let entries: string[];
    try {
      entries = readdirSync(d);
    } catch {
      return;
    }
    for (const e of entries) {
      const full = join(d, e);
      let st;
      try {
        st = statSync(full);
      } catch {
        continue;
      }
      if (st.isDirectory()) {
        walk(full);
      } else if (st.isFile()) {
        const ext = extname(full).toLowerCase();
        if (!SUPPORTED_EXTS.has(ext)) continue;
        const count = extCounts.get(ext) ?? 0;
        if (count >= maxPerExt) continue;
        extCounts.set(ext, count + 1);
        files.push({ path: full, rel: relative(SOURCE_ROOT, full), ext });
      }
    }
  }

  walk(dir);
  return files;
}

// Collect up to 100 files per extension type (~1100 files total)
const testFiles = collectFiles(SOURCE_ROOT, 100);

describe('Production Source Diagram Generation — Exhaustive', { timeout: 120000 }, () => {
  it('should never throw for any diagram type on any file', () => {
    const crashes: Array<{ file: string; ext: string; type: string; error: string }> = [];
    let totalAttempts = 0;

    for (const f of testFiles) {
      let content: string;
      try {
        content = readFileSync(f.path, 'utf-8');
      } catch {
        continue;
      }
      if (content.trim().length === 0) continue;

      for (const dtype of ALL_DIAGRAM_TYPES) {
        totalAttempts++;
        try {
          generateDiagramFromContent(content, f.ext, dtype as any);
        } catch (err: any) {
          crashes.push({
            file: f.rel,
            ext: f.ext,
            type: dtype,
            error: err.message || String(err),
          });
        }
      }
    }

    console.log(`\n=== Exhaustive Diagram Test ===`);
    console.log(`Files: ${testFiles.length}`);
    console.log(`Total attempts (files × ${ALL_DIAGRAM_TYPES.length} types): ${totalAttempts}`);
    console.log(`Crashes: ${crashes.length}`);

    if (crashes.length > 0) {
      console.error(`\nCRASHES:`);
      // Group by error message
      const byError = new Map<string, Array<{ file: string; type: string }>>();
      for (const c of crashes) {
        const key = c.error.slice(0, 100);
        const list = byError.get(key) ?? [];
        list.push({ file: c.file, type: c.type });
        byError.set(key, list);
      }
      for (const [err, occurrences] of byError) {
        console.error(`  [${occurrences.length}x] ${err}`);
        occurrences.slice(0, 3).forEach((o) => console.error(`    → ${o.file} [${o.type}]`));
        if (occurrences.length > 3) console.error(`    → ... and ${occurrences.length - 3} more`);
      }
    }

    expect(crashes).toHaveLength(0);
  });

  it('should detect available diagrams without throwing for any file', () => {
    const crashes: Array<{ file: string; ext: string; error: string }> = [];

    for (const f of testFiles) {
      let content: string;
      try {
        content = readFileSync(f.path, 'utf-8');
      } catch {
        continue;
      }
      if (content.trim().length === 0) continue;

      try {
        getAvailableDiagramsFromContent(content, f.ext);
      } catch (err: any) {
        crashes.push({ file: f.rel, ext: f.ext, error: err.message || String(err) });
      }
    }

    if (crashes.length > 0) {
      console.error(`Availability detection crashes:`);
      crashes.slice(0, 10).forEach((c) => console.error(`  ${c.file}: ${c.error}`));
    }
    expect(crashes).toHaveLength(0);
  });

  it('should produce valid mermaid content when generation succeeds', () => {
    const badOutputs: Array<{ file: string; type: string; issue: string }> = [];
    let successCount = 0;

    for (const f of testFiles) {
      let content: string;
      try {
        content = readFileSync(f.path, 'utf-8');
      } catch {
        continue;
      }
      if (content.trim().length === 0) continue;

      const availability = getAvailableDiagramsFromContent(content, f.ext);
      for (const dtype of availability.types) {
        let result: { success: boolean; content: string };
        try {
          result = generateDiagramFromContent(content, f.ext, dtype as any);
        } catch {
          continue; // crashes checked in other test
        }

        if (!result.success) continue;
        successCount++;

        // Validate output contains mermaid syntax or valid ASCII art
        const output = result.content;
        if (!output || output.trim().length === 0) {
          badOutputs.push({ file: f.rel, type: dtype, issue: 'empty output' });
        } else if (
          !output.includes('```mermaid') &&
          !output.includes('graph ') &&
          !output.includes('flowchart ') &&
          !output.includes('classDiagram') &&
          !output.includes('sequenceDiagram') &&
          !output.includes('stateDiagram') &&
          !output.includes('+---') &&
          !output.includes('|')
        ) {
          badOutputs.push({
            file: f.rel,
            type: dtype,
            issue: 'no mermaid block or ASCII art found',
          });
        }
      }
    }

    console.log(`\nSuccessful diagrams validated: ${successCount}`);
    if (badOutputs.length > 0) {
      console.error(`Bad outputs:`);
      badOutputs.slice(0, 10).forEach((b) => console.error(`  ${b.file} [${b.type}]: ${b.issue}`));
    }
    expect(badOutputs).toHaveLength(0);
  });

  it('should have >90% success rate for detected-available types', () => {
    let total = 0;
    let success = 0;
    const byType = new Map<string, { total: number; success: number }>();

    for (const f of testFiles) {
      let content: string;
      try {
        content = readFileSync(f.path, 'utf-8');
      } catch {
        continue;
      }
      if (content.trim().length === 0) continue;

      const availability = getAvailableDiagramsFromContent(content, f.ext);
      for (const dtype of availability.types) {
        total++;
        const entry = byType.get(dtype) ?? { total: 0, success: 0 };
        entry.total++;
        try {
          const result = generateDiagramFromContent(content, f.ext, dtype as any);
          if (result.success) {
            success++;
            entry.success++;
          }
        } catch {
          // counted as failure
        }
        byType.set(dtype, entry);
      }
    }

    const rate = total > 0 ? success / total : 0;
    console.log(`\nOverall success rate: ${(rate * 100).toFixed(1)}% (${success}/${total})`);
    console.log(`\nBy diagram type:`);
    for (const [type, stats] of [...byType.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
      const pct = ((stats.success / stats.total) * 100).toFixed(1);
      console.log(`  ${type}: ${stats.success}/${stats.total} (${pct}%)`);
    }

    expect(rate).toBeGreaterThanOrEqual(0.9);
  });

  describe('per extension type — zero crash guarantee', () => {
    const extGroups = new Map<string, SourceFile[]>();
    for (const f of testFiles) {
      const group = extGroups.get(f.ext) ?? [];
      group.push(f);
      extGroups.set(f.ext, group);
    }

    for (const [ext, files] of extGroups) {
      it(`${ext} files (${files.length}) × all ${ALL_DIAGRAM_TYPES.length} types = no crash`, () => {
        const crashes: string[] = [];

        for (const f of files) {
          let content: string;
          try {
            content = readFileSync(f.path, 'utf-8');
          } catch {
            continue;
          }
          if (content.trim().length === 0) continue;

          for (const dtype of ALL_DIAGRAM_TYPES) {
            try {
              generateDiagramFromContent(content, f.ext, dtype as any);
            } catch (err: any) {
              crashes.push(`${f.rel} [${dtype}]: ${err.message}`);
            }
          }
        }

        if (crashes.length > 0) {
          console.error(`Crashes for ${ext}:`);
          crashes.slice(0, 10).forEach((c) => console.error(`  ${c}`));
          if (crashes.length > 10) console.error(`  ... and ${crashes.length - 10} more`);
        }
        expect(crashes).toHaveLength(0);
      });
    }
  });
});
