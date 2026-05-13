import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { createListCodeDefinitionsTool } from '../src/tools/list-code-definitions.js';
import { createInsertContentTool } from '../src/tools/insert-content.js';
import { createAnalyzeCodeTool } from '../src/tools/analyze-code.js';
import { createGenerateDiagramTool } from '../src/tools/generate-diagram.js';

describe('list_code_definitions', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'OpenCob-lcd-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('extracts TypeScript definitions', async () => {
    fs.writeFileSync(
      path.join(tmpDir, 'test.ts'),
      `export class MyClass {
  private myMethod() {}
}
export function myFunction() {}
export interface MyInterface {}
export type MyType = string;
`,
    );
    const tool = createListCodeDefinitionsTool(tmpDir);
    const result = await tool.execute({ path: 'test.ts' });
    expect(result.success).toBe(true);
    expect(result.content).toContain('class MyClass');
    expect(result.content).toContain('function myFunction');
    expect(result.content).toContain('interface MyInterface');
    expect(result.content).toContain('type MyType');
  });

  it('extracts Python definitions', async () => {
    fs.writeFileSync(
      path.join(tmpDir, 'test.py'),
      `class MyClass:
    def my_method(self):
        pass

def my_function():
    pass
`,
    );
    const tool = createListCodeDefinitionsTool(tmpDir);
    const result = await tool.execute({ path: 'test.py' });
    expect(result.success).toBe(true);
    expect(result.content).toContain('class MyClass');
    expect(result.content).toContain('function my_function');
  });

  it('handles missing file', async () => {
    const tool = createListCodeDefinitionsTool(tmpDir);
    const result = await tool.execute({ path: 'nonexistent.ts' });
    expect(result.success).toBe(false);
    expect(result.content).toContain('not found');
  });

  it('rejects path traversal', async () => {
    const tool = createListCodeDefinitionsTool(tmpDir);
    const result = await tool.execute({ path: '../../../etc/passwd' });
    expect(result.success).toBe(false);
    expect(result.content).toContain('traversal');
  });

  it('returns empty for file with no definitions', async () => {
    fs.writeFileSync(path.join(tmpDir, 'empty.txt'), 'just some text\nno code here');
    const tool = createListCodeDefinitionsTool(tmpDir);
    const result = await tool.execute({ path: 'empty.txt' });
    expect(result.success).toBe(true);
    expect(result.content).toContain('No definitions');
  });
});

describe('insert_content', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'OpenCob-ins-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('inserts content at beginning of file', async () => {
    fs.writeFileSync(path.join(tmpDir, 'test.txt'), 'line1\nline2\nline3');
    const tool = createInsertContentTool(tmpDir);
    const result = await tool.execute({ path: 'test.txt', position: 0, content: 'header' });
    expect(result.success).toBe(true);
    const content = fs.readFileSync(path.join(tmpDir, 'test.txt'), 'utf-8');
    expect(content).toBe('header\nline1\nline2\nline3');
  });

  it('inserts content in the middle', async () => {
    fs.writeFileSync(path.join(tmpDir, 'test.txt'), 'line1\nline2\nline3');
    const tool = createInsertContentTool(tmpDir);
    const result = await tool.execute({ path: 'test.txt', position: 1, content: 'inserted' });
    expect(result.success).toBe(true);
    const content = fs.readFileSync(path.join(tmpDir, 'test.txt'), 'utf-8');
    expect(content).toBe('line1\ninserted\nline2\nline3');
  });

  it('inserts multi-line content', async () => {
    fs.writeFileSync(path.join(tmpDir, 'test.txt'), 'line1\nline2');
    const tool = createInsertContentTool(tmpDir);
    const result = await tool.execute({ path: 'test.txt', position: 1, content: 'a\nb\nc' });
    expect(result.success).toBe(true);
    const content = fs.readFileSync(path.join(tmpDir, 'test.txt'), 'utf-8');
    expect(content).toBe('line1\na\nb\nc\nline2');
  });

  it('handles missing file', async () => {
    const tool = createInsertContentTool(tmpDir);
    const result = await tool.execute({ path: 'missing.txt', position: 0, content: 'test' });
    expect(result.success).toBe(false);
    expect(result.content).toContain('not found');
  });
});

describe('analyze_code', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'OpenCob-ac-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns metrics for a TypeScript file', async () => {
    fs.writeFileSync(
      path.join(tmpDir, 'test.ts'),
      `// A comment
export function hello() {
  console.log("hello");
}

const x = 42;
`,
    );
    const tool = createAnalyzeCodeTool(tmpDir);
    const result = await tool.execute({ path: 'test.ts' });
    expect(result.success).toBe(true);
    expect(result.content).toContain('Code Analysis');
    expect(result.content).toContain('Total lines');
    expect(result.content).toContain('Code lines');
  });

  it('detects console.log as debug statement', async () => {
    fs.writeFileSync(
      path.join(tmpDir, 'debug.ts'),
      `function test() {
  console.log("debug");
}
`,
    );
    const tool = createAnalyzeCodeTool(tmpDir);
    const result = await tool.execute({ path: 'debug.ts' });
    expect(result.success).toBe(true);
    expect(result.content).toContain('Debug print statement');
  });

  it('detects hardcoded secrets', async () => {
    fs.writeFileSync(
      path.join(tmpDir, 'secrets.ts'),
      `const password = "my-secret-123";
`,
    );
    const tool = createAnalyzeCodeTool(tmpDir);
    const result = await tool.execute({ path: 'secrets.ts' });
    expect(result.success).toBe(true);
    expect(result.content).toContain('hardcoded secret');
  });

  it('handles missing file', async () => {
    const tool = createAnalyzeCodeTool(tmpDir);
    const result = await tool.execute({ path: 'missing.ts' });
    expect(result.success).toBe(false);
  });
});

describe('generate_diagram', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'OpenCob-diag-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('generates a dependency diagram', async () => {
    fs.writeFileSync(
      path.join(tmpDir, 'a.ts'),
      `import { foo } from './b.js';
export function bar() { return foo(); }
`,
    );
    fs.writeFileSync(path.join(tmpDir, 'b.ts'), `export function foo() { return 42; }\n`);

    const tool = createGenerateDiagramTool(tmpDir);
    const result = await tool.execute({ path: '.', type: 'dependency' });
    expect(result.success).toBe(true);
    expect(result.content).toContain('```mermaid');
    expect(result.content).toContain('graph TD');
  });

  it('generates a class diagram', async () => {
    fs.writeFileSync(
      path.join(tmpDir, 'classes.ts'),
      `export class Animal {
  speak() {}
}
export class Dog extends Animal {
  bark() {}
}
`,
    );
    const tool = createGenerateDiagramTool(tmpDir);
    const result = await tool.execute({ path: 'classes.ts', type: 'class' });
    expect(result.success).toBe(true);
    expect(result.content).toContain('classDiagram');
    expect(result.content).toContain('Animal');
    expect(result.content).toContain('Dog');
  });

  it('generates a structure diagram', async () => {
    fs.mkdirSync(path.join(tmpDir, 'src'));
    fs.writeFileSync(path.join(tmpDir, 'src', 'index.ts'), 'export const x = 1;');
    fs.writeFileSync(path.join(tmpDir, 'src', 'utils.ts'), 'export function y() {}');

    const tool = createGenerateDiagramTool(tmpDir);
    const result = await tool.execute({ path: '.', type: 'structure' });
    expect(result.success).toBe(true);
    expect(result.content).toContain('```mermaid');
    expect(result.content).toContain('subgraph');
  });

  it('handles missing path', async () => {
    const tool = createGenerateDiagramTool(tmpDir);
    const result = await tool.execute({ path: 'missing', type: 'dependency' });
    expect(result.success).toBe(false);
  });
});
