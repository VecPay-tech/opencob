import * as fs from 'node:fs';
import * as path from 'node:path';
import { FileFilter } from '../security/file-filter.js';

/** A code definition extracted from a source file */
export interface CodeDefinition {
  name: string;
  kind: 'class' | 'function' | 'method' | 'interface' | 'type' | 'variable' | 'procedure' | 'paragraph' | 'section' | 'subroutine' | 'data-structure';
  filePath: string;
  line: number;
  endLine?: number;
  signature?: string;
  language: string;
}

/** A dependency relationship between two files */
export interface FileDependency {
  sourceFile: string;
  targetFile: string;
  type: 'import' | 'require' | 'copy' | 'include';
}

/** A chunk of code for embedding */
export interface CodeChunk {
  id: string;
  filePath: string;
  startLine: number;
  endLine: number;
  content: string;
  language: string;
  definitionName?: string;
}

export interface IndexStatus {
  totalFiles: number;
  indexedFiles: number;
  isIndexing: boolean;
  lastIndexedAt?: number;
}

/** Language-specific patterns for extracting definitions */
interface LanguagePattern {
  extensions: string[];
  language: string;
  definitionPatterns: Array<{
    kind: CodeDefinition['kind'];
    regex: RegExp;
    nameGroup: number;
  }>;
  dependencyPatterns: Array<{
    type: FileDependency['type'];
    regex: RegExp;
    targetGroup: number;
  }>;
}

const LANGUAGE_PATTERNS: LanguagePattern[] = [
  {
    extensions: ['.ts', '.tsx'],
    language: 'typescript',
    definitionPatterns: [
      { kind: 'class', regex: /^(?:export\s+)?(?:abstract\s+)?class\s+(\w+)/m, nameGroup: 1 },
      { kind: 'interface', regex: /^(?:export\s+)?interface\s+(\w+)/m, nameGroup: 1 },
      { kind: 'type', regex: /^(?:export\s+)?type\s+(\w+)/m, nameGroup: 1 },
      { kind: 'function', regex: /^(?:export\s+)?(?:async\s+)?function\s+(\w+)/m, nameGroup: 1 },
      { kind: 'variable', regex: /^(?:export\s+)?(?:const|let)\s+(\w+)\s*=/m, nameGroup: 1 },
    ],
    dependencyPatterns: [
      { type: 'import', regex: /import\s+.*?from\s+['"](.+?)['"]/g, targetGroup: 1 },
      { type: 'require', regex: /require\s*\(\s*['"](.+?)['"]\s*\)/g, targetGroup: 1 },
    ],
  },
  {
    extensions: ['.js', '.jsx', '.mjs', '.cjs'],
    language: 'javascript',
    definitionPatterns: [
      { kind: 'class', regex: /^(?:export\s+)?class\s+(\w+)/m, nameGroup: 1 },
      { kind: 'function', regex: /^(?:export\s+)?(?:async\s+)?function\s+(\w+)/m, nameGroup: 1 },
      { kind: 'variable', regex: /^(?:export\s+)?(?:const|let|var)\s+(\w+)\s*=/m, nameGroup: 1 },
    ],
    dependencyPatterns: [
      { type: 'import', regex: /import\s+.*?from\s+['"](.+?)['"]/g, targetGroup: 1 },
      { type: 'require', regex: /require\s*\(\s*['"](.+?)['"]\s*\)/g, targetGroup: 1 },
    ],
  },
  {
    extensions: ['.py'],
    language: 'python',
    definitionPatterns: [
      { kind: 'class', regex: /^class\s+(\w+)/m, nameGroup: 1 },
      { kind: 'function', regex: /^(?:async\s+)?def\s+(\w+)/m, nameGroup: 1 },
    ],
    dependencyPatterns: [
      { type: 'import', regex: /^(?:from\s+(\S+)\s+)?import/gm, targetGroup: 1 },
    ],
  },
  {
    extensions: ['.java'],
    language: 'java',
    definitionPatterns: [
      { kind: 'class', regex: /^(?:public\s+)?(?:abstract\s+)?class\s+(\w+)/m, nameGroup: 1 },
      { kind: 'interface', regex: /^(?:public\s+)?interface\s+(\w+)/m, nameGroup: 1 },
      { kind: 'method', regex: /^\s+(?:public|private|protected)\s+.*?\s+(\w+)\s*\(/m, nameGroup: 1 },
    ],
    dependencyPatterns: [
      { type: 'import', regex: /^import\s+([\w.]+)/gm, targetGroup: 1 },
    ],
  },
  {
    extensions: ['.go'],
    language: 'go',
    definitionPatterns: [
      { kind: 'function', regex: /^func\s+(\w+)/m, nameGroup: 1 },
      { kind: 'type', regex: /^type\s+(\w+)\s+struct/m, nameGroup: 1 },
      { kind: 'interface', regex: /^type\s+(\w+)\s+interface/m, nameGroup: 1 },
    ],
    dependencyPatterns: [
      { type: 'import', regex: /import\s+"(.+?)"/g, targetGroup: 1 },
    ],
  },
  {
    extensions: ['.rs'],
    language: 'rust',
    definitionPatterns: [
      { kind: 'function', regex: /^(?:pub\s+)?(?:async\s+)?fn\s+(\w+)/m, nameGroup: 1 },
      { kind: 'type', regex: /^(?:pub\s+)?struct\s+(\w+)/m, nameGroup: 1 },
      { kind: 'interface', regex: /^(?:pub\s+)?trait\s+(\w+)/m, nameGroup: 1 },
    ],
    dependencyPatterns: [
      { type: 'import', regex: /^use\s+([\w:]+)/gm, targetGroup: 1 },
    ],
  },
  {
    extensions: ['.cs'],
    language: 'csharp',
    definitionPatterns: [
      { kind: 'class', regex: /^(?:\s*(?:public|internal|private)\s+)?(?:abstract\s+)?class\s+(\w+)/m, nameGroup: 1 },
      { kind: 'interface', regex: /^(?:\s*(?:public|internal)\s+)?interface\s+(\w+)/m, nameGroup: 1 },
    ],
    dependencyPatterns: [
      { type: 'import', regex: /^using\s+([\w.]+)/gm, targetGroup: 1 },
    ],
  },
];

/**
 * Workspace Indexer — parses and indexes workspace files for
 * code definitions, dependencies, and content chunks for RAG.
 */
export class WorkspaceIndexer {
  private workspaceRoot: string;
  private fileFilter: FileFilter | null;
  private definitions: Map<string, CodeDefinition[]> = new Map();
  private dependencies: FileDependency[] = [];
  private chunks: Map<string, CodeChunk[]> = new Map();
  private status: IndexStatus = {
    totalFiles: 0,
    indexedFiles: 0,
    isIndexing: false,
  };
  private onProgressCallback: ((status: IndexStatus) => void) | null = null;

  constructor(workspaceRoot: string, fileFilter?: FileFilter) {
    this.workspaceRoot = workspaceRoot;
    this.fileFilter = fileFilter ?? null;
  }

  /** Set a progress callback */
  onProgress(callback: (status: IndexStatus) => void): void {
    this.onProgressCallback = callback;
  }

  /** Full workspace index */
  async indexWorkspace(): Promise<IndexStatus> {
    this.status.isIndexing = true;
    this.emitProgress();

    const files = this.collectFiles(this.workspaceRoot);
    this.status.totalFiles = files.length;
    this.emitProgress();

    this.definitions.clear();
    this.dependencies = [];
    this.chunks.clear();

    for (const file of files) {
      this.indexFile(file);
      this.status.indexedFiles++;
      // Emit progress every 50 files to avoid excessive callbacks
      if (this.status.indexedFiles % 50 === 0) {
        this.emitProgress();
      }
    }

    this.status.isIndexing = false;
    this.status.lastIndexedAt = Date.now();
    this.emitProgress();
    return this.status;
  }

  /** Incrementally re-index a single file */
  reindexFile(relPath: string): void {
    // Remove old data for this file
    this.definitions.delete(relPath);
    this.chunks.delete(relPath);
    this.dependencies = this.dependencies.filter(
      (d) => d.sourceFile !== relPath,
    );

    // Re-index
    const fullPath = path.resolve(this.workspaceRoot, relPath);
    if (fs.existsSync(fullPath)) {
      this.indexFile(relPath);
    }

    this.status.lastIndexedAt = Date.now();
  }

  /** Get definitions for a file */
  getDefinitions(filePath: string): CodeDefinition[] {
    return this.definitions.get(filePath) ?? [];
  }

  /** Get all definitions across the workspace */
  getAllDefinitions(): CodeDefinition[] {
    const all: CodeDefinition[] = [];
    for (const defs of this.definitions.values()) {
      all.push(...defs);
    }
    return all;
  }

  /** Search definitions by name */
  searchDefinitions(query: string): CodeDefinition[] {
    const lower = query.toLowerCase();
    return this.getAllDefinitions().filter(
      (d) => d.name.toLowerCase().includes(lower),
    );
  }

  /** Get dependencies for a file */
  getFileDependencies(filePath: string): FileDependency[] {
    return this.dependencies.filter((d) => d.sourceFile === filePath);
  }

  /** Get files that depend on a given file */
  getDependents(filePath: string): FileDependency[] {
    return this.dependencies.filter((d) => d.targetFile === filePath);
  }

  /** Get all code chunks for RAG embedding */
  getAllChunks(): CodeChunk[] {
    const all: CodeChunk[] = [];
    for (const chunks of this.chunks.values()) {
      all.push(...chunks);
    }
    return all;
  }

  /** Get chunks for a specific file */
  getFileChunks(filePath: string): CodeChunk[] {
    return this.chunks.get(filePath) ?? [];
  }

  /** Get index status */
  getStatus(): IndexStatus {
    return { ...this.status };
  }

  // ── Private ─────────────────────────────────────────────────

  private indexFile(relPath: string): void {
    const fullPath = path.resolve(this.workspaceRoot, relPath);
    if (!fs.existsSync(fullPath)) return;

    const stat = fs.statSync(fullPath);
    if (stat.size > 1_000_000) return; // skip files > 1MB

    let content: string;
    try {
      content = fs.readFileSync(fullPath, 'utf-8');
    } catch {
      return; // skip unreadable files
    }

    const ext = path.extname(relPath).toLowerCase();
    const pattern = LANGUAGE_PATTERNS.find((p) => p.extensions.includes(ext));
    const language = pattern?.language ?? ext.slice(1);

    // Extract definitions
    const fileDefs = this.extractDefinitions(content, relPath, pattern);
    if (fileDefs.length > 0) {
      this.definitions.set(relPath, fileDefs);
    }

    // Extract dependencies
    if (pattern) {
      const fileDeps = this.extractDependencies(content, relPath, pattern);
      this.dependencies.push(...fileDeps);
    }

    // Create chunks for RAG
    const fileChunks = this.createChunks(content, relPath, language);
    if (fileChunks.length > 0) {
      this.chunks.set(relPath, fileChunks);
    }
  }

  private extractDefinitions(
    content: string,
    filePath: string,
    pattern: LanguagePattern | undefined,
  ): CodeDefinition[] {
    const defs: CodeDefinition[] = [];
    if (!pattern) return defs;

    const lines = content.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      for (const p of pattern.definitionPatterns) {
        const match = p.regex.exec(line);
        if (match) {
          defs.push({
            name: match[p.nameGroup],
            kind: p.kind,
            filePath,
            line: i + 1,
            signature: line.trim(),
            language: pattern.language,
          });
        }
      }
    }
    return defs;
  }

  private extractDependencies(
    content: string,
    filePath: string,
    pattern: LanguagePattern,
  ): FileDependency[] {
    const deps: FileDependency[] = [];
    for (const dp of pattern.dependencyPatterns) {
      const regex = new RegExp(dp.regex.source, dp.regex.flags);
      let match;
      while ((match = regex.exec(content)) !== null) {
        const target = match[dp.targetGroup];
        if (target) {
          deps.push({
            sourceFile: filePath,
            targetFile: target,
            type: dp.type,
          });
        }
      }
    }
    return deps;
  }

  /** Split file into chunks for embedding (by definitions or fixed-size) */
  private createChunks(
    content: string,
    filePath: string,
    language: string,
  ): CodeChunk[] {
    const lines = content.split('\n');
    const chunks: CodeChunk[] = [];
    const CHUNK_SIZE = 50; // lines per chunk

    for (let i = 0; i < lines.length; i += CHUNK_SIZE) {
      const end = Math.min(i + CHUNK_SIZE, lines.length);
      const chunkLines = lines.slice(i, end);
      const chunkContent = chunkLines.join('\n');
      if (chunkContent.trim().length === 0) continue;

      chunks.push({
        id: `${filePath}:${i + 1}-${end}`,
        filePath,
        startLine: i + 1,
        endLine: end,
        content: chunkContent,
        language,
      });
    }
    return chunks;
  }

  /** Collect all indexable files recursively */
  private collectFiles(dir: string, base: string = ''): string[] {
    const files: string[] = [];
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return files;
    }

    for (const entry of entries) {
      const relPath = base ? `${base}/${entry.name}` : entry.name;
      const fullPath = path.join(dir, entry.name);

      // Skip common non-source directories
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue;
        files.push(...this.collectFiles(fullPath, relPath));
        continue;
      }

      if (!entry.isFile()) continue;

      // Apply file filter
      if (this.fileFilter && !this.fileFilter.isAllowed(relPath)) continue;

      // Only index known source file extensions
      const ext = path.extname(entry.name).toLowerCase();
      if (!INDEXABLE_EXTENSIONS.has(ext)) continue;

      files.push(relPath);
    }
    return files;
  }

  private emitProgress(): void {
    if (this.onProgressCallback) {
      this.onProgressCallback(this.getStatus());
    }
  }
}

const SKIP_DIRS = new Set([
  'node_modules', '.git', '.OpenCob', 'dist', 'build', 'out',
  '.next', '.nuxt', '__pycache__', '.venv', 'venv', 'target',
  'bin', 'obj', '.idea', '.vscode', '.shadow-git',
]);

const INDEXABLE_EXTENSIONS = new Set([
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs',
  '.py', '.java', '.kt', '.go', '.rs', '.cs',
  '.c', '.cpp', '.h', '.hpp', '.rb', '.php',
  '.swift', '.scala', '.lua', '.r', '.R',
  '.sql', '.sh', '.bash', '.zsh', '.ps1',
  '.yaml', '.yml', '.json', '.toml', '.xml',
  '.md', '.mdx', '.txt', '.cfg', '.ini',
  // Legacy languages
  '.cob', '.cbl', '.cpy', '.rpgle', '.rpg', '.sqlrpgle',
  '.pli', '.pl1', '.jcl', '.proc', '.nat', '.rexx',
]);
