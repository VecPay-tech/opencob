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
        prompt = `Plan and execute the following task. If the task asks to write a file, use write_to_file to actually create it: ${prompt}`;
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

        const response = await agentLoop.run(fullPrompt, {
          stream: false,
          mode: command === 'analyze' ? 'ask' : undefined,
        });

        if (token.isCancellationRequested) return;

        // Stream the response content as markdown
        if (response.content) {
          stream.markdown(response.content);
        }

        // Show tool calls as references and confirm file operations
        if (response.toolCalls && response.toolCalls.length > 0) {
          const fileOps: string[] = [];
          for (const call of response.toolCalls) {
            const filePath = (call.params?.path || call.params?.filePath) as string | undefined;
            if (filePath) {
              try {
                const uri = vscode.Uri.file(filePath);
                stream.reference(uri);
              } catch {
                // Non-critical
              }
              if (call.name === 'write_to_file' || call.name === 'insert_content') {
                fileOps.push(`✅ Wrote: \`${filePath}\``);
              } else if (call.name === 'apply_diff' || call.name === 'multi_edit') {
                fileOps.push(`✅ Edited: \`${filePath}\``);
              }
            }
          }
          // If the model didn't produce text but did execute tools, show summary
          if (!response.content && fileOps.length > 0) {
            stream.markdown(fileOps.join('\n\n'));
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
