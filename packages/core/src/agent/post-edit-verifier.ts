import * as fs from 'node:fs/promises';
import * as path from 'node:path';

export interface VerificationResult {
  filePath: string;
  valid: boolean;
  errors: string[];
}

/**
 * F6.4 Post-edit verification — After every write tool,
 * auto-check syntax validity and report failures to the agent.
 */
export class PostEditVerifier {
  constructor(private readonly workspaceRoot: string) {}

  /** Verify a file after modification. Returns syntax errors if any. */
  async verify(relPath: string): Promise<VerificationResult> {
    const absPath = path.resolve(this.workspaceRoot, relPath);
    const result: VerificationResult = {
      filePath: relPath,
      valid: true,
      errors: [],
    };

    try {
      const content = await fs.readFile(absPath, 'utf-8');
      const ext = path.extname(relPath).toLowerCase();

      switch (ext) {
        case '.json':
          this.verifyJSON(content, result);
          break;
        case '.ts':
        case '.tsx':
        case '.js':
        case '.jsx':
        case '.mjs':
        case '.cjs':
          this.verifyJavaScript(content, result);
          break;
        case '.py':
          this.verifyPython(content, result);
          break;
        case '.yaml':
        case '.yml':
          this.verifyYAML(content, result);
          break;
        case '.xml':
        case '.html':
        case '.htm':
          this.verifyXML(content, result);
          break;
      }
    } catch {
      // File might not exist (deleted) — skip
    }

    return result;
  }

  private verifyJSON(content: string, result: VerificationResult): void {
    try {
      JSON.parse(content);
    } catch (e) {
      result.valid = false;
      result.errors.push(`JSON syntax error: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  private verifyJavaScript(content: string, result: VerificationResult): void {
    // Check for common syntax issues without a full parser
    const issues: string[] = [];

    // Unmatched brackets/braces/parens
    const brackets = this.checkBracketBalance(content);
    if (brackets) issues.push(brackets);

    // Unterminated string literals on non-template lines
    const lines = content.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      // Skip template literal lines and comments
      if (line.includes('`')) continue;
      if (line.trim().startsWith('//')) continue;
      if (line.trim().startsWith('*')) continue;

      // Check for obvious unterminated strings
      const singleQuotes = (line.match(/(?<!\\)'/g) || []).length;
      const doubleQuotes = (line.match(/(?<!\\)"/g) || []).length;
      if (singleQuotes % 2 !== 0 && !line.includes('`') && !line.trim().startsWith('//')) {
        issues.push(`Line ${i + 1}: possible unterminated string literal`);
      }
      if (doubleQuotes % 2 !== 0 && !line.includes('`') && !line.trim().startsWith('//')) {
        issues.push(`Line ${i + 1}: possible unterminated string literal`);
      }
    }

    if (issues.length > 0) {
      result.valid = false;
      result.errors.push(...issues.slice(0, 5)); // Limit to 5 issues
    }
  }

  private verifyPython(content: string, result: VerificationResult): void {
    // Basic indentation check
    const lines = content.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (line.trim() === '' || line.trim().startsWith('#')) continue;

      const indent = line.match(/^(\s*)/)?.[1] ?? '';
      // Mixed tabs and spaces
      if (indent.includes('\t') && indent.includes(' ')) {
        result.valid = false;
        result.errors.push(`Line ${i + 1}: mixed tabs and spaces in indentation`);
        break;
      }
    }

    const brackets = this.checkBracketBalance(content);
    if (brackets) {
      result.valid = false;
      result.errors.push(brackets);
    }
  }

  private verifyYAML(content: string, result: VerificationResult): void {
    // Basic YAML validation — check for tab indentation (invalid in YAML)
    const lines = content.split('\n');
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].includes('\t')) {
        result.valid = false;
        result.errors.push(`Line ${i + 1}: YAML does not allow tab characters for indentation`);
        break;
      }
    }
  }

  private verifyXML(content: string, result: VerificationResult): void {
    // Check for unclosed tags
    const openTags: string[] = [];
    const tagRegex = /<\/?([a-zA-Z][\w.-]*)[^>]*\/?>/g;
    let match: RegExpExecArray | null;

    while ((match = tagRegex.exec(content)) !== null) {
      const full = match[0];
      const tag = match[1];
      if (full.startsWith('</')) {
        if (openTags.length > 0 && openTags[openTags.length - 1] === tag) {
          openTags.pop();
        }
      } else if (!full.endsWith('/>')) {
        openTags.push(tag);
      }
    }

    if (openTags.length > 0) {
      result.valid = false;
      result.errors.push(`Unclosed XML tags: ${openTags.slice(0, 5).join(', ')}`);
    }
  }

  private checkBracketBalance(content: string): string | null {
    const stack: Array<{ char: string; line: number }> = [];
    const pairs: Record<string, string> = { '(': ')', '[': ']', '{': '}' };
    const closing = new Set([')', ']', '}']);
    const lines = content.split('\n');
    let inString = false;
    let stringChar = '';
    const inComment = false;
    let inBlockComment = false;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      for (let j = 0; j < line.length; j++) {
        const ch = line[j];
        const prev = j > 0 ? line[j - 1] : '';
        const next = j < line.length - 1 ? line[j + 1] : '';

        // Handle block comments
        if (!inString && !inComment && ch === '/' && next === '*') {
          inBlockComment = true;
          j++;
          continue;
        }
        if (inBlockComment && ch === '*' && next === '/') {
          inBlockComment = false;
          j++;
          continue;
        }
        if (inBlockComment) continue;

        // Handle line comments
        if (!inString && ch === '/' && next === '/') {
          break; // rest of line is comment
        }
        if (!inString && ch === '#') {
          break; // Python/Shell comment
        }

        // Handle strings
        if (!inString && (ch === '"' || ch === "'" || ch === '`')) {
          inString = true;
          stringChar = ch;
          continue;
        }
        if (inString && ch === stringChar && prev !== '\\') {
          inString = false;
          continue;
        }
        if (inString) continue;

        // Handle brackets
        if (ch in pairs) {
          stack.push({ char: ch, line: i + 1 });
        } else if (closing.has(ch)) {
          if (stack.length === 0) {
            return `Line ${i + 1}: unexpected closing '${ch}'`;
          }
          const top = stack.pop()!;
          if (pairs[top.char] !== ch) {
            return `Line ${i + 1}: mismatched bracket — expected '${pairs[top.char]}', found '${ch}'`;
          }
        }
      }
    }

    if (stack.length > 0) {
      const first = stack[0];
      return `Line ${first.line}: unclosed '${first.char}'`;
    }
    return null;
  }
}
