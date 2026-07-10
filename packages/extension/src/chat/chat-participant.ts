import * as vscode from 'vscode';
import type { AgentLoop } from '@opencob/core';

/**
 * VS Code Chat Participant — registers @opencob inside the built-in Chat panel.
 * This lets users access OpenCob from the same Copilot chat bubble in the title bar.
 */
export function registerChatParticipant(
  context: vscode.ExtensionContext,
  agentLoop: AgentLoop,
): vscode.Disposable {
  const participant = vscode.chat.createChatParticipant(
    'opencob.chat',
    async (
      request: vscode.ChatRequest,
      chatContext: vscode.ChatContext,
      stream: vscode.ChatResponseStream,
      token: vscode.CancellationToken,
    ) => {
      const command = request.command;
      let prompt = request.prompt;

      // Handle slash commands
      if (command === 'plan') {
        prompt = `Create a detailed step-by-step plan for: ${prompt}`;
      } else if (command === 'analyze') {
        prompt = `Analyze the following code or system: ${prompt}`;
      } else if (command === 'modernize') {
        prompt = `Modernize this legacy code to modern standards: ${prompt}`;
      } else if (command === 'diagram') {
        prompt = `Generate an architecture/flow diagram for: ${prompt}`;
      }

      // Include file context if available
      const editor = vscode.window.activeTextEditor;
      let fileContext = '';
      if (editor) {
        const selection = editor.selection;
        if (!selection.isEmpty) {
          const selectedText = editor.document.getText(selection);
          fileContext = `\n\nSelected code from ${editor.document.fileName}:\n\`\`\`\n${selectedText}\n\`\`\``;
        } else {
          // Include current file context (first 200 lines)
          const doc = editor.document;
          const maxLines = Math.min(doc.lineCount, 200);
          const content = doc.getText(new vscode.Range(0, 0, maxLines, 0));
          fileContext = `\n\nActive file: ${doc.fileName}\n\`\`\`${doc.languageId}\n${content}\n\`\`\``;
        }
      }

      const fullPrompt = prompt + fileContext;

      // Stream the response using AgentLoop
      try {
        stream.progress('Thinking...');

        for await (const event of agentLoop.processMessage(fullPrompt)) {
          if (token.isCancellationRequested) return;

          if (event.type === 'text' && event.text) {
            stream.markdown(event.text);
          }

          if (event.type === 'tool_call' && event.toolCall?.name) {
            stream.progress(`Using tool: ${event.toolCall.name}`);
          }

          if (event.type === 'error' && event.error) {
            stream.markdown(`\n\n⚠️ Error: ${event.error}`);
          }
        }
      } catch (err: any) {
        if (!token.isCancellationRequested) {
          stream.markdown(`\n\n⚠️ Error: ${err.message || 'Unknown error occurred'}`);
        }
      }
    },
  );

  participant.iconPath = vscode.Uri.joinPath(context.extensionUri, 'resources', 'icon.png');

  return participant;
}
