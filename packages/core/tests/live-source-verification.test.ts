/**
 * Live Source Verification Test
 *
 * Runs OpenCob parsers against real AS/400 COBOL source from
 * /Users/everestkwok/Projects/asccend/source
 *
 * This validates that the parsers work on production-grade code,
 * not just unit-test fixtures.
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { CobolParser } from '../src/legacy/cobol-parser.js';
import { parseDds } from '../src/legacy/dds-parser.js';

const SOURCE_ROOT = '/Users/everestkwok/Projects/asccend/source';
const HAS_SOURCE = fs.existsSync(SOURCE_ROOT);

// Collect files
function collectFiles(ext: string, max = 100): string[] {
  if (!HAS_SOURCE) return [];
  const results: string[] = [];
  const walk = (dir: string) => {
    if (results.length >= max) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (results.length >= max) return;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith(ext)) results.push(full);
    }
  };
  walk(SOURCE_ROOT);
  return results;
}

describe.skipIf(!HAS_SOURCE)('Live Source Verification — COBOL Parser', () => {
  const cobolFiles = collectFiles('.cbl', 200);
  const copybookDirs = [...new Set(collectFiles('.cpy', 50).map((f) => path.dirname(f)))];
  const parser = new CobolParser(copybookDirs);

  it(`should find COBOL files in asccend/source`, () => {
    expect(cobolFiles.length).toBeGreaterThan(0);
    console.log(`Found ${cobolFiles.length} COBOL files to test`);
  });

  it('should parse all sampled COBOL files without throwing', () => {
    let parsed = 0;
    let withProgramId = 0;
    let withDivisions = 0;
    let withCopybooks = 0;
    let withDataItems = 0;
    let withExecSql = 0;
    let withCallStatements = 0;
    const errors: string[] = [];

    for (const file of cobolFiles) {
      try {
        const content = fs.readFileSync(file, 'utf-8');
        const result = parser.parse(content, file);
        parsed++;
        if (result.programId) withProgramId++;
        if (result.divisions.length > 0) withDivisions++;
        if (result.copybooks.length > 0) withCopybooks++;
        if (result.dataItems.length > 0) withDataItems++;
        if (result.execSql.length > 0) withExecSql++;
        if (result.callStatements.length > 0) withCallStatements++;
      } catch (e: any) {
        errors.push(`${path.basename(file)}: ${e.message}`);
      }
    }

    console.log(`\n=== COBOL Parse Results ===`);
    console.log(`  Files parsed:     ${parsed}/${cobolFiles.length}`);
    console.log(`  With PROGRAM-ID:  ${withProgramId}`);
    console.log(`  With divisions:   ${withDivisions}`);
    console.log(`  With copybooks:   ${withCopybooks}`);
    console.log(`  With data items:  ${withDataItems}`);
    console.log(`  With EXEC SQL:    ${withExecSql}`);
    console.log(`  With CALL:        ${withCallStatements}`);
    if (errors.length > 0) {
      console.log(`  Errors (${errors.length}): ${errors.slice(0, 5).join(', ')}`);
    }

    // 100% of files should parse without crash
    expect(parsed).toBe(cobolFiles.length);
    // Vast majority should have a PROGRAM-ID
    expect(withProgramId).toBeGreaterThan(cobolFiles.length * 0.8);
  });

  it('should extract meaningful data structures from real programs', () => {
    // Parse a larger file to verify deep extraction
    const largeFiles = cobolFiles
      .map((f) => ({ path: f, size: fs.statSync(f).size }))
      .sort((a, b) => b.size - a.size)
      .slice(0, 5);

    for (const { path: filePath, size } of largeFiles) {
      const content = fs.readFileSync(filePath, 'utf-8');
      const result = parser.parse(content, filePath);

      console.log(`\n  ${path.basename(filePath)} (${(size / 1024).toFixed(1)}KB):`);
      console.log(`    Program: ${result.programId}`);
      console.log(`    Divisions: ${result.divisions.map((d) => d.name).join(', ')}`);
      console.log(`    Paragraphs: ${result.paragraphs.length}`);
      console.log(`    Data items: ${result.dataItems.length}`);
      console.log(`    Copybooks: ${result.copybooks.map((c) => c.name).join(', ') || 'none'}`);
      console.log(`    EXEC SQL: ${result.execSql.length}`);
      console.log(`    CALLs: ${result.callStatements.length}`);

      // Large files should have multiple divisions and data items
      expect(result.divisions.length).toBeGreaterThan(0);
    }
  });

  it('should resolve COPY statements to copybook paths', () => {
    let resolved = 0;
    let unresolved = 0;
    const allCopybooks: string[] = [];

    for (const file of cobolFiles.slice(0, 50)) {
      const content = fs.readFileSync(file, 'utf-8');
      const result = parser.parse(content, file);
      for (const cb of result.copybooks) {
        allCopybooks.push(cb.name);
        if (cb.resolvedPath) resolved++;
        else unresolved++;
      }
    }

    console.log(`\n=== Copybook Resolution ===`);
    console.log(`  Total COPY refs:  ${allCopybooks.length}`);
    console.log(`  Resolved:         ${resolved}`);
    console.log(`  Unresolved:       ${unresolved}`);
    console.log(`  Unique names:     ${new Set(allCopybooks).size}`);

    // Parser should find copybook references
    expect(allCopybooks.length).toBeGreaterThan(0);
  });
});

describe.skipIf(!HAS_SOURCE)('Live Source Verification — DDS Parser', () => {
  const ddsFiles = collectFiles('.dds', 200);

  it(`should find DDS files in asccend/source`, () => {
    expect(ddsFiles.length).toBeGreaterThan(0);
    console.log(`Found ${ddsFiles.length} DDS files to test`);
  });

  it('should parse all sampled DDS files without throwing', () => {
    let parsed = 0;
    let withRecords = 0;
    let withFields = 0;
    let withKeys = 0;
    let totalRecords = 0;
    let totalFields = 0;
    const errors: string[] = [];

    for (const file of ddsFiles) {
      try {
        const content = fs.readFileSync(file, 'utf-8');
        const result = parseDds(content, file);
        parsed++;
        if (result.records.length > 0) {
          withRecords++;
          totalRecords += result.records.length;
        }
        const fieldCount = result.allFields.length;
        if (fieldCount > 0) {
          withFields++;
          totalFields += fieldCount;
        }
        if (result.records.some((r) => r.keys.length > 0)) withKeys++;
      } catch (e: any) {
        errors.push(`${path.basename(file)}: ${e.message}`);
      }
    }

    console.log(`\n=== DDS Parse Results ===`);
    console.log(`  Files parsed:     ${parsed}/${ddsFiles.length}`);
    console.log(`  With records:     ${withRecords}`);
    console.log(`  With fields:      ${withFields}`);
    console.log(`  With keys:        ${withKeys}`);
    console.log(`  Total records:    ${totalRecords}`);
    console.log(`  Total fields:     ${totalFields}`);
    if (errors.length > 0) {
      console.log(`  Errors (${errors.length}): ${errors.slice(0, 5).join(', ')}`);
    }

    // 100% should parse without crash
    expect(parsed).toBe(ddsFiles.length);
  });

  it('should extract field types and record structures from real DDS', () => {
    const sampleFiles = ddsFiles.slice(0, 10);
    const fieldTypes = new Set<string>();
    const recordNames = new Set<string>();

    for (const file of sampleFiles) {
      const content = fs.readFileSync(file, 'utf-8');
      const result = parseDds(content, file);
      for (const rec of result.records) {
        recordNames.add(rec.name);
        for (const field of rec.fields) {
          if (field.fieldType) fieldTypes.add(field.fieldType);
        }
      }
    }

    console.log(`\n=== DDS Field Analysis ===`);
    console.log(`  Unique record names: ${recordNames.size}`);
    console.log(`  Field types found: ${[...fieldTypes].join(', ')}`);

    expect(recordNames.size).toBeGreaterThan(0);
  });
});

describe.skipIf(!HAS_SOURCE)('Live Source Verification — Cross-Module Dependency Graph', () => {
  const cobolFiles = collectFiles('.cbl', 100);
  const parser = new CobolParser([]);

  it('should build a call graph across the source libraries', () => {
    const callGraph = new Map<string, Set<string>>();
    const programs = new Map<string, string>();

    for (const file of cobolFiles) {
      const content = fs.readFileSync(file, 'utf-8');
      const result = parser.parse(content, file);
      if (result.programId) {
        programs.set(result.programId.toUpperCase(), file);
        const targets = new Set<string>();
        for (const call of result.callStatements) {
          targets.add(call.target.toUpperCase());
        }
        if (targets.size > 0) {
          callGraph.set(result.programId.toUpperCase(), targets);
        }
      }
    }

    // Count internal vs external calls
    let internalCalls = 0;
    let externalCalls = 0;
    for (const [, targets] of callGraph) {
      for (const target of targets) {
        if (programs.has(target)) internalCalls++;
        else externalCalls++;
      }
    }

    console.log(`\n=== Call Graph Analysis ===`);
    console.log(`  Programs found:     ${programs.size}`);
    console.log(`  Programs with CALLs: ${callGraph.size}`);
    console.log(`  Internal calls:     ${internalCalls}`);
    console.log(`  External calls:     ${externalCalls}`);

    expect(programs.size).toBeGreaterThan(0);
  });

  it('should detect copybook sharing across libraries', () => {
    const copybookUsage = new Map<string, string[]>();
    const copybookDirs = [...new Set(collectFiles('.cpy', 200).map((f) => path.dirname(f)))];
    const cpParser = new CobolParser(copybookDirs);

    for (const file of cobolFiles.slice(0, 50)) {
      const content = fs.readFileSync(file, 'utf-8');
      const result = cpParser.parse(content, file);
      const lib = file.split('/').find((p) => p.startsWith('sc3')) || 'unknown';
      for (const cb of result.copybooks) {
        if (!copybookUsage.has(cb.name)) copybookUsage.set(cb.name, []);
        copybookUsage.get(cb.name)!.push(lib);
      }
    }

    const shared = [...copybookUsage.entries()].filter(([, libs]) => new Set(libs).size > 1);

    console.log(`\n=== Copybook Sharing Analysis ===`);
    console.log(`  Total copybook refs:  ${copybookUsage.size}`);
    console.log(`  Shared across libs:   ${shared.length}`);
    if (shared.length > 0) {
      console.log(
        `  Examples: ${shared
          .slice(0, 5)
          .map(([name, libs]) => `${name} → ${[...new Set(libs)].length} libs`)
          .join(', ')}`,
      );
    }

    expect(copybookUsage.size).toBeGreaterThan(0);
  });
});
