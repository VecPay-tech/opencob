import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Tool, ToolResult } from './types.js';

type DiagramType = 'call-graph' | 'dependency' | 'structure' | 'class';

/**
 * Generate Mermaid diagrams from source code: call graph, dependency map, class diagram, etc.
 */
export function createGenerateDiagramTool(workspaceRoot: string): Tool {
  return {
    name: 'generate_diagram',
    group: 'read',
    description:
      'Generate a Mermaid diagram from source files. Supports: call-graph, dependency, structure, class.',
    parameters: [
      {
        name: 'path',
        type: 'string',
        description: 'File or directory path relative to workspace root',
        required: true,
      },
      {
        name: 'type',
        type: 'string',
        description: 'Diagram type: call-graph, dependency, structure, class',
        required: true,
      },
    ],
    async execute(params: Record<string, unknown>): Promise<ToolResult> {
      const filePath = params.path as string;
      const diagramType = params.type as DiagramType;

      if (!filePath) return { success: false, content: 'Error: path is required' };
      if (!diagramType) return { success: false, content: 'Error: type is required' };

      const fullPath = path.resolve(workspaceRoot, filePath);
      if (!fullPath.startsWith(path.resolve(workspaceRoot))) {
        return { success: false, content: 'Error: path traversal not allowed' };
      }

      if (!fs.existsSync(fullPath)) {
        return { success: false, content: `Error: path not found: ${filePath}` };
      }

      const stat = fs.statSync(fullPath);
      const files: string[] = [];
      if (stat.isDirectory()) {
        collectFiles(fullPath, files, 3); // max depth 3
      } else {
        files.push(fullPath);
      }

      const mermaid = generateMermaid(files, diagramType, workspaceRoot);

      return {
        success: true,
        content: mermaid,
        metadata: { type: diagramType, fileCount: files.length },
      };
    },
  };
}

function collectFiles(dir: string, files: string[], maxDepth: number, depth: number = 0): void {
  if (depth > maxDepth) return;
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (['node_modules', '.git', 'dist', '.OpenCob'].includes(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      collectFiles(full, files, maxDepth, depth + 1);
    } else if (/\.(ts|js|py|java|go|cob|cbl|rpg)$/i.test(entry.name)) {
      files.push(full);
    }
  }
}

function generateMermaid(files: string[], type: DiagramType, root: string): string {
  switch (type) {
    case 'dependency':
      return generateDependencyDiagram(files, root);
    case 'structure':
      return generateStructureDiagram(files, root);
    case 'class':
      return generateClassDiagram(files, root);
    case 'call-graph':
    default:
      return generateCallGraphDiagram(files, root);
  }
}

function generateDependencyDiagram(files: string[], root: string): string {
  const lines = ['graph TD'];
  const nodes = new Set<string>();
  const edges = new Set<string>();

  for (const file of files) {
    const content = fs.readFileSync(file, 'utf-8');
    const relPath = path.relative(root, file).replace(/\\/g, '/');
    const nodeId = sanitizeId(relPath);
    nodes.add(nodeId);

    // Extract imports
    const importRegex =
      /(?:import\s+.*from\s+['"]([^'"]+)['"]|require\s*\(\s*['"]([^'"]+)['"]\s*\))/g;
    let match;
    while ((match = importRegex.exec(content)) !== null) {
      const importPath = match[1] ?? match[2];
      if (importPath.startsWith('.')) {
        const resolved = path.resolve(path.dirname(file), importPath).replace(/\\/g, '/');
        const resolvedRel = path.relative(root, resolved).replace(/\\/g, '/');
        const targetId = sanitizeId(resolvedRel);
        edges.add(`  ${nodeId} --> ${targetId}`);
      }
    }
  }

  for (const nodeId of nodes) {
    lines.push(`  ${nodeId}["${unsanitizeId(nodeId)}"]`);
  }
  for (const edge of edges) {
    lines.push(edge);
  }

  return '```mermaid\n' + lines.join('\n') + '\n```';
}

function generateStructureDiagram(files: string[], root: string): string {
  const lines = ['graph TD'];
  const dirs = new Map<string, string[]>();

  for (const file of files) {
    const relPath = path.relative(root, file).replace(/\\/g, '/');
    const dir = path.dirname(relPath);
    const list = dirs.get(dir) ?? [];
    list.push(path.basename(relPath));
    dirs.set(dir, list);
  }

  for (const [dir, dirFiles] of dirs) {
    const dirId = sanitizeId(dir);
    lines.push(`  subgraph ${dirId}["${dir}"]`);
    for (const f of dirFiles.slice(0, 15)) {
      const fileId = sanitizeId(`${dir}/${f}`);
      lines.push(`    ${fileId}["${f}"]`);
    }
    if (dirFiles.length > 15) {
      lines.push(`    more_${dirId}["... +${dirFiles.length - 15} more"]`);
    }
    lines.push('  end');
  }

  return '```mermaid\n' + lines.join('\n') + '\n```';
}

function generateClassDiagram(files: string[], root: string): string {
  const lines = ['classDiagram'];

  for (const file of files) {
    const content = fs.readFileSync(file, 'utf-8');
    const classRegex =
      /(?:export\s+)?(?:abstract\s+)?class\s+(\w+)(?:\s+extends\s+(\w+))?(?:\s+implements\s+([\w,\s]+))?/g;
    let match;
    while ((match = classRegex.exec(content)) !== null) {
      const className = match[1];
      lines.push(`  class ${className}`);

      if (match[2]) {
        lines.push(`  ${match[2]} <|-- ${className}`);
      }
      if (match[3]) {
        const interfaces = match[3].split(',').map((s) => s.trim());
        for (const iface of interfaces) {
          lines.push(`  ${iface} <|.. ${className}`);
        }
      }

      // Extract methods from the class
      const methodRegex = new RegExp(
        `(?:public|private|protected)?\\s*(?:static\\s+)?(?:async\\s+)?(\\w+)\\s*\\(`,
        'g',
      );
      const contentLines = content.split('\n');
      const startLine = content.slice(0, match.index).split('\n').length - 1;
      let braceCount = 0;
      let started = false;
      for (let i = startLine; i < contentLines.length && i < startLine + 100; i++) {
        const line = contentLines[i];
        const opens = (line.match(/{/g) ?? []).length;
        const closes = (line.match(/}/g) ?? []).length;
        if (opens > 0) started = true;
        braceCount += opens - closes;

        const mMatch = line.match(
          /^\s+(?:public\s+|private\s+|protected\s+)?(?:static\s+)?(?:async\s+)?(\w+)\s*\(/,
        );
        if (mMatch && mMatch[1] !== 'constructor' && started) {
          lines.push(`  ${className} : +${mMatch[1]}()`);
        }

        if (started && braceCount <= 0) break;
      }
    }
  }

  if (lines.length === 1) {
    return '```mermaid\nclassDiagram\n  class NoClassesFound\n```';
  }

  return '```mermaid\n' + lines.join('\n') + '\n```';
}

function generateCallGraphDiagram(files: string[], root: string): string {
  const lines = ['graph LR'];
  const calls = new Set<string>();

  for (const file of files) {
    const content = fs.readFileSync(file, 'utf-8');
    const relPath = path.relative(root, file).replace(/\\/g, '/');

    // Extract function definitions and their calls
    const funcRegex =
      /(?:export\s+)?(?:async\s+)?function\s+(\w+)|(?:export\s+)?const\s+(\w+)\s*=\s*(?:async\s+)?/g;
    let match;
    while ((match = funcRegex.exec(content)) !== null) {
      const funcName = match[1] ?? match[2];
      if (!funcName) continue;

      const nodeId = sanitizeId(`${relPath}:${funcName}`);
      lines.push(`  ${nodeId}["${funcName}"]`);

      // Look for function calls within this function
      const afterFunc = content.slice(match.index);
      const callRegex = /\b(\w+)\s*\(/g;
      let callMatch;
      let lineCount = 0;
      while ((callMatch = callRegex.exec(afterFunc)) !== null && lineCount < 50) {
        const calledFunc = callMatch[1];
        if (
          ['if', 'for', 'while', 'switch', 'catch', 'return', 'new', funcName].includes(calledFunc)
        )
          continue;
        const targetId = sanitizeId(`call:${calledFunc}`);
        calls.add(`  ${nodeId} --> ${targetId}["${calledFunc}"]`);
        lineCount++;
      }
    }
  }

  for (const call of Array.from(calls).slice(0, 50)) {
    lines.push(call);
  }

  return '```mermaid\n' + lines.join('\n') + '\n```';
}

function sanitizeId(id: string): string {
  return id.replace(/[^a-zA-Z0-9]/g, '_');
}

function unsanitizeId(id: string): string {
  return id.replace(/_/g, '/');
}
