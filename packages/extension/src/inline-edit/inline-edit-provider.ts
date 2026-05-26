import * as vscode from 'vscode';
import type { AgentLoop, RedactionEngine } from '@opencob/core';

/**
 * Inline Edit Provider (§8.4.2 of DESIGN.md)
 *
 * Implements Cmd+I inline editing: user selects code, types an instruction,
 * and the agent applies a targeted edit with diff preview.
 */
export class InlineEditProvider implements vscode.Disposable {
  private decorationType: vscode.TextEditorDecorationType;
  private pendingEdit: {
    editor: vscode.TextEditor;
    range: vscode.Range;
    originalText: string;
    newText?: string;
  } | null = null;

  constructor(
    private readonly agentLoop: AgentLoop,
    private readonly redactionEngine: RedactionEngine,
  ) {
    this.decorationType = vscode.window.createTextEditorDecorationType({
      backgroundColor: 'rgba(100, 200, 100, 0.15)',
      border: '1px dashed rgba(100, 200, 100, 0.6)',
      isWholeLine: false,
    });
  }

  /**
   * Trigger inline edit for the current selection.
   * Shows an input box for the user's instruction, processes it through the agent,
   * and previews the diff inline.
   */
  async triggerInlineEdit(): Promise<void> {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      vscode.window.showWarningMessage('OpenCob: No active editor for inline edit.');
      return;
    }

    const selection = editor.selection;
    if (selection.isEmpty) {
      vscode.window.showWarningMessage('OpenCob: Select code to edit inline.');
      return;
    }

    const selectedText = editor.document.getText(selection);
    const language = editor.document.languageId;
    const filePath = vscode.workspace.asRelativePath(editor.document.uri);

    // Get user instruction
    const instruction = await vscode.window.showInputBox({
      prompt: 'Describe the edit to apply to the selected code',
      placeHolder: 'e.g., Add error handling, Refactor to async/await, Fix the bug...',
    });

    if (!instruction) return;

    // Store pending edit state
    this.pendingEdit = {
      editor,
      range: new vscode.Range(selection.start, selection.end),
      originalText: selectedText,
    };

    // Highlight the selection while processing
    editor.setDecorations(this.decorationType, [{ range: selection }]);

    try {
      // Build a focused prompt for inline editing
      const systemPrompt = [
        "Focus ONLY on the selected code. Apply the user's edit instruction precisely.",
        'Return ONLY the replacement code — no explanation, no markdown fences, no surrounding code.',
        `Language: ${language}`,
        `File: ${filePath}`,
      ].join('\n');

      const userPrompt = [
        `Selected code:\n\`\`\`${language}\n${selectedText}\n\`\`\``,
        `\nInstruction: ${instruction}`,
        '\nReturn only the replacement code:',
      ].join('\n');

      // Redact sensitive content before sending
      const redacted = this.redactionEngine.redact(userPrompt);

      // Use the LLM directly for a single-turn edit (not full agent loop)
      const llm = (this.agentLoop as any).llm;
      let result = '';

      for await (const chunk of llm.chat([
        { role: 'system', content: systemPrompt },
        { role: 'user', content: redacted },
      ])) {
        if (chunk.type === 'text' && chunk.text) {
          result += chunk.text;
        }
      }

      // Strip markdown fences if the model wrapped them
      result = this.stripCodeFences(result, language);

      this.pendingEdit.newText = result;

      // Show diff preview
      await this.showDiffPreview(editor, selection, selectedText, result);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      vscode.window.showErrorMessage(`OpenCob Inline Edit: ${msg}`);
      this.clearDecorations(editor);
      this.pendingEdit = null;
    }
  }

  /**
   * Accept the pending inline edit — apply the replacement.
   */
  async acceptEdit(): Promise<void> {
    if (!this.pendingEdit || !this.pendingEdit.newText) {
      vscode.window.showInformationMessage('OpenCob: No pending inline edit to accept.');
      return;
    }

    const { editor, range, newText } = this.pendingEdit;

    await editor.edit((editBuilder) => {
      editBuilder.replace(range, newText!);
    });

    this.clearDecorations(editor);
    this.pendingEdit = null;
  }

  /**
   * Discard the pending inline edit.
   */
  discardEdit(): void {
    if (!this.pendingEdit) return;

    this.clearDecorations(this.pendingEdit.editor);
    this.pendingEdit = null;
    vscode.window.showInformationMessage('OpenCob: Inline edit discarded.');
  }

  /**
   * Show a diff preview using VS Code's diff editor.
   */
  private async showDiffPreview(
    editor: vscode.TextEditor,
    range: vscode.Range,
    originalText: string,
    newText: string,
  ): Promise<void> {
    // Create temporary documents for the diff view
    const originalUri = vscode.Uri.parse(
      `opencob-inline-edit-original:${editor.document.uri.path}`,
    );
    const modifiedUri = vscode.Uri.parse(
      `opencob-inline-edit-modified:${editor.document.uri.path}`,
    );

    // Use decoration to highlight the change inline
    const addDecoration = vscode.window.createTextEditorDecorationType({
      backgroundColor: 'rgba(100, 200, 100, 0.2)',
      border: '1px solid rgba(100, 200, 100, 0.5)',
      after: {
        contentText: ' ✓ Accept (Ctrl+Enter) | ✗ Discard (Escape)',
        color: 'rgba(150, 150, 150, 0.8)',
        fontStyle: 'italic',
        margin: '0 0 0 1em',
      },
    });

    editor.setDecorations(addDecoration, [{ range }]);

    // Show inline info message with accept/discard
    const action = await vscode.window.showInformationMessage(
      `OpenCob: Inline edit ready (${this.getLineDelta(originalText, newText)})`,
      'Accept',
      'Discard',
      'Regenerate',
    );

    editor.setDecorations(addDecoration, []);
    addDecoration.dispose();

    switch (action) {
      case 'Accept':
        await this.acceptEdit();
        break;
      case 'Discard':
        this.discardEdit();
        break;
      case 'Regenerate':
        this.pendingEdit = null;
        this.clearDecorations(editor);
        await this.triggerInlineEdit();
        break;
      default:
        // User dismissed — keep pending edit available
        break;
    }
  }

  private getLineDelta(original: string, modified: string): string {
    const origLines = original.split('\n').length;
    const modLines = modified.split('\n').length;
    const delta = modLines - origLines;
    if (delta === 0) return 'same line count';
    return delta > 0 ? `+${delta} lines` : `${delta} lines`;
  }

  private stripCodeFences(text: string, language: string): string {
    let result = text.trim();
    // Remove opening fence: ```lang or ```
    const openFenceRe = new RegExp(`^\`\`\`(?:${language})?\\s*\\n?`, 'i');
    result = result.replace(openFenceRe, '');
    // Remove closing fence
    result = result.replace(/\n?```\s*$/, '');
    return result;
  }

  private clearDecorations(editor: vscode.TextEditor): void {
    editor.setDecorations(this.decorationType, []);
  }

  dispose(): void {
    this.decorationType.dispose();
  }
}
