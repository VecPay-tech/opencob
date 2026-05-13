import * as vscode from 'vscode';
import type { LlmAdapter, RedactionEngine } from '@opencob/core';

const DEBOUNCE_MS = 300;
const MAX_PREFIX_CHARS = 8192; // ~2048 tokens
const MAX_SUFFIX_CHARS = 4096; // ~1024 tokens
const MAX_CROSS_FILE_CHARS = 2048; // ~512 tokens for import context

export class InlineCompletionProvider implements vscode.InlineCompletionItemProvider {
  private cancelTokenSource: vscode.CancellationTokenSource | null = null;
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private statusBarItem: vscode.StatusBarItem;

  constructor(
    private readonly llm: LlmAdapter,
    private readonly redactionEngine: RedactionEngine,
  ) {
    this.statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 99);
    this.statusBarItem.text = '$(loading~spin) OpenCob';
    this.statusBarItem.tooltip = 'OpenCob: Generating completion...';
  }

  async provideInlineCompletionItems(
    document: vscode.TextDocument,
    position: vscode.Position,
    context: vscode.InlineCompletionContext,
    token: vscode.CancellationToken,
  ): Promise<vscode.InlineCompletionItem[] | null> {
    // Cancel any previous request
    this.cancelTokenSource?.cancel();
    this.cancelTokenSource = new vscode.CancellationTokenSource();
    const localToken = this.cancelTokenSource.token;

    // Clear any pending debounce
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
    }

    // Debounce: wait before making request
    return new Promise((resolve) => {
      this.debounceTimer = setTimeout(async () => {
        if (token.isCancellationRequested || localToken.isCancellationRequested) {
          resolve(null);
          return;
        }

        try {
          const items = await this.getCompletion(document, position, localToken);
          resolve(items);
        } catch {
          resolve(null);
        }
      }, DEBOUNCE_MS);

      // Cancel on external cancellation
      token.onCancellationRequested(() => {
        if (this.debounceTimer) {
          clearTimeout(this.debounceTimer);
        }
        resolve(null);
      });
    });
  }

  private async getCompletion(
    document: vscode.TextDocument,
    position: vscode.Position,
    token: vscode.CancellationToken,
  ): Promise<vscode.InlineCompletionItem[] | null> {
    // Extract prefix (text before cursor)
    const prefixRange = new vscode.Range(
      new vscode.Position(Math.max(0, position.line - 100), 0),
      position,
    );
    let prefix = document.getText(prefixRange);
    if (prefix.length > MAX_PREFIX_CHARS) {
      prefix = prefix.slice(-MAX_PREFIX_CHARS);
    }

    // Extract suffix (text after cursor)
    const suffixRange = new vscode.Range(
      position,
      new vscode.Position(Math.min(document.lineCount - 1, position.line + 50), 0),
    );
    let suffix = document.getText(suffixRange);
    if (suffix.length > MAX_SUFFIX_CHARS) {
      suffix = suffix.slice(0, MAX_SUFFIX_CHARS);
    }

    // Don't complete if prefix is empty or very short
    if (prefix.trim().length < 3) {
      return null;
    }

    // Redact secrets before sending to LLM
    const redactedPrefix = this.redactionEngine.redact(prefix).redacted;
    const redactedSuffix = this.redactionEngine.redact(suffix).redacted;

    // Cross-file context: gather import/require context from related files (F2 Should)
    const crossFileContext = await this.gatherCrossFileContext(document);

    if (token.isCancellationRequested) return null;

    // Show status indicator
    this.statusBarItem.show();

    try {
      // Prepend cross-file context to prefix for richer FIM
      const enrichedPrefix = crossFileContext
        ? `// --- Related file context ---\n${crossFileContext}\n// --- Current file ---\n${redactedPrefix}`
        : redactedPrefix;

      const response = await this.llm.complete({
        prompt: enrichedPrefix,
        suffix: redactedSuffix,
        maxTokens: 256,
        temperature: 0.2,
        stop: ['\n\n\n', '<|endoftext|>'],
      });

      if (token.isCancellationRequested) return null;

      const completionText = response.text.trimEnd();
      if (!completionText) return null;

      return [
        new vscode.InlineCompletionItem(completionText, new vscode.Range(position, position)),
      ];
    } finally {
      this.statusBarItem.hide();
    }
  }

  dispose(): void {
    this.cancelTokenSource?.dispose();
    this.statusBarItem.dispose();
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
    }
  }

  /**
   * Gather cross-file context from imports/requires in the current document (F2 Should).
   * Includes type signatures and export declarations from imported files.
   */
  private async gatherCrossFileContext(document: vscode.TextDocument): Promise<string> {
    const text = document.getText();
    const importPaths: string[] = [];

    // Match import statements and require calls
    const importRegex =
      /(?:import\s+.*?\s+from\s+['"]([^'"]+)['"]|require\s*\(\s*['"]([^'"]+)['"]\s*\))/g;
    let match: RegExpExecArray | null;
    while ((match = importRegex.exec(text)) !== null) {
      const importPath = match[1] ?? match[2];
      if (importPath && !importPath.startsWith('.') === false) {
        importPaths.push(importPath);
      } else if (importPath?.startsWith('.')) {
        importPaths.push(importPath);
      }
    }

    if (importPaths.length === 0) return '';

    const snippets: string[] = [];
    let totalChars = 0;

    for (const importPath of importPaths.slice(0, 5)) {
      // Limit to 5 imports
      if (totalChars >= MAX_CROSS_FILE_CHARS) break;

      try {
        // Resolve relative imports
        const dir = vscode.Uri.joinPath(document.uri, '..');
        const extensions = ['.ts', '.tsx', '.js', '.jsx', '.py', '.java', ''];
        let resolvedDoc: vscode.TextDocument | undefined;

        for (const ext of extensions) {
          try {
            const uri = vscode.Uri.joinPath(dir, importPath + ext);
            resolvedDoc = await vscode.workspace.openTextDocument(uri);
            break;
          } catch {
            /* try next extension */
          }
        }

        if (!resolvedDoc) continue;

        // Extract export signatures (first 30 lines or export declarations)
        const lines = resolvedDoc.getText().split('\n');
        const exportLines = lines
          .filter((l) => /^export\s/.test(l.trim()))
          .slice(0, 10)
          .join('\n');

        if (exportLines) {
          const snippet = `// ${importPath}\n${exportLines}`;
          if (totalChars + snippet.length <= MAX_CROSS_FILE_CHARS) {
            snippets.push(snippet);
            totalChars += snippet.length;
          }
        }
      } catch {
        /* skip unresolvable imports */
      }
    }

    return snippets.join('\n');
  }
}
