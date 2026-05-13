/**
 * Literate Coding (F18) — allows writing natural language instructions
 * directly in source files, then generating code in place.
 *
 * Literate blocks are delimited with special markers:
 *   // @OpenCob: <natural language instruction>
 *   # @OpenCob: <natural language instruction>  (for Python/Ruby/Shell)
 *
 * The LLM receives the surrounding code + literate blocks and generates
 * replacement code that is shown as an inline diff.
 */

export interface LiterateBlock {
  text: string;
  line: number;
  endLine: number;
  language: string;
  prefix: string;  // code before the block
  suffix: string;  // code after the block
}

export interface LiterateResult {
  originalBlock: LiterateBlock;
  generatedCode: string;
}

/** Markers that identify literate coding blocks */
const LITERATE_MARKERS = [
  { pattern: /^(\s*)\/\/\s*@OpenCob:\s*(.+)$/i, commentStyle: '//' },
  { pattern: /^(\s*)#\s*@OpenCob:\s*(.+)$/i, commentStyle: '#' },
  { pattern: /^(\s*)--\s*@OpenCob:\s*(.+)$/i, commentStyle: '--' },
  { pattern: /^(\s*)\/\*\s*@OpenCob:\s*(.+?)\s*\*\/$/i, commentStyle: '/*' },
];

/**
 * Literate Coding Engine — detects, extracts, and processes
 * natural language blocks embedded in source code.
 */
export class LiterateCodingEngine {

  /** Detect all literate blocks in a document */
  detectBlocks(content: string, language: string): LiterateBlock[] {
    const lines = content.split('\n');
    const blocks: LiterateBlock[] = [];
    let i = 0;

    while (i < lines.length) {
      const match = this.matchLiterateLine(lines[i]);
      if (match) {
        // Collect consecutive literate lines
        const startLine = i;
        const textParts: string[] = [match.text];

        let j = i + 1;
        while (j < lines.length) {
          const nextMatch = this.matchLiterateLine(lines[j]);
          if (nextMatch) {
            textParts.push(nextMatch.text);
            j++;
          } else {
            break;
          }
        }

        // Get surrounding context (up to 20 lines each)
        const prefixStart = Math.max(0, startLine - 20);
        const prefix = lines.slice(prefixStart, startLine).join('\n');
        const suffixEnd = Math.min(lines.length, j + 20);
        const suffix = lines.slice(j, suffixEnd).join('\n');

        blocks.push({
          text: textParts.join(' '),
          line: startLine + 1,
          endLine: j,
          language,
          prefix,
          suffix,
        });

        i = j;
      } else {
        i++;
      }
    }

    return blocks;
  }

  /** Build a prompt for the LLM to generate code from a literate block */
  buildPrompt(block: LiterateBlock): string {
    return [
      `You are generating code in ${block.language}. Replace the natural language instruction with working code.`,
      '',
      'Context BEFORE the instruction:',
      '```' + block.language,
      block.prefix,
      '```',
      '',
      `Instruction: ${block.text}`,
      '',
      'Context AFTER the instruction:',
      '```' + block.language,
      block.suffix,
      '```',
      '',
      'Generate ONLY the code that replaces the instruction. No explanation, no markdown fences.',
      'Match the indentation and style of the surrounding code.',
    ].join('\n');
  }

  /** Apply a literate result back to the document */
  applyResult(content: string, result: LiterateResult): string {
    const lines = content.split('\n');
    const before = lines.slice(0, result.originalBlock.line - 1);
    const after = lines.slice(result.originalBlock.endLine);
    const generated = result.generatedCode.split('\n');

    return [...before, ...generated, ...after].join('\n');
  }

  /** Check if a document contains any literate blocks */
  hasLiterateBlocks(content: string): boolean {
    const lines = content.split('\n');
    return lines.some((line) => this.matchLiterateLine(line) !== null);
  }

  // ── Private ─────────────────────────────────────────────────

  private matchLiterateLine(line: string): { text: string; indent: string } | null {
    for (const marker of LITERATE_MARKERS) {
      const match = marker.pattern.exec(line);
      if (match) {
        return { text: match[2].trim(), indent: match[1] };
      }
    }
    return null;
  }
}
