import * as vscode from 'vscode';
import type { AgentLoop, ModeEngine, AgentEvent } from '@opencob/core';

export class ChatPanelProvider implements vscode.WebviewViewProvider {
  private view?: vscode.WebviewView;
  private currentMode = 'Code';
  private isProcessing = false;

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly agentLoop: AgentLoop,
    private readonly modeEngine: ModeEngine,
  ) {}

  resolveWebviewView(
    webviewView: vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken,
  ): void {
    this.view = webviewView;

    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [this.extensionUri],
    };

    webviewView.webview.html = this.getHtml();

    webviewView.webview.onDidReceiveMessage(async (message) => {
      switch (message.type) {
        case 'chat':
          await this.handleChatMessage(message.text);
          break;
        case 'switchMode':
          this.setMode(message.mode);
          break;
        case 'openFile':
          if (message.path) {
            const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri;
            if (workspaceRoot) {
              const fileUri = vscode.Uri.joinPath(workspaceRoot, message.path);
              vscode.window.showTextDocument(fileUri, { preview: true });
            }
          }
          break;
        case 'autoApproveToggle':
          this.handleAutoApproveToggle(message.group, message.enabled);
          break;
        case 'enhancePrompt':
          await this.handleEnhancePrompt(message.text);
          break;
      }
    });
  }

  setMode(mode: string): void {
    this.currentMode = mode;
    this.view?.webview.postMessage({ type: 'modeChanged', mode });
  }

  newConversation(): void {
    this.view?.webview.postMessage({ type: 'newConversation' });
  }

  private async handleChatMessage(text: string): Promise<void> {
    if (this.isProcessing) return;
    this.isProcessing = true;

    try {
      // Signal start of response
      this.view?.webview.postMessage({ type: 'responseStart' });

      for await (const event of this.agentLoop.processMessage(text)) {
        this.handleAgentEvent(event);
      }

      this.view?.webview.postMessage({ type: 'responseEnd' });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.view?.webview.postMessage({
        type: 'error',
        text: `Error: ${msg}`,
      });
    } finally {
      this.isProcessing = false;
    }
  }

  /** Handle auto-approve toggle from the webview toolbar (F1.1 Should) */
  private handleAutoApproveToggle(group: string, enabled: boolean): void {
    const config = vscode.workspace.getConfiguration('opencob.autoApprove');
    config.update(group, enabled, vscode.ConfigurationTarget.Workspace);
  }

  /** Handle enhance prompt request from the webview (F1.1 Should) */
  private async handleEnhancePrompt(text: string): Promise<void> {
    try {
      // Use the PromptEnhancer from the agent loop if available
      const enhanced = await this.agentLoop.enhancePrompt?.(text);
      this.view?.webview.postMessage({
        type: 'enhancedPrompt',
        text: enhanced ?? text,
      });
    } catch {
      // On failure, return original text
      this.view?.webview.postMessage({
        type: 'enhancedPrompt',
        text,
      });
    }
  }

  private handleAgentEvent(event: AgentEvent): void {
    switch (event.type) {
      case 'text':
        this.view?.webview.postMessage({
          type: 'responseChunk',
          text: event.text,
        });
        break;

      case 'tool_call':
        this.view?.webview.postMessage({
          type: 'toolCall',
          toolName: event.toolCall?.name,
          parameters: event.toolCall?.parameters,
        });
        break;

      case 'tool_result':
        this.view?.webview.postMessage({
          type: 'toolResult',
          toolName: event.toolResult?.toolName,
          success: event.toolResult?.success,
          content: event.toolResult?.content,
        });
        break;

      case 'mode_switch':
        this.setMode(event.mode ?? this.currentMode);
        this.view?.webview.postMessage({
          type: 'responseChunk',
          text: event.text,
        });
        break;

      case 'error':
        this.view?.webview.postMessage({
          type: 'error',
          text: event.error,
        });
        break;

      case 'self_correction':
        this.view?.webview.postMessage({
          type: 'responseChunk',
          text: `\n🔄 *${event.text}*\n`,
        });
        break;

      case 'compaction':
        this.view?.webview.postMessage({
          type: 'responseChunk',
          text: `\n📦 *${event.text}*\n`,
        });
        break;
    }
  }

  private getHtml(): string {
    return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>OpenCob Chat</title>
  <style>
    * { box-sizing: border-box; }
    body { font-family: var(--vscode-font-family); font-size: var(--vscode-font-size); padding: 0; margin: 0; color: var(--vscode-foreground); background: var(--vscode-sideBar-background); }
    #chat { display: flex; flex-direction: column; height: 100vh; }
    #messages { flex: 1; overflow-y: auto; padding: 8px; }
    .message { margin: 4px 0; padding: 8px 10px; border-radius: 6px; word-wrap: break-word; line-height: 1.5; }
    .user { background: var(--vscode-input-background); border-left: 3px solid var(--vscode-inputOption-activeBorder); white-space: pre-wrap; }
    .assistant { background: var(--vscode-editor-background); }
    .tool-call { background: var(--vscode-editorWidget-background); border-left: 3px solid var(--vscode-charts-yellow); font-size: 0.9em; opacity: 0.9; }
    .tool-result { background: var(--vscode-editorWidget-background); border-left: 3px solid var(--vscode-charts-green); font-size: 0.85em; max-height: 200px; overflow-y: auto; }
    .tool-result.error { border-left-color: var(--vscode-charts-red); }
    .error-msg { color: var(--vscode-errorForeground); padding: 8px; }

    /* Markdown rendering styles */
    .assistant p { margin: 0.4em 0; }
    .assistant h1, .assistant h2, .assistant h3 { margin: 0.6em 0 0.3em; font-weight: 600; }
    .assistant h1 { font-size: 1.3em; }
    .assistant h2 { font-size: 1.15em; }
    .assistant h3 { font-size: 1.05em; }
    .assistant ul, .assistant ol { margin: 0.3em 0; padding-left: 1.5em; }
    .assistant li { margin: 0.15em 0; }
    .assistant strong { font-weight: 600; }
    .assistant em { font-style: italic; }
    .assistant a { color: var(--vscode-textLink-foreground); text-decoration: none; }
    .assistant a:hover { text-decoration: underline; }

    /* Inline code */
    code:not(.block-code) { background: var(--vscode-textCodeBlock-background); padding: 1px 4px; border-radius: 3px; font-family: var(--vscode-editor-font-family); font-size: var(--vscode-editor-font-size); }

    /* Code blocks */
    .code-block-wrapper { position: relative; margin: 0.5em 0; border-radius: 6px; overflow: hidden; background: var(--vscode-textCodeBlock-background); }
    .code-block-header { display: flex; justify-content: space-between; align-items: center; padding: 4px 10px; background: var(--vscode-titleBar-activeBackground); font-size: 0.8em; color: var(--vscode-descriptionForeground); }
    .code-block-lang { text-transform: uppercase; font-weight: 500; }
    .copy-btn { background: none; border: 1px solid var(--vscode-button-border, var(--vscode-descriptionForeground)); color: var(--vscode-descriptionForeground); padding: 2px 8px; border-radius: 3px; cursor: pointer; font-size: 0.9em; }
    .copy-btn:hover { background: var(--vscode-button-hoverBackground); color: var(--vscode-button-foreground); }
    .copy-btn.copied { color: var(--vscode-charts-green); border-color: var(--vscode-charts-green); }
    pre { margin: 0; padding: 10px; overflow-x: auto; font-family: var(--vscode-editor-font-family); font-size: var(--vscode-editor-font-size); line-height: 1.4; }
    pre code.block-code { padding: 0; background: none; white-space: pre; }

    /* Diff rendering */
    .diff-line-add { background: var(--vscode-diffEditor-insertedTextBackground, rgba(0, 180, 0, 0.15)); }
    .diff-line-del { background: var(--vscode-diffEditor-removedTextBackground, rgba(255, 0, 0, 0.15)); }
    .diff-line-header { color: var(--vscode-descriptionForeground); font-weight: 500; }

    /* File path links */
    .file-link { color: var(--vscode-textLink-foreground); cursor: pointer; text-decoration: underline; text-decoration-style: dotted; }
    .file-link:hover { text-decoration-style: solid; }

    #input-area { display: flex; padding: 8px; gap: 4px; border-top: 1px solid var(--vscode-panel-border); align-items: flex-end; }
    #input { flex: 1; padding: 6px 8px; border: 1px solid var(--vscode-input-border); background: var(--vscode-input-background); color: var(--vscode-input-foreground); border-radius: 4px; font-family: inherit; font-size: inherit; resize: none; min-height: 36px; max-height: 120px; }
    #input:focus { outline: 1px solid var(--vscode-focusBorder); }
    button#send { padding: 6px 12px; background: var(--vscode-button-background); color: var(--vscode-button-foreground); border: none; border-radius: 4px; cursor: pointer; font-size: inherit; }
    button#send:hover { background: var(--vscode-button-hoverBackground); }
    button#send:disabled { opacity: 0.5; cursor: not-allowed; }
    #header { display: flex; align-items: center; padding: 6px 8px; border-bottom: 1px solid var(--vscode-panel-border); gap: 8px; }
    #mode { font-size: 12px; color: var(--vscode-descriptionForeground); }
    #status { font-size: 11px; color: var(--vscode-descriptionForeground); margin-left: auto; }

    /* Auto-approve toolbar (F1.1 Should) */
    #auto-approve-bar { display: flex; align-items: center; padding: 3px 8px; border-bottom: 1px solid var(--vscode-panel-border); gap: 6px; font-size: 11px; color: var(--vscode-descriptionForeground); }
    .aa-toggle { display: flex; align-items: center; gap: 2px; cursor: pointer; padding: 1px 5px; border-radius: 3px; user-select: none; }
    .aa-toggle:hover { background: var(--vscode-toolbar-hoverBackground); }
    .aa-toggle.active { color: var(--vscode-charts-green); }
    .aa-toggle input { display: none; }

    /* Enhance prompt button */
    #enhance-btn { background: none; border: none; color: var(--vscode-descriptionForeground); cursor: pointer; padding: 4px; font-size: 16px; line-height: 1; border-radius: 3px; }
    #enhance-btn:hover { background: var(--vscode-toolbar-hoverBackground); color: var(--vscode-button-foreground); }
    #enhance-btn.enhancing { animation: pulse 1s infinite; }
    .thinking { animation: pulse 1.5s infinite; }
    @keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.4; } }
  </style>
</head>
<body>
  <div id="chat">
    <div id="header">
      <span id="mode"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/></svg> Code</span>
      <span id="status"></span>
    </div>
    <div id="auto-approve-bar">
      <span>Auto-approve:</span>
      <label class="aa-toggle" title="Auto-approve read tools"><input type="checkbox" data-group="read"> <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z"/><path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z"/></svg> Read</label>
      <label class="aa-toggle" title="Auto-approve write tools"><input type="checkbox" data-group="edit"> <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"/></svg> Write</label>
      <label class="aa-toggle" title="Auto-approve command tools"><input type="checkbox" data-group="command"> <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="4 17 10 11 4 5"/><line x1="12" y1="19" x2="20" y2="19"/></svg> Cmd</label>
      <label class="aa-toggle" title="Auto-approve MCP tools"><input type="checkbox" data-group="mcp"> <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg> MCP</label>
    </div>
    <div id="messages"></div>
    <div id="input-area">
      <button id="enhance-btn" title="Enhance prompt with AI (refine before sending)"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m12 3-1.912 5.813a2 2 0 0 1-1.275 1.275L3 12l5.813 1.912a2 2 0 0 1 1.275 1.275L12 21l1.912-5.813a2 2 0 0 1 1.275-1.275L21 12l-5.813-1.912a2 2 0 0 1-1.275-1.275L12 3Z"/><path d="M5 3v4"/><path d="M19 17v4"/><path d="M3 5h4"/><path d="M17 19h4"/></svg></button>
      <textarea id="input" rows="2" placeholder="Ask OpenCob... (/ for commands, @ for context)"></textarea>
      <button id="send">Send</button>
    </div>
  </div>
  <script>
    const vscode = acquireVsCodeApi();
    const messagesEl = document.getElementById('messages');
    const input = document.getElementById('input');
    const sendBtn = document.getElementById('send');
    const modeEl = document.getElementById('mode');
    const statusEl = document.getElementById('status');
    const enhanceBtn = document.getElementById('enhance-btn');
    let currentAssistantEl = null;
    let assistantText = '';

    // Auto-approve toggles (F1.1 Should)
    document.querySelectorAll('.aa-toggle input').forEach(cb => {
      cb.addEventListener('change', () => {
        const group = cb.dataset.group;
        const label = cb.closest('.aa-toggle');
        label.classList.toggle('active', cb.checked);
        vscode.postMessage({ type: 'autoApproveToggle', group, enabled: cb.checked });
      });
    });

    // Enhance prompt button (F1.1 Should)
    enhanceBtn.addEventListener('click', () => {
      const text = input.value.trim();
      if (!text) return;
      enhanceBtn.classList.add('enhancing');
      vscode.postMessage({ type: 'enhancePrompt', text });
    });

    sendBtn.addEventListener('click', send);
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
    });
    input.addEventListener('input', () => {
      input.style.height = 'auto';
      input.style.height = Math.min(input.scrollHeight, 120) + 'px';
    });

    function send() {
      const text = input.value.trim();
      if (!text) return;
      addMessage('user', text);
      vscode.postMessage({ type: 'chat', text });
      input.value = '';
      input.style.height = 'auto';
      sendBtn.disabled = true;
    }

    function addMessage(role, text) {
      const div = document.createElement('div');
      div.className = 'message ' + role;
      if (role === 'assistant') {
        div.innerHTML = renderMarkdown(text);
      } else {
        div.textContent = text;
      }
      messagesEl.appendChild(div);
      messagesEl.scrollTop = messagesEl.scrollHeight;
      return div;
    }

    /** Lightweight Markdown → HTML renderer */
    function renderMarkdown(md) {
      if (!md) return '';
      let html = escapeHtml(md);

      // Code blocks: \`\`\`lang\\ncontent\\n\`\`\`
      html = html.replace(/\`\`\`(\w*)\n([\s\S]*?)\`\`\`/g, (_, lang, code) => {
        const langLabel = lang || 'text';
        const isDiff = langLabel === 'diff';
        let codeHtml = code;
        if (isDiff) {
          codeHtml = code.split('\\n').map(line => {
            if (line.startsWith('+')) return '<span class="diff-line-add">' + line + '</span>';
            if (line.startsWith('-')) return '<span class="diff-line-del">' + line + '</span>';
            if (line.startsWith('@@')) return '<span class="diff-line-header">' + line + '</span>';
            return line;
          }).join('\\n');
        }
        const id = 'cb-' + Math.random().toString(36).slice(2, 8);
        return '<div class="code-block-wrapper">' +
          '<div class="code-block-header"><span class="code-block-lang">' + langLabel + '</span>' +
          '<button class="copy-btn" onclick="copyCode(this, \\'' + id + '\\')" title="Copy code">Copy</button></div>' +
          '<pre><code class="block-code" id="' + id + '">' + codeHtml + '</code></pre></div>';
      });

      // Inline code
      html = html.replace(/\`([^\`]+)\`/g, '<code>$1</code>');

      // Bold
      html = html.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');

      // Italic
      html = html.replace(/\*(.+?)\*/g, '<em>$1</em>');

      // Headers
      html = html.replace(/^### (.+)$/gm, '<h3>$1</h3>');
      html = html.replace(/^## (.+)$/gm, '<h2>$1</h2>');
      html = html.replace(/^# (.+)$/gm, '<h1>$1</h1>');

      // Lists
      html = html.replace(/^- (.+)$/gm, '<li>$1</li>');
      html = html.replace(/(<li>.*<\\/li>\\n?)+/g, (m) => '<ul>' + m + '</ul>');

      // File paths — make clickable
      html = html.replace(/(?:^|\\s)((?:[\\w.-]+\\/)+[\\w.-]+\\.\\w+)(?=\\s|$|[),])/g,
        (match, path) => match.replace(path,
          '<span class="file-link" onclick="openFile(\\'' + path + '\\')" title="Open ' + path + '">' + path + '</span>'
        )
      );

      // Paragraphs: double newlines
      html = html.replace(/\\n\\n/g, '</p><p>');
      html = '<p>' + html + '</p>';
      html = html.replace(/<p><(h[1-3]|ul|div|pre)/g, '<$1');
      html = html.replace(/<\\/(h[1-3]|ul|div|pre)><\\/p>/g, '</$1>');

      return html;
    }

    function escapeHtml(text) {
      const el = document.createElement('span');
      el.textContent = text;
      return el.innerHTML;
    }

    function copyCode(btn, id) {
      const codeEl = document.getElementById(id);
      if (!codeEl) return;
      const text = codeEl.textContent;
      navigator.clipboard.writeText(text).then(() => {
        btn.textContent = 'Copied!';
        btn.classList.add('copied');
        setTimeout(() => {
          btn.textContent = 'Copy';
          btn.classList.remove('copied');
        }, 2000);
      });
    }

    function openFile(path) {
      vscode.postMessage({ type: 'openFile', path });
    }

    window.addEventListener('message', (e) => {
      const msg = e.data;

      switch (msg.type) {
        case 'responseStart':
          assistantText = '';
          currentAssistantEl = document.createElement('div');
          currentAssistantEl.className = 'message assistant';
          messagesEl.appendChild(currentAssistantEl);
          statusEl.textContent = 'thinking...';
          statusEl.className = 'thinking';
          break;

        case 'responseChunk':
          if (msg.text) {
            assistantText += msg.text;
            if (currentAssistantEl) {
              currentAssistantEl.innerHTML = renderMarkdown(assistantText);
              messagesEl.scrollTop = messagesEl.scrollHeight;
            }
          }
          break;

        case 'toolCall':
          const toolDiv = addMessage('tool-call', '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="display:inline;vertical-align:middle"><path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"/></svg> ' + msg.toolName + '(' + JSON.stringify(msg.parameters, null, 2) + ')');
          statusEl.textContent = 'running ' + msg.toolName + '...';
          break;

        case 'toolResult':
          const cls = msg.success ? 'tool-result' : 'tool-result error';
          addMessage(cls, (msg.success ? '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#4ade80" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="display:inline;vertical-align:middle"><polyline points="20 6 9 17 4 12"/></svg> ' : '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#f87171" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="display:inline;vertical-align:middle"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg> ') + msg.toolName + ': ' + msg.content);
          break;

        case 'responseEnd':
          currentAssistantEl = null;
          assistantText = '';
          statusEl.textContent = '';
          statusEl.className = '';
          sendBtn.disabled = false;
          break;

        case 'error':
          addMessage('error-msg', '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#fbbf24" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="display:inline;vertical-align:middle"><path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg> ' + msg.text);
          statusEl.textContent = '';
          statusEl.className = '';
          sendBtn.disabled = false;
          break;

        case 'modeChanged':
          modeEl.textContent = msg.mode;
          break;

        case 'newConversation':
          messagesEl.innerHTML = '';
          currentAssistantEl = null;
          assistantText = '';
          break;

        case 'response':
          addMessage('assistant', msg.text);
          break;

        case 'enhancedPrompt':
          input.value = msg.text;
          enhanceBtn.classList.remove('enhancing');
          input.focus();
          break;
      }
    });
  </script>
</body>
</html>`;
  }
}
