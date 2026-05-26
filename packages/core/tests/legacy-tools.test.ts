import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { createFindReferencesTool, createShowImpactChainTool } from '../src/tools/legacy-tools.js';

describe('legacy-tools', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'legacy-tools-'));

    // Create sample COBOL files
    const cobolDir = path.join(tmpDir, 'src');
    fs.mkdirSync(cobolDir, { recursive: true });

    fs.writeFileSync(
      path.join(cobolDir, 'MAIN.cbl'),
      `       IDENTIFICATION DIVISION.
       PROGRAM-ID. MAIN.
       PROCEDURE DIVISION.
           CALL 'HELPER'
           PERFORM PROCESS-RECORD
           COPY SHARED-CPY.
           STOP RUN.
       PROCESS-RECORD.
           DISPLAY 'PROCESSING'.
`,
    );

    fs.writeFileSync(
      path.join(cobolDir, 'HELPER.cbl'),
      `       IDENTIFICATION DIVISION.
       PROGRAM-ID. HELPER.
       PROCEDURE DIVISION.
           CALL 'UTILITY'
           COPY SHARED-CPY.
           STOP RUN.
`,
    );

    fs.writeFileSync(
      path.join(cobolDir, 'UTILITY.cbl'),
      `       IDENTIFICATION DIVISION.
       PROGRAM-ID. UTILITY.
       PROCEDURE DIVISION.
           DISPLAY 'UTILITY RUNNING'.
           STOP RUN.
`,
    );

    // Create sample RPG file
    fs.writeFileSync(
      path.join(cobolDir, 'RPGPGM.rpgle'),
      `       /COPY QCPYLESRC,SHARED-CPY
       dcl-proc Main;
         CALLP HELPER();
       end-proc;
`,
    );
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('find_references', () => {
    it('finds CALL references to a program', async () => {
      const tool = createFindReferencesTool(tmpDir);
      const result = await tool.execute({ name: 'HELPER' });
      expect(result.success).toBe(true);
      expect(result.content).toContain('HELPER');
      expect(result.content).toContain('CALL');
    });

    it('finds COPY references to a copybook', async () => {
      const tool = createFindReferencesTool(tmpDir);
      const result = await tool.execute({ name: 'SHARED-CPY' });
      expect(result.success).toBe(true);
      expect(result.content).toContain('COPY');
    });

    it('finds PERFORM references to a paragraph', async () => {
      const tool = createFindReferencesTool(tmpDir);
      const result = await tool.execute({ name: 'PROCESS-RECORD' });
      expect(result.success).toBe(true);
      expect(result.content).toContain('PERFORM');
    });

    it('finds RPG CALLP references', async () => {
      const tool = createFindReferencesTool(tmpDir);
      const result = await tool.execute({ name: 'HELPER' });
      expect(result.success).toBe(true);
      // Should find both COBOL CALL and RPG CALLP
      expect(result.content).toContain('CALL');
    });

    it('returns no results for unknown program', async () => {
      const tool = createFindReferencesTool(tmpDir);
      const result = await tool.execute({ name: 'NONEXIST' });
      expect(result.success).toBe(true);
      expect(result.content).toContain('No references found');
    });

    it('requires name parameter', async () => {
      const tool = createFindReferencesTool(tmpDir);
      const result = await tool.execute({});
      expect(result.success).toBe(false);
      expect(result.content).toContain('name');
    });

    it('supports direction filter', async () => {
      const tool = createFindReferencesTool(tmpDir);
      const result = await tool.execute({ name: 'HELPER', direction: 'callers' });
      expect(result.success).toBe(true);
    });
  });

  describe('show_impact_chain', () => {
    it('shows impact chain for a program', async () => {
      const tool = createShowImpactChainTool(tmpDir);
      const result = await tool.execute({ name: 'HELPER' });
      expect(result.success).toBe(true);
      expect(result.content).toContain('HELPER');
    });

    it('requires name parameter', async () => {
      const tool = createShowImpactChainTool(tmpDir);
      const result = await tool.execute({});
      expect(result.success).toBe(false);
      expect(result.content).toContain('name');
    });

    it('supports depth parameter', async () => {
      const tool = createShowImpactChainTool(tmpDir);
      const result = await tool.execute({ name: 'UTILITY', depth: 2 });
      expect(result.success).toBe(true);
    });

    it('handles programs with no dependencies', async () => {
      const tool = createShowImpactChainTool(tmpDir);
      const result = await tool.execute({ name: 'NONEXIST' });
      expect(result.success).toBe(true);
    });
  });
});
