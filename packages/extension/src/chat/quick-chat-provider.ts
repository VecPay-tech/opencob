import * as vscode from 'vscode';
import type { AgentLoop, RedactionEngine } from '@opencob/core';

/**
 * Quick Chat Provider (§8.4.5 of DESIGN.md)
 *
 * Floating dialog at top-center (like Command Palette position).
 * Single-turn: ask a question, get answer, dismiss.
 * No tool use — purely informational responses.
 */
export class QuickChatProvider implements vscode.Disposable {
  private panel: vscode.WebviewPanel | null = null;

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly agentLoop: AgentLoop,
    private readonly redactionEngine: RedactionEngine,
  ) {}

  /**
   * Show the quick chat floating dialog.
   */
  async show(): Promise<void> {
    // Use VS Code input box for the question
    const question = await vscode.window.showInputBox({
      prompt: 'Ask OpenCob...',
      placeHolder: 'What does this function do? / Explain this error...',
      title: 'OpenCob Quick Chat',
    });

    if (!question) return;

    // Process through LLM in read-only mode (no tools)
    const llm = (this.agentLoop as any).llm;
    const redacted = this.redactionEngine.redact(question);

    let response = '';

    try {
      await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: 'OpenCob: Thinking...',
          cancellable: true,
        },
        async (_progress, token) => {
          for await (const chunk of llm.chat([
            {
              role: 'system',
              content:
                'You are a helpful coding assistant. Answer the question concisely. Do not use tools or modify files. Provide explanations and code examples only.',
            },
            { role: 'user', content: redacted },
          ])) {
            if (token.isCancellationRequested) break;
            if (chunk.type === 'text' && chunk.text) {
              response += chunk.text;
            }
          }
        },
      );
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      vscode.window.showErrorMessage(`OpenCob Quick Chat: ${msg}`);
      return;
    }

    if (!response) return;

    // Show response in a quick-pick style with actions
    const action = await vscode.window.showInformationMessage(
      response.length > 200 ? response.slice(0, 197) + '...' : response,
      'Open in Chat',
      'Copy',
      'Show Full',
    );

    switch (action) {
      case 'Open in Chat':
        // Send to chat panel
        await vscode.commands.executeCommand('OpenCob.openChat');
        break;
      case 'Copy':
        await vscode.env.clipboard.writeText(response);
        vscode.window.showInformationMessage('Copied to clipboard.');
        break;
      case 'Show Full':
        {
          const doc = await vscode.workspace.openTextDocument({
            content: `# Quick Chat\n\n**Q:** ${question}\n\n**A:** ${response}`,
            language: 'markdown',
          });
          await vscode.window.showTextDocument(doc, { preview: true });
        }
        break;
    }
  }

  dispose(): void {
    this.panel?.dispose();
  }
}
