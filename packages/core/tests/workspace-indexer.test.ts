import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { WorkspaceIndexer } from '../src/indexer/workspace-indexer.js';

describe('WorkspaceIndexer', () => {
  let tmpDir: string;
  let indexer: WorkspaceIndexer;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'OpenCob-indexer-'));
    indexer = new WorkspaceIndexer(tmpDir);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('indexes TypeScript files and extracts definitions', async () => {
    fs.writeFileSync(
      path.join(tmpDir, 'main.ts'),
      `export class UserService {\n  async getUser(id: string) {\n    return id;\n  }\n}\n\nexport function helper() {}\n\nexport interface Config { key: string; }\n`,
    );

    await indexer.indexWorkspace();

    const defs = indexer.getDefinitions('main.ts');
    expect(defs.length).toBeGreaterThanOrEqual(2);
    expect(defs.some((d) => d.name === 'UserService' && d.kind === 'class')).toBe(true);
    expect(defs.some((d) => d.name === 'helper' && d.kind === 'function')).toBe(true);
  });

  it('extracts import dependencies', async () => {
    fs.writeFileSync(
      path.join(tmpDir, 'app.ts'),
      `import { UserService } from './user-service.js';\nimport { Config } from './config.js';\n`,
    );

    await indexer.indexWorkspace();

    const deps = indexer.getFileDependencies('app.ts');
    expect(deps.length).toBe(2);
    expect(deps[0].type).toBe('import');
  });

  it('creates code chunks for RAG', async () => {
    const lines = Array.from({ length: 100 }, (_, i) => `// line ${i + 1}`);
    fs.writeFileSync(path.join(tmpDir, 'big.ts'), lines.join('\n'));

    await indexer.indexWorkspace();

    const chunks = indexer.getFileChunks('big.ts');
    expect(chunks.length).toBe(2); // 100 lines / 50 = 2 chunks
    expect(chunks[0].startLine).toBe(1);
  });

  it('incrementally re-indexes a file', async () => {
    fs.writeFileSync(path.join(tmpDir, 'utils.ts'), 'export function foo() {}\n');
    await indexer.indexWorkspace();

    expect(indexer.getDefinitions('utils.ts').length).toBe(1);

    // Modify file
    fs.writeFileSync(
      path.join(tmpDir, 'utils.ts'),
      'export function foo() {}\nexport function bar() {}\n',
    );
    indexer.reindexFile('utils.ts');

    const defs = indexer.getDefinitions('utils.ts');
    expect(defs.length).toBe(2);
  });

  it('searches definitions by name', async () => {
    fs.writeFileSync(path.join(tmpDir, 'a.ts'), 'export class UserRepository {}\n');
    fs.writeFileSync(path.join(tmpDir, 'b.ts'), 'export function userHelper() {}\n');
    await indexer.indexWorkspace();

    const results = indexer.searchDefinitions('user');
    expect(results.length).toBe(2);
  });

  it('skips node_modules and .git directories', async () => {
    fs.mkdirSync(path.join(tmpDir, 'node_modules', 'pkg'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, 'node_modules', 'pkg', 'index.ts'), 'export const x = 1;');
    fs.writeFileSync(path.join(tmpDir, 'src.ts'), 'export const y = 2;');

    await indexer.indexWorkspace();

    const status = indexer.getStatus();
    expect(status.indexedFiles).toBe(1);
  });

  it('reports progress during indexing', async () => {
    fs.writeFileSync(path.join(tmpDir, 'a.ts'), 'export const a = 1;');
    fs.writeFileSync(path.join(tmpDir, 'b.ts'), 'export const b = 2;');

    let lastStatus: any = null;
    indexer.onProgress((s) => {
      lastStatus = s;
    });
    await indexer.indexWorkspace();

    expect(lastStatus).not.toBeNull();
    expect(lastStatus.isIndexing).toBe(false);
    expect(lastStatus.indexedFiles).toBe(2);
  });

  it('supports Python definitions', async () => {
    fs.writeFileSync(
      path.join(tmpDir, 'service.py'),
      'class OrderService:\n    def process(self, order):\n        pass\n',
    );

    await indexer.indexWorkspace();
    const defs = indexer.getDefinitions('service.py');
    expect(defs.some((d) => d.name === 'OrderService' && d.kind === 'class')).toBe(true);
  });
});
