import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { FindingsScanner } from '../src/findings/findings-scanner.js';

describe('FindingsScanner', () => {
  let tmpDir: string;
  let scanner: FindingsScanner;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'OpenCob-findings-'));
    scanner = new FindingsScanner(tmpDir);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('detects hardcoded secrets', () => {
    fs.writeFileSync(
      path.join(tmpDir, 'secrets.ts'),
      `const password = "my-secret-value123";
const safe = "not a secret";
`,
    );
    const findings = scanner.scanFile('secrets.ts');
    expect(findings.some((f) => f.category === 'security')).toBe(true);
  });

  it('detects TODO/FIXME markers', () => {
    fs.writeFileSync(
      path.join(tmpDir, 'todos.ts'),
      `// TODO: implement this
function placeholder() {}
// FIXME: broken logic
`,
    );
    const findings = scanner.scanFile('todos.ts');
    const todos = findings.filter((f) => f.category === 'maintenance');
    expect(todos.length).toBeGreaterThanOrEqual(2);
  });

  it('detects commented-out code', () => {
    fs.writeFileSync(
      path.join(tmpDir, 'dead.ts'),
      `// const oldValue = 42;
const newValue = 99;
`,
    );
    const findings = scanner.scanFile('dead.ts');
    expect(findings.some((f) => f.category === 'dead-code')).toBe(true);
  });

  it('returns empty for clean file', () => {
    fs.writeFileSync(path.join(tmpDir, 'clean.ts'), `export const x = 42;\n`);
    const findings = scanner.scanFile('clean.ts');
    expect(findings).toHaveLength(0);
  });

  it('removes findings when file is deleted', () => {
    fs.writeFileSync(path.join(tmpDir, 'temp.ts'), `// TODO: fix\n`);
    scanner.scanFile('temp.ts');
    expect(scanner.getFileFindings('temp.ts').length).toBeGreaterThan(0);

    fs.unlinkSync(path.join(tmpDir, 'temp.ts'));
    scanner.scanFile('temp.ts');
    expect(scanner.getFileFindings('temp.ts')).toHaveLength(0);
  });

  it('dismisses a finding', () => {
    fs.writeFileSync(path.join(tmpDir, 'test.ts'), `// TODO: something\n`);
    const findings = scanner.scanFile('test.ts');
    expect(findings.length).toBeGreaterThan(0);

    const findingId = findings[0].id;
    scanner.dismiss(findingId);
    expect(scanner.getFileFindings('test.ts')).toHaveLength(0);
  });

  it('groups findings by file', () => {
    fs.writeFileSync(path.join(tmpDir, 'a.ts'), `// TODO: fix a\n`);
    fs.writeFileSync(path.join(tmpDir, 'b.ts'), `// FIXME: fix b\n`);
    scanner.scanFile('a.ts');
    scanner.scanFile('b.ts');

    const grouped = scanner.getGroupedFindings();
    expect(grouped.size).toBe(2);
  });

  it('returns correct counts', () => {
    fs.writeFileSync(
      path.join(tmpDir, 'mixed.ts'),
      `const password = "secret123";
// TODO: refactor
// const old = true;
`,
    );
    scanner.scanFile('mixed.ts');
    const counts = scanner.getCounts();
    expect(counts.total).toBeGreaterThan(0);
  });
});
