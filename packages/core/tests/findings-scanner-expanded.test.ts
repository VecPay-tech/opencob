import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { FindingsScanner } from '../src/findings/findings-scanner.js';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

describe('FindingsScanner — expanded coverage', () => {
  let tmpDir: string;
  let scanner: FindingsScanner;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'findings-test-'));
    scanner = new FindingsScanner(tmpDir);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('security scanning', () => {
    it('detects hardcoded secrets', () => {
      fs.writeFileSync(
        path.join(tmpDir, 'secrets.ts'),
        `const password = "my_secret_pass123";\nconst token = 'tok_abc12345';`,
      );
      const findings = scanner.scanFile('secrets.ts');
      const security = findings.filter((f) => f.category === 'security');
      expect(security.length).toBeGreaterThanOrEqual(1);
      expect(security[0].message).toContain('secret');
    });

    it('detects SQL injection patterns', () => {
      fs.writeFileSync(
        path.join(tmpDir, 'db.ts'),
        'const q = query(`SELECT * FROM users WHERE id = ${userId}`);',
      );
      const findings = scanner.scanFile('db.ts');
      const sql = findings.filter((f) => f.message.includes('SQL injection'));
      expect(sql).toHaveLength(1);
      expect(sql[0].severity).toBe('error');
    });

    it('no security findings for clean code', () => {
      fs.writeFileSync(
        path.join(tmpDir, 'clean.ts'),
        'export const add = (a: number, b: number) => a + b;',
      );
      const findings = scanner.scanFile('clean.ts');
      const security = findings.filter((f) => f.category === 'security');
      expect(security).toHaveLength(0);
    });
  });

  describe('complexity scanning', () => {
    it('detects deeply nested code', () => {
      // 6+ levels of indentation (12+ spaces)
      const code = '            const deep = true; // level 6+';
      fs.writeFileSync(path.join(tmpDir, 'nested.ts'), code);
      const findings = scanner.scanFile('nested.ts');
      const complexity = findings.filter((f) => f.category === 'complexity');
      expect(complexity.length).toBeGreaterThanOrEqual(1);
      expect(complexity[0].message).toContain('nested');
    });

    it('detects large files', () => {
      const lines = Array.from({ length: 600 }, (_, i) => `const line${i} = ${i};`);
      fs.writeFileSync(path.join(tmpDir, 'big.ts'), lines.join('\n'));
      const findings = scanner.scanFile('big.ts');
      const large = findings.filter((f) => f.message.includes('Large file'));
      expect(large).toHaveLength(1);
      expect(large[0].severity).toBe('warning');
    });
  });

  describe('style scanning', () => {
    it('detects lines exceeding 150 chars', () => {
      const longLine = 'x'.repeat(160);
      fs.writeFileSync(path.join(tmpDir, 'long.ts'), longLine);
      const findings = scanner.scanFile('long.ts');
      const style = findings.filter((f) => f.category === 'style');
      expect(style).toHaveLength(1);
      expect(style[0].message).toContain('150');
    });
  });

  describe('maintenance scanning', () => {
    it('detects TODO markers', () => {
      fs.writeFileSync(path.join(tmpDir, 'todo.ts'), '// TODO: fix this later');
      const findings = scanner.scanFile('todo.ts');
      const maint = findings.filter((f) => f.category === 'maintenance');
      expect(maint).toHaveLength(1);
      expect(maint[0].message).toContain('TODO');
    });

    it('detects FIXME markers', () => {
      fs.writeFileSync(path.join(tmpDir, 'fixme.ts'), '// FIXME: broken');
      const findings = scanner.scanFile('fixme.ts');
      const maint = findings.filter((f) => f.category === 'maintenance');
      expect(maint).toHaveLength(1);
      expect(maint[0].message).toContain('FIXME');
    });

    it('detects HACK markers', () => {
      fs.writeFileSync(path.join(tmpDir, 'hack.ts'), '// HACK: workaround');
      const findings = scanner.scanFile('hack.ts');
      const maint = findings.filter((f) => f.category === 'maintenance');
      expect(maint).toHaveLength(1);
    });

    it('handles TODO without description', () => {
      fs.writeFileSync(path.join(tmpDir, 'bare.ts'), '// TODO');
      const findings = scanner.scanFile('bare.ts');
      const maint = findings.filter((f) => f.category === 'maintenance');
      expect(maint).toHaveLength(1);
      expect(maint[0].message).toContain('no description');
    });
  });

  describe('dead code scanning', () => {
    it('detects commented-out code', () => {
      fs.writeFileSync(
        path.join(tmpDir, 'dead.ts'),
        '// const oldVar = 123;\n// function deprecated() {}\n// import { old } from "x";',
      );
      const findings = scanner.scanFile('dead.ts');
      const dead = findings.filter((f) => f.category === 'dead-code');
      expect(dead.length).toBeGreaterThanOrEqual(2);
    });
  });

  describe('file management', () => {
    it('returns empty for nonexistent file', () => {
      const findings = scanner.scanFile('nonexistent.ts');
      expect(findings).toHaveLength(0);
    });

    it('clears findings when file is deleted', () => {
      fs.writeFileSync(path.join(tmpDir, 'temp.ts'), '// TODO: remove');
      scanner.scanFile('temp.ts');
      expect(scanner.getFileFindings('temp.ts').length).toBeGreaterThan(0);

      fs.unlinkSync(path.join(tmpDir, 'temp.ts'));
      scanner.scanFile('temp.ts');
      expect(scanner.getFileFindings('temp.ts')).toHaveLength(0);
    });
  });

  describe('findings API', () => {
    it('getAllFindings returns sorted by severity', () => {
      fs.writeFileSync(
        path.join(tmpDir, 'mixed.ts'),
        `const password = "supersecret";\n// TODO: fix\nconst x = 1;`,
      );
      scanner.scanFile('mixed.ts');
      const all = scanner.getAllFindings();
      // Errors should come first
      if (all.length >= 2) {
        expect(all[0].severity).toBe('error');
      }
    });

    it('getGroupedFindings groups by file', () => {
      fs.writeFileSync(path.join(tmpDir, 'a.ts'), '// TODO: task a');
      fs.writeFileSync(path.join(tmpDir, 'b.ts'), '// FIXME: task b');
      scanner.scanFile('a.ts');
      scanner.scanFile('b.ts');

      const grouped = scanner.getGroupedFindings();
      expect(grouped.size).toBe(2);
      expect(grouped.has('a.ts')).toBe(true);
      expect(grouped.has('b.ts')).toBe(true);
    });

    it('dismiss hides finding from getAllFindings', () => {
      fs.writeFileSync(path.join(tmpDir, 'dismiss.ts'), '// TODO: will dismiss');
      const findings = scanner.scanFile('dismiss.ts');
      expect(scanner.getAllFindings()).toHaveLength(1);

      const dismissed = scanner.dismiss(findings[0].id);
      expect(dismissed).toBe(true);
      expect(scanner.getAllFindings()).toHaveLength(0);
    });

    it('dismiss returns false for unknown id', () => {
      expect(scanner.dismiss('unknown_id')).toBe(false);
    });

    it('getCounts reports correct counts', () => {
      fs.writeFileSync(
        path.join(tmpDir, 'counts.ts'),
        `const password = "secret123";\n// TODO: fix\nconst x = 1;`,
      );
      scanner.scanFile('counts.ts');
      const counts = scanner.getCounts();
      expect(counts.error).toBeGreaterThanOrEqual(1);
      expect(counts.info).toBeGreaterThanOrEqual(1);
      expect(counts.total).toBe(counts.error + counts.warning + counts.info);
    });
  });

  describe('workspace scanning', () => {
    it('scans workspace collecting all findings', () => {
      fs.mkdirSync(path.join(tmpDir, 'src'), { recursive: true });
      fs.writeFileSync(path.join(tmpDir, 'src', 'app.ts'), '// TODO: implement');
      fs.writeFileSync(path.join(tmpDir, 'src', 'db.ts'), 'const secret = "pass123";');

      const findings = scanner.scanWorkspace();
      expect(findings.length).toBeGreaterThanOrEqual(1);
    });

    it('skips node_modules and .git', () => {
      fs.mkdirSync(path.join(tmpDir, 'node_modules', 'pkg'), { recursive: true });
      fs.writeFileSync(
        path.join(tmpDir, 'node_modules', 'pkg', 'index.ts'),
        'const secret = "should_skip";',
      );
      fs.mkdirSync(path.join(tmpDir, '.git', 'objects'), { recursive: true });
      fs.writeFileSync(path.join(tmpDir, 'src.ts'), 'export const ok = true;');

      const findings = scanner.scanWorkspace();
      const secretFindings = findings.filter((f) => f.filePath.includes('node_modules'));
      expect(secretFindings).toHaveLength(0);
    });
  });
});
