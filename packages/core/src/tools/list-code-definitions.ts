import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Tool, ToolResult } from './types.js';

/**
 * Extracts class, function, method, interface, and type definitions from a file.
 * Uses regex-based extraction for broad language support without Tree-sitter dependency.
 */
export function createListCodeDefinitionsTool(workspaceRoot: string): Tool {
  return {
    name: 'list_code_definitions',
    group: 'read',
    description:
      'Extract class, function, method, interface, and type definitions from a file. Returns names with line numbers.',
    parameters: [
      {
        name: 'path',
        type: 'string',
        description: 'File path relative to workspace root',
        required: true,
      },
    ],
    async execute(params: Record<string, unknown>): Promise<ToolResult> {
      const filePath = params.path as string;
      if (!filePath) {
        return { success: false, content: 'Error: path is required' };
      }

      const fullPath = path.resolve(workspaceRoot, filePath);
      if (!fullPath.startsWith(path.resolve(workspaceRoot))) {
        return { success: false, content: 'Error: path traversal not allowed' };
      }

      if (!fs.existsSync(fullPath)) {
        return { success: false, content: `Error: file not found: ${filePath}` };
      }

      const content = fs.readFileSync(fullPath, 'utf-8');
      const lines = content.split('\n');
      const definitions: Array<{ type: string; name: string; line: number }> = [];

      const ext = path.extname(filePath).toLowerCase();

      // Language-specific patterns
      const patterns = getPatterns(ext);
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        for (const pattern of patterns) {
          const match = line.match(pattern.regex);
          if (match && match[1]) {
            definitions.push({
              type: pattern.type,
              name: match[1],
              line: i + 1,
            });
          }
        }
      }

      if (definitions.length === 0) {
        return {
          success: true,
          content: `No definitions found in ${filePath}`,
          metadata: { path: filePath, count: 0 },
        };
      }

      const output = definitions.map((d) => `L${d.line}: ${d.type} ${d.name}`).join('\n');

      return {
        success: true,
        content: output,
        metadata: { path: filePath, count: definitions.length },
      };
    },
  };
}

interface DefinitionPattern {
  type: string;
  regex: RegExp;
}

function getPatterns(ext: string): DefinitionPattern[] {
  const tsJsPatterns: DefinitionPattern[] = [
    { type: 'class', regex: /^\s*(?:export\s+)?(?:abstract\s+)?class\s+(\w+)/ },
    { type: 'interface', regex: /^\s*(?:export\s+)?interface\s+(\w+)/ },
    { type: 'type', regex: /^\s*(?:export\s+)?type\s+(\w+)\s*[=<]/ },
    { type: 'enum', regex: /^\s*(?:export\s+)?(?:const\s+)?enum\s+(\w+)/ },
    { type: 'function', regex: /^\s*(?:export\s+)?(?:async\s+)?function\s+(\w+)/ },
    {
      type: 'const-fn',
      regex: /^\s*(?:export\s+)?const\s+(\w+)\s*=\s*(?:async\s+)?(?:\([^)]*\)|[a-zA-Z_]\w*)\s*=>/,
    },
    {
      type: 'method',
      regex: /^\s+(?:public\s+|private\s+|protected\s+)?(?:static\s+)?(?:async\s+)?(\w+)\s*\(/,
    },
  ];

  const pythonPatterns: DefinitionPattern[] = [
    { type: 'class', regex: /^class\s+(\w+)/ },
    { type: 'function', regex: /^def\s+(\w+)/ },
    { type: 'method', regex: /^\s+def\s+(\w+)/ },
  ];

  const javaPatterns: DefinitionPattern[] = [
    {
      type: 'class',
      regex:
        /^\s*(?:public\s+|private\s+|protected\s+)?(?:abstract\s+)?(?:static\s+)?class\s+(\w+)/,
    },
    { type: 'interface', regex: /^\s*(?:public\s+)?interface\s+(\w+)/ },
    { type: 'enum', regex: /^\s*(?:public\s+)?enum\s+(\w+)/ },
    {
      type: 'method',
      regex:
        /^\s+(?:public\s+|private\s+|protected\s+)?(?:static\s+)?(?:abstract\s+)?\w+\s+(\w+)\s*\(/,
    },
  ];

  const goPatterns: DefinitionPattern[] = [
    { type: 'function', regex: /^func\s+(\w+)/ },
    { type: 'method', regex: /^func\s+\(\w+\s+\*?\w+\)\s+(\w+)/ },
    { type: 'type', regex: /^type\s+(\w+)\s+(?:struct|interface)/ },
  ];

  const cobolPatterns: DefinitionPattern[] = [
    { type: 'program', regex: /^\s+PROGRAM-ID\.\s+(\S+)/i },
    { type: 'paragraph', regex: /^ {7}(\w[\w-]+)\.\s*$/ },
    { type: 'section', regex: /^ {7}(\w[\w-]+)\s+SECTION\.\s*$/i },
    { type: 'copy', regex: /^\s+COPY\s+(\S+)/i },
  ];

  const rpgPatterns: DefinitionPattern[] = [
    { type: 'procedure', regex: /^\s+dcl-proc\s+(\w+)/i },
    { type: 'subroutine', regex: /^\s+begsr\s+(\w+)/i },
    { type: 'data-structure', regex: /^\s+dcl-ds\s+(\w+)/i },
  ];

  switch (ext) {
    case '.ts':
    case '.tsx':
    case '.js':
    case '.jsx':
    case '.mjs':
    case '.mts':
      return tsJsPatterns;
    case '.py':
      return pythonPatterns;
    case '.java':
    case '.kt':
    case '.kts':
      return javaPatterns;
    case '.go':
      return goPatterns;
    case '.cob':
    case '.cbl':
    case '.cobol':
      return cobolPatterns;
    case '.rpg':
    case '.rpgle':
    case '.sqlrpgle':
      return rpgPatterns;
    default:
      return tsJsPatterns; // fallback
  }
}
