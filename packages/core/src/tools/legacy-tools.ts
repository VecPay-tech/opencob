import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Tool, ToolResult } from './types.js';

/** Reference found in legacy code */
export interface CodeReference {
  filePath: string;
  line: number;
  type: 'call' | 'copy' | 'include' | 'perform';
  target: string;
  context: string;
}

/** Creates the find_references tool for tracing CALL/COPY/INCLUDE chains */
export function createFindReferencesTool(workspaceRoot: string): Tool {
  return {
    name: 'find_references',
    group: 'read',
    description:
      'Trace CALL/COPY/INCLUDE/PERFORM dependency chains in legacy code (COBOL, RPG). Finds callers, callees, and copybook inclusions for a given program or paragraph name.',
    parameters: [
      {
        name: 'name',
        type: 'string',
        description: 'The program, paragraph, procedure, or copybook name to trace',
        required: true,
      },
      {
        name: 'direction',
        type: 'string',
        description:
          'Search direction: "callers" (who calls this), "callees" (what this calls), or "both" (default: both)',
        required: false,
      },
    ],
    async execute(params: Record<string, unknown>): Promise<ToolResult> {
      const name = (params.name as string)?.toUpperCase();
      if (!name) {
        return { success: false, content: 'Missing required parameter: name' };
      }

      const direction = (params.direction as string) ?? 'both';
      const references: CodeReference[] = [];

      // Scan workspace for legacy files
      const legacyFiles = collectLegacyFiles(workspaceRoot, workspaceRoot);

      for (const relPath of legacyFiles) {
        const fullPath = path.resolve(workspaceRoot, relPath);
        let content: string;
        try {
          content = fs.readFileSync(fullPath, 'utf-8');
        } catch {
          continue;
        }

        const lines = content.split('\n');
        for (let i = 0; i < lines.length; i++) {
          const line = lines[i];
          const upper = line.toUpperCase();
          const lineNum = i + 1;

          // COBOL: CALL 'PROGRAM'
          if (upper.includes('CALL') && upper.includes(name)) {
            const match = upper.match(/CALL\s+['"](\S+)['"]/);
            if (match && match[1] === name && (direction === 'callers' || direction === 'both')) {
              references.push({
                filePath: relPath,
                line: lineNum,
                type: 'call',
                target: name,
                context: line.trim(),
              });
            }
          }

          // COBOL: COPY copybook
          if (upper.includes('COPY') && upper.includes(name)) {
            const match = upper.match(/COPY\s+(\S+)/);
            if (match && match[1].replace('.', '') === name) {
              references.push({
                filePath: relPath,
                line: lineNum,
                type: 'copy',
                target: name,
                context: line.trim(),
              });
            }
          }

          // COBOL: PERFORM paragraph
          if (upper.includes('PERFORM') && upper.includes(name)) {
            const match = upper.match(/PERFORM\s+(\S+)/);
            if (match && match[1] === name) {
              references.push({
                filePath: relPath,
                line: lineNum,
                type: 'perform',
                target: name,
                context: line.trim(),
              });
            }
          }

          // RPG: /COPY or /INCLUDE
          if ((upper.includes('/COPY') || upper.includes('/INCLUDE')) && upper.includes(name)) {
            references.push({
              filePath: relPath,
              line: lineNum,
              type: 'copy',
              target: name,
              context: line.trim(),
            });
          }

          // RPG: CALLP or CALL
          if (upper.includes('CALLP') && upper.includes(name)) {
            references.push({
              filePath: relPath,
              line: lineNum,
              type: 'call',
              target: name,
              context: line.trim(),
            });
          }
        }
      }

      if (references.length === 0) {
        return { success: true, content: `No references found for "${name}".` };
      }

      const grouped = new Map<string, CodeReference[]>();
      for (const ref of references) {
        const key = ref.type;
        if (!grouped.has(key)) grouped.set(key, []);
        grouped.get(key)!.push(ref);
      }

      const output: string[] = [`## References for "${name}" (${references.length} found)`, ''];
      for (const [type, refs] of grouped) {
        output.push(`### ${type.toUpperCase()} references (${refs.length})`);
        for (const ref of refs) {
          output.push(`- ${ref.filePath}:${ref.line} — \`${ref.context}\``);
        }
        output.push('');
      }

      return {
        success: true,
        content: output.join('\n'),
        metadata: { totalReferences: references.length },
      };
    },
  };
}

/** Creates the show_impact_chain tool for transitive dependency analysis */
export function createShowImpactChainTool(workspaceRoot: string): Tool {
  return {
    name: 'show_impact_chain',
    group: 'read',
    description:
      'Show the transitive impact chain for a program or module — "what breaks if I change this?" Traces upstream (callers of callers) and downstream (callees of callees) dependencies.',
    parameters: [
      {
        name: 'name',
        type: 'string',
        description: 'The program, module, or file name to analyze',
        required: true,
      },
      {
        name: 'depth',
        type: 'number',
        description: 'Maximum depth of transitive traversal (default: 3)',
        required: false,
      },
    ],
    async execute(params: Record<string, unknown>): Promise<ToolResult> {
      const name = (params.name as string)?.toUpperCase();
      if (!name) {
        return { success: false, content: 'Missing required parameter: name' };
      }
      const maxDepth = (params.depth as number) ?? 3;

      // Build a simple call graph by scanning legacy files
      const callGraph = new Map<string, Set<string>>(); // caller → callees
      const reverseGraph = new Map<string, Set<string>>(); // callee → callers

      const legacyFiles = collectLegacyFiles(workspaceRoot, workspaceRoot);

      for (const relPath of legacyFiles) {
        const fullPath = path.resolve(workspaceRoot, relPath);
        let content: string;
        try {
          content = fs.readFileSync(fullPath, 'utf-8');
        } catch {
          continue;
        }

        const baseName = path.basename(relPath, path.extname(relPath)).toUpperCase();

        const lines = content.split('\n');
        for (const line of lines) {
          const upper = line.toUpperCase();

          // CALL statements
          const callMatch = upper.match(/CALL\s+['"](\S+)['"]/);
          if (callMatch) {
            const target = callMatch[1];
            if (!callGraph.has(baseName)) callGraph.set(baseName, new Set());
            callGraph.get(baseName)!.add(target);
            if (!reverseGraph.has(target)) reverseGraph.set(target, new Set());
            reverseGraph.get(target)!.add(baseName);
          }

          // COPY
          const copyMatch = upper.match(/COPY\s+(\S+)/);
          if (copyMatch) {
            const target = copyMatch[1].replace('.', '');
            if (!callGraph.has(baseName)) callGraph.set(baseName, new Set());
            callGraph.get(baseName)!.add(target);
            if (!reverseGraph.has(target)) reverseGraph.set(target, new Set());
            reverseGraph.get(target)!.add(baseName);
          }
        }
      }

      // BFS traversal
      const upstream = bfsTraverse(reverseGraph, name, maxDepth);
      const downstream = bfsTraverse(callGraph, name, maxDepth);

      const output: string[] = [`## Impact Chain for "${name}"`, ''];

      output.push(`### Upstream (${upstream.length} programs affected by changes to ${name})`);
      if (upstream.length === 0) {
        output.push('No upstream dependencies found.');
      } else {
        for (const item of upstream) {
          output.push(`${'  '.repeat(item.depth)}→ ${item.name} (depth ${item.depth})`);
        }
      }

      output.push('');
      output.push(`### Downstream (${downstream.length} programs that ${name} depends on)`);
      if (downstream.length === 0) {
        output.push('No downstream dependencies found.');
      } else {
        for (const item of downstream) {
          output.push(`${'  '.repeat(item.depth)}→ ${item.name} (depth ${item.depth})`);
        }
      }

      return {
        success: true,
        content: output.join('\n'),
        metadata: { upstream: upstream.length, downstream: downstream.length },
      };
    },
  };
}

// ── Helpers ──────────────────────────────────────────────────────

function collectLegacyFiles(dir: string, rootDir: string): string[] {
  const LEGACY_EXTS = new Set([
    '.cob',
    '.cbl',
    '.cpy',
    '.rpgle',
    '.rpg',
    '.sqlrpgle',
    '.pli',
    '.jcl',
  ]);
  const SKIP = new Set(['node_modules', '.git', 'dist', 'build', 'out']);
  const files: string[] = [];

  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return files;
  }

  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (SKIP.has(entry.name)) continue;
      files.push(...collectLegacyFiles(path.join(dir, entry.name), rootDir));
    } else if (entry.isFile()) {
      const ext = path.extname(entry.name).toLowerCase();
      if (LEGACY_EXTS.has(ext)) {
        files.push(path.relative(rootDir, path.join(dir, entry.name)));
      }
    }
  }
  return files;
}

interface TraversalNode {
  name: string;
  depth: number;
}

function bfsTraverse(
  graph: Map<string, Set<string>>,
  start: string,
  maxDepth: number,
): TraversalNode[] {
  const visited = new Set<string>([start]);
  const result: TraversalNode[] = [];
  let queue: Array<{ name: string; depth: number }> = [];

  const neighbors = graph.get(start);
  if (neighbors) {
    for (const n of neighbors) {
      queue.push({ name: n, depth: 1 });
    }
  }

  while (queue.length > 0) {
    const next: typeof queue = [];
    for (const item of queue) {
      if (visited.has(item.name) || item.depth > maxDepth) continue;
      visited.add(item.name);
      result.push(item);

      const itemNeighbors = graph.get(item.name);
      if (itemNeighbors) {
        for (const n of itemNeighbors) {
          if (!visited.has(n)) {
            next.push({ name: n, depth: item.depth + 1 });
          }
        }
      }
    }
    queue = next;
  }

  return result;
}
