import * as vscode from 'vscode';
import type {
  AgentLoop,
  ModeEngine,
  AgentEvent,
  ConversationManager,
  ToolRegistry,
} from '@opencob/core' with { 'resolution-mode': 'import' };

const outputChannel = vscode.window.createOutputChannel('OpenCob Chat');

export class ChatPanelProvider implements vscode.WebviewViewProvider {
  private view?: vscode.WebviewView;
  private currentMode = 'code';
  private isProcessing = false;
  private pendingModel = '';
  private pendingModels: string[] = [];
  private pendingStatus: { connected: boolean; provider: string; modelCount: number } | null = null;
  private toolRegistry?: ToolRegistry;
  private pendingApprovals = new Map<string, (approved: boolean) => void>();
  private workspaceScopeFilter: Set<string> | null = null;
  private activityCallback?: (entry: {
    type: string;
    title: string;
    detail?: string;
    file?: string;
  }) => void;

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly agentLoop: AgentLoop,
    private readonly modeEngine: ModeEngine,
    private readonly conversationManager: ConversationManager,
  ) {}

  /** Inject the tool registry after construction for tool config features */
  setToolRegistry(registry: ToolRegistry): void {
    this.toolRegistry = registry;
  }

  /** Set callback to relay agent activity to the Activity panel */
  onActivity(
    callback: (entry: { type: string; title: string; detail?: string; file?: string }) => void,
  ): void {
    this.activityCallback = callback;
  }

  /** Request tool approval via inline chat card (Copilot-style). Returns true if approved. */
  requestToolApproval(toolName: string, group: string, params: unknown): Promise<boolean> {
    outputChannel.appendLine(`[approval] Requesting approval for: ${toolName} (group: ${group})`);
    if (!this.view) {
      outputChannel.appendLine(`[approval] No view available, auto-approving`);
      return Promise.resolve(true);
    }
    return new Promise((resolve) => {
      this.pendingApprovals.set(toolName, (approved) => {
        outputChannel.appendLine(`[approval] Resolved ${toolName}: ${approved}`);
        resolve(approved);
      });
      const risk = group === 'command' ? 'high' : group === 'edit' ? 'medium' : 'low';
      this.view?.webview.postMessage({
        type: 'toolApproval',
        toolName,
        parameters: params,
        risk,
      });
      // Timeout: auto-deny after 60s if no response
      setTimeout(() => {
        if (this.pendingApprovals.has(toolName)) {
          outputChannel.appendLine(`[approval] Timeout for ${toolName}, auto-denying`);
          this.pendingApprovals.delete(toolName);
          resolve(false);
        }
      }, 60000);
    });
  }

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
        case 'webviewReady':
          // Send pending state now that the webview script is listening
          if (this.pendingModels.length > 0) {
            this.view?.webview.postMessage({
              type: 'modelsAvailable',
              models: this.pendingModels,
              current: this.pendingModel,
            });
          } else if (this.pendingModel) {
            this.view?.webview.postMessage({ type: 'modelChanged', model: this.pendingModel });
          }
          if (this.pendingStatus) {
            this.view?.webview.postMessage({ type: 'connectionStatus', ...this.pendingStatus });
          }
          this.sendModesList();
          this.sendToolsList();
          this.sendTokenUsage();
          this.sendWorkspaceScope();
          this.sendHistoryList();
          this.sendActiveConversation();
          break;
        case 'chat':
          await this.handleChatMessage(message.text);
          break;
        case 'switchMode':
          this.setMode(message.mode);
          break;
        case 'openFile':
          if (message.path) {
            const fileUri = await this.resolveWorkspaceUri(message.path);
            if (fileUri) {
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
        case 'switchModel':
          await this.handleSwitchModel(message.model);
          break;
        case 'contextSearch':
          await this.handleContextSearch(message.query);
          break;
        case 'newConversation':
          vscode.commands.executeCommand('OpenCob.newConversation');
          break;
        case 'getHistory':
          this.sendHistoryList();
          break;
        case 'switchConversation':
          this.switchConversation(message.id);
          break;
        case 'deleteConversation':
          this.deleteConversation(message.id);
          break;
        case 'renameConversation':
          this.renameConversation(message.id, message.title);
          break;
        case 'getTools':
          this.sendToolsList();
          break;
        case 'getModes':
          this.sendModesList();
          break;
        case 'getTokenUsage':
          this.sendTokenUsage();
          break;
        case 'updateWorkspaceScopeFilter':
          this.updateWorkspaceScopeFilter(message.folders);
          break;
        case 'exportConversation':
          this.exportConversation();
          break;
        case 'stopGeneration':
          this.isProcessing = false;
          this.view?.webview.postMessage({ type: 'responseEnd' });
          break;
        case 'insertAtCursor':
          {
            const editor = vscode.window.activeTextEditor;
            if (editor && message.code) {
              editor.edit((editBuilder) => {
                editBuilder.insert(editor.selection.active, message.code);
              });
            }
          }
          break;
        case 'applyToFile':
          {
            const editor = vscode.window.activeTextEditor;
            if (editor && message.code) {
              const fullRange = new vscode.Range(
                editor.document.positionAt(0),
                editor.document.positionAt(editor.document.getText().length),
              );
              editor.edit((editBuilder) => {
                editBuilder.replace(fullRange, message.code);
              });
            } else if (message.code) {
              const doc = await vscode.workspace.openTextDocument({
                content: message.code,
                language: message.language || 'text',
              });
              vscode.window.showTextDocument(doc);
            }
          }
          break;
        case 'planApproved':
          outputChannel.appendLine(`[plan] Plan approved: ${message.planId}`);
          break;
        case 'planEdited':
          outputChannel.appendLine(`[plan] Plan edited: ${message.planId}`);
          break;
        case 'planCancelled':
          outputChannel.appendLine(`[plan] Plan cancelled: ${message.planId}`);
          this.isProcessing = false;
          this.view?.webview.postMessage({ type: 'responseEnd' });
          break;
        case 'planPaused':
          outputChannel.appendLine(`[plan] Plan paused: ${message.planId}`);
          break;
        case 'planResumed':
          outputChannel.appendLine(`[plan] Plan resumed: ${message.planId}`);
          break;
        case 'keepChanges':
          outputChannel.appendLine('[changes] User accepted all changes (Keep)');
          break;
        case 'undoChanges':
          outputChannel.appendLine('[changes] User undid all changes');
          vscode.commands.executeCommand('OpenCob.undoLastTurn');
          break;
        case 'createCustomAgent':
          if (message.agent) {
            try {
              (
                this.modeEngine as unknown as { registerMode?: (m: unknown) => void }
              ).registerMode?.({
                slug: message.agent.slug,
                name: message.agent.name,
                roleDefinition: message.agent.roleDefinition,
                whenToUse: message.agent.whenToUse,
                groups: (message.agent.groups || []).map((g: string) => ({ group: g })),
              });
              this.sendModesList();
            } catch {
              outputChannel.appendLine('Failed to register custom agent');
            }
          }
          break;
        case 'approveAction':
          outputChannel.appendLine(
            `[approval] Received from webview: tool=${message.tool}, decision=${message.decision}`,
          );
          outputChannel.appendLine(
            `[approval] Pending approvals: ${[...this.pendingApprovals.keys()].join(', ')}`,
          );
          {
            const resolver = this.pendingApprovals.get(message.tool);
            if (resolver) {
              this.pendingApprovals.delete(message.tool);
              const approved = message.decision === 'allow' || message.decision === 'always';
              outputChannel.appendLine(`[approval] Calling resolver with: ${approved}`);
              resolver(approved);
              // If "always", auto-approve this tool group going forward
              if (message.decision === 'always') {
                const cfg = vscode.workspace.getConfiguration('opencob.autoApprove');
                cfg.update('edit', true, vscode.ConfigurationTarget.Workspace);
              }
            } else {
              outputChannel.appendLine(`[approval] No pending resolver found for: ${message.tool}`);
            }
            // Also relay to agent loop if available
            (
              this.agentLoop as unknown as {
                handleApproval?: (tool: string, decision: string) => void;
              }
            ).handleApproval?.(message.tool, message.decision);
          }
          break;
        case 'acceptDiff':
          // Apply a diff to the target file
          if (message.file) {
            try {
              const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri;
              if (workspaceRoot) {
                const fileUri = vscode.Uri.joinPath(workspaceRoot, message.file);
                const doc = await vscode.workspace.openTextDocument(fileUri);
                await vscode.window.showTextDocument(doc, { preview: true });
              }
            } catch {
              outputChannel.appendLine(`Failed to open file for diff: ${message.file}`);
            }
          }
          break;
        case 'rejectDiff':
          outputChannel.appendLine(`Diff rejected for: ${message.file}`);
          break;
        case 'cycleMode':
          {
            const modes = this.modeEngine.listModes();
            const active = this.modeEngine.getActive();
            const currentIdx = modes.findIndex((m) => m.slug === active.slug);
            const nextIdx = (currentIdx + 1) % modes.length;
            this.setMode(modes[nextIdx].slug);
          }
          break;
      }
    });
  }

  setMode(mode: string): void {
    this.currentMode = mode;
    this.view?.webview.postMessage({ type: 'modeChanged', mode });
    this.sendModesList();
    this.sendToolsList();
  }

  setModel(model: string): void {
    this.pendingModel = model;
    this.view?.webview.postMessage({ type: 'modelChanged', model });
  }

  setConnectionStatus(connected: boolean, provider: string, modelCount: number): void {
    this.pendingStatus = { connected, provider, modelCount };
    this.view?.webview.postMessage({ type: 'connectionStatus', connected, provider, modelCount });
  }

  setAvailableModels(models: string[], currentModel: string): void {
    this.pendingModels = models;
    this.pendingModel = currentModel;
    this.view?.webview.postMessage({ type: 'modelsAvailable', models, current: currentModel });
  }

  newConversation(): void {
    this.turnCount = 0;
    this.view?.webview.postMessage({ type: 'newConversation' });
  }

  private sendHistoryList(): void {
    const conversations = this.conversationManager.list();
    const active = this.conversationManager.getActive();
    this.view?.webview.postMessage({
      type: 'historyList',
      conversations: conversations.map((c) => ({
        id: c.id,
        title: c.title,
        updatedAt: c.updatedAt,
        messageCount: c.messageCount,
        active: c.id === active.id,
      })),
    });
  }

  private sendActiveConversation(): void {
    const conv = this.conversationManager.getActive();
    const messages = conv.messages
      .filter((m) => m.role === 'user' || m.role === 'assistant')
      .map((m) => ({ role: m.role, content: m.content }));
    this.view?.webview.postMessage({ type: 'conversationLoaded', messages });
  }

  private async resolveWorkspaceUri(relativePath: string): Promise<vscode.Uri | undefined> {
    const clean = relativePath.replace(/\\/g, '/').replace(/^\/+/, '');
    const folders = this.getScopedWorkspaceFolders();
    if (folders.length === 0 || !clean) return undefined;

    const parts = clean.split('/').filter(Boolean);
    const first = parts[0]?.toLowerCase();
    const matchingFolder = folders.find((f) => f.name.toLowerCase() === first);

    if (matchingFolder && parts.length > 1) {
      const nestedPath = parts.slice(1).join('/');
      const uri = vscode.Uri.joinPath(matchingFolder.uri, nestedPath);
      try {
        await vscode.workspace.fs.stat(uri);
        return uri;
      } catch {
        // Try fallback strategies.
      }
    }

    for (const folder of folders) {
      const uri = vscode.Uri.joinPath(folder.uri, clean);
      try {
        await vscode.workspace.fs.stat(uri);
        return uri;
      } catch {
        // Try next folder.
      }
    }

    return undefined;
  }

  private switchConversation(id: string): void {
    try {
      const conv = this.conversationManager.setActive(id);
      // Send the conversation's messages to the webview
      const messages = conv.messages
        .filter((m) => m.role === 'user' || m.role === 'assistant')
        .map((m) => ({ role: m.role, content: m.content }));
      this.view?.webview.postMessage({ type: 'conversationLoaded', messages });
    } catch {
      // Conversation not found
    }
  }

  private deleteConversation(id: string): void {
    this.conversationManager.delete(id);
    this.sendHistoryList();
  }

  private renameConversation(id: string, title: string): void {
    try {
      const cm = this.conversationManager as unknown as {
        rename?: (conversationId: string, conversationTitle: string) => void;
        setActive: (conversationId: string) => { title: string; updatedAt: number };
      };
      if (cm.rename) {
        cm.rename(id, title);
      } else {
        const conv = cm.setActive(id);
        conv.title = title.trim() || 'New Conversation';
        conv.updatedAt = Date.now();
      }
      this.sendHistoryList();
    } catch {
      // ignore
    }
  }

  private sendToolsList(): void {
    if (!this.toolRegistry) return;
    const allTools = this.toolRegistry.listAll();
    const availableTools = this.toolRegistry.listAvailable();
    const availableNames = new Set(availableTools.map((t) => t.name));
    this.view?.webview.postMessage({
      type: 'toolsList',
      tools: allTools.map((t) => ({
        name: t.name,
        group: t.group,
        description: t.description,
        enabled: availableNames.has(t.name),
      })),
    });
  }

  private sendModesList(): void {
    const modes = this.modeEngine.listModes();
    const active = this.modeEngine.getActive();
    this.view?.webview.postMessage({
      type: 'modesList',
      modes: modes.map((m) => ({
        slug: m.slug,
        name: m.name,
        whenToUse: m.whenToUse || '',
        groups: m.groups.map((g) => (typeof g === 'string' ? g : g[0])),
        active: m.slug === active.slug,
      })),
    });
  }

  private sendTokenUsage(): void {
    const conv = this.conversationManager.getActive();
    const totalChars = conv.messages.reduce((sum, m) => sum + (m.content?.length || 0), 0);
    const estimatedTokens = Math.ceil(totalChars / 4);
    const maxTokens = 128000; // typical context window
    this.view?.webview.postMessage({
      type: 'tokenUsage',
      used: estimatedTokens,
      max: maxTokens,
      messageCount: conv.messages.length,
    });
  }

  private sendWorkspaceScope(): void {
    const folders = vscode.workspace.workspaceFolders ?? [];
    this.view?.webview.postMessage({
      type: 'workspaceScope',
      selected:
        this.workspaceScopeFilter === null ? [] : Array.from(this.workspaceScopeFilter.values()),
      folders: folders.map((folder) => ({
        name: folder.name,
        path: folder.uri.fsPath,
      })),
    });
  }

  private updateWorkspaceScopeFilter(folderNames: unknown): void {
    const existingFolderNames = new Set(
      (vscode.workspace.workspaceFolders ?? []).map((f) => f.name),
    );
    if (!Array.isArray(folderNames) || folderNames.length === 0) {
      this.workspaceScopeFilter = null;
      this.sendWorkspaceScope();
      return;
    }

    const names = folderNames
      .filter((n): n is string => typeof n === 'string')
      .map((n) => n.trim())
      .filter((n) => Boolean(n) && existingFolderNames.has(n));

    this.workspaceScopeFilter = names.length > 0 ? new Set(names) : null;
    this.sendWorkspaceScope();
  }

  private getScopedWorkspaceFolders(): vscode.WorkspaceFolder[] {
    const folders = vscode.workspace.workspaceFolders ?? [];
    if (!this.workspaceScopeFilter || this.workspaceScopeFilter.size === 0) {
      return folders;
    }
    const scoped = folders.filter((folder) => this.workspaceScopeFilter?.has(folder.name));
    return scoped.length > 0 ? scoped : folders;
  }

  private exportConversation(): void {
    try {
      const markdown = this.conversationManager.exportAsMarkdown();
      vscode.workspace
        .openTextDocument({ content: markdown, language: 'markdown' })
        .then((doc) => vscode.window.showTextDocument(doc));
    } catch {
      // ignore
    }
  }

  private turnCount = 0;

  private async handleChatMessage(text: string): Promise<void> {
    outputChannel.appendLine(
      `[chat] handleChatMessage called, text="${text}", isProcessing=${this.isProcessing}, view=${!!this.view}`,
    );
    if (this.isProcessing) {
      outputChannel.appendLine('[chat] BLOCKED — isProcessing is true, ignoring message');
      return;
    }
    this.isProcessing = true;

    try {
      // Resolve #file context references
      const withFileReferences = await this.resolveFileReferences(text);
      const processedText = await this.injectWorkspaceStructureContext(withFileReferences);

      // Signal start of response
      outputChannel.appendLine('[chat] sending responseStart');
      this.view?.webview.postMessage({ type: 'responseStart' });

      let eventCount = 0;
      for await (const event of this.agentLoop.processMessage(processedText)) {
        eventCount++;
        outputChannel.appendLine(`[chat] event #${eventCount}: type=${event.type}`);
        this.handleAgentEvent(event);
      }

      outputChannel.appendLine(`[chat] loop done, total events=${eventCount}, sending responseEnd`);
      this.view?.webview.postMessage({ type: 'responseEnd' });

      // Auto-title: on first user message, derive a short title from input text
      this.turnCount++;
      if (this.turnCount === 1) {
        const title = text.length > 50 ? text.slice(0, 47) + '...' : text;
        const active = this.conversationManager.getActive();
        if (active) {
          (
            this.conversationManager as unknown as { rename?: (id: string, name: string) => void }
          ).rename?.(active.id, title);
          this.sendHistoryList();
        }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      outputChannel.appendLine(`[chat] ERROR: ${msg}`);
      this.view?.webview.postMessage({
        type: 'error',
        text: `Error: ${msg}`,
      });
    } finally {
      this.isProcessing = false;
      outputChannel.appendLine('[chat] isProcessing reset to false');
    }
  }

  private async injectWorkspaceStructureContext(text: string): Promise<string> {
    if (!/\b(explain|describe|summari[sz]e)\b[\s\S]*\b(workspace|project)\b/i.test(text)) {
      return text;
    }
    if (text.includes('[Workspace scope snapshot]:')) {
      return text;
    }

    const folders = this.getScopedWorkspaceFolders();
    if (folders.length === 0) return text;

    const blocks: string[] = [];
    for (const folder of folders) {
      try {
        const entries = await vscode.workspace.fs.readDirectory(folder.uri);
        const display = entries
          .filter(([name]) => !name.startsWith('.'))
          .sort((a, b) => {
            const aDir = (a[1] & vscode.FileType.Directory) !== 0;
            const bDir = (b[1] & vscode.FileType.Directory) !== 0;
            if (aDir !== bDir) return aDir ? -1 : 1;
            return a[0].localeCompare(b[0]);
          })
          .slice(0, 80)
          .map(([name, type]) => `${name}${(type & vscode.FileType.Directory) !== 0 ? '/' : ''}`);

        if (display.length === 0) continue;

        blocks.push(
          `- ${folder.name} (${folder.uri.fsPath})\n${display.map((item) => `  - ${item}`).join('\n')}`,
        );
      } catch {
        // Skip unreadable folder entries.
      }
    }

    if (blocks.length === 0) return text;
    return `${text}\n\n[Workspace scope snapshot]:\n${blocks.join('\n')}`;
  }

  /** Handle auto-approve toggle from the webview toolbar (F1.1 Should) */
  private handleAutoApproveToggle(group: string, enabled: boolean): void {
    const config = vscode.workspace.getConfiguration('opencob.autoApprove');
    config.update(group, enabled, vscode.ConfigurationTarget.Workspace);
  }

  /** Handle model switch from the chat panel dropdown */
  private async handleSwitchModel(model: string): Promise<void> {
    this.pendingModel = model;
    // Notify extension to actually switch the LLM adapter
    await vscode.commands.executeCommand('OpenCob.switchModelTo', model);
  }

  /** Handle # context search — find workspace files matching query */
  private async handleContextSearch(query: string): Promise<void> {
    const workspaceFolders = this.getScopedWorkspaceFolders();
    if (workspaceFolders.length === 0) {
      this.view?.webview.postMessage({ type: 'contextFiles', files: [] });
      return;
    }
    const pattern = query ? `**/*${query}*` : '**/*';
    try {
      const uris = await vscode.workspace.findFiles(pattern, '**/node_modules/**', 20);
      const scopedUris = uris.filter((uri) => {
        const filePath = uri.fsPath.replace(/\\/g, '/');
        return workspaceFolders.some((folder) => {
          const folderPath = folder.uri.fsPath.replace(/\\/g, '/');
          return filePath === folderPath || filePath.startsWith(folderPath + '/');
        });
      });
      const files = scopedUris.map((u) =>
        vscode.workspace.asRelativePath(u, true).replace(/\\/g, '/'),
      );
      files.sort((a, b) => a.length - b.length);
      this.view?.webview.postMessage({ type: 'contextFiles', files });
    } catch {
      this.view?.webview.postMessage({ type: 'contextFiles', files: [] });
    }
  }

  /** Resolve #file references in the message text — read file content and inject as context */
  private async resolveFileReferences(text: string): Promise<string> {
    const pattern = /#((?:file:)?[\w./\\-]+)/gi;
    const matches = [...text.matchAll(pattern)];
    if (matches.length === 0) return text;

    if (!vscode.workspace.workspaceFolders?.length) return text;

    let contextBlock = '';
    for (const match of matches) {
      const rawRef = match[1] ?? '';
      const referencePath = rawRef.replace(/^file:/i, '').replace(/\/+$|\\+$/g, '');
      if (!referencePath) continue;
      try {
        const fileUri = await this.resolveWorkspaceUri(referencePath);
        if (!fileUri) continue;
        const stat = await vscode.workspace.fs.stat(fileUri);

        if (stat.type & vscode.FileType.Directory) {
          const tree = await this.buildDirectoryReferenceTree(fileUri, referencePath);
          if (!tree) continue;
          contextBlock += `\n\n--- Directory: ${referencePath} ---\n\`\`\`\n${tree}\n\`\`\`\n`;
          continue;
        }

        const content = await vscode.workspace.fs.readFile(fileUri);
        const textContent = new TextDecoder('utf-8').decode(content);
        const truncated =
          textContent.length > 8000
            ? textContent.slice(0, 8000) + '\n... (truncated)'
            : textContent;
        contextBlock += `\n\n--- File: ${referencePath} ---\n\`\`\`\n${truncated}\n\`\`\`\n`;
      } catch {
        // Unresolvable reference — leave as-is
      }
    }

    if (contextBlock) {
      return text + '\n\n[Referenced files context]:' + contextBlock;
    }
    return text;
  }

  private async buildDirectoryReferenceTree(
    rootUri: vscode.Uri,
    displayPath: string,
  ): Promise<string | undefined> {
    const maxEntries = 80;
    const maxDepth = 2;
    const lines: string[] = [];

    const walk = async (uri: vscode.Uri, depth: number, indent: string): Promise<void> => {
      if (depth > maxDepth || lines.length >= maxEntries) return;
      let entries: [string, vscode.FileType][] = [];
      try {
        entries = await vscode.workspace.fs.readDirectory(uri);
      } catch {
        return;
      }

      entries.sort((a, b) => {
        const aDir = (a[1] & vscode.FileType.Directory) !== 0;
        const bDir = (b[1] & vscode.FileType.Directory) !== 0;
        if (aDir !== bDir) return aDir ? -1 : 1;
        return a[0].localeCompare(b[0]);
      });

      for (const [name, type] of entries) {
        if (lines.length >= maxEntries) break;
        const isDir = (type & vscode.FileType.Directory) !== 0;
        lines.push(`${indent}${name}${isDir ? '/' : ''}`);
        if (isDir) {
          await walk(vscode.Uri.joinPath(uri, name), depth + 1, `${indent}  `);
        }
      }
    };

    await walk(rootUri, 0, '');
    if (lines.length === 0) return undefined;
    const suffix = lines.length >= maxEntries ? '\n... (truncated)' : '';
    return `${displayPath}/\n${lines.join('\n')}${suffix}`;
  }

  /** Handle enhance prompt request from the webview (F1.1 Should) */
  private async handleEnhancePrompt(text: string): Promise<void> {
    try {
      // Use the PromptEnhancer from the agent loop if available
      const enhanced = await (
        this.agentLoop as unknown as { enhancePrompt?: (input: string) => Promise<string> }
      ).enhancePrompt?.(text);
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
        this.activityCallback?.({
          type: 'tool_call',
          title: `Tool: ${event.toolCall?.name}`,
          detail: JSON.stringify(event.toolCall?.parameters || {}).slice(0, 100),
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

      case 'phase_change':
        this.view?.webview.postMessage({
          type: 'phaseChange',
          phase: event.phase,
        });
        this.activityCallback?.({
          type: 'phase_change',
          title: `Phase: ${event.phase}`,
        });
        break;

      case 'thinking':
        this.view?.webview.postMessage({
          type: 'thinking',
          text: event.thinking ?? event.text,
        });
        break;

      case 'thinking_end':
        this.view?.webview.postMessage({ type: 'thinkingEnd' });
        break;

      case 'plan_created':
        this.view?.webview.postMessage({
          type: 'planCreated',
          plan: (event as any).plan,
        });
        this.activityCallback?.({
          type: 'plan',
          title: `Plan created: ${(event as any).plan?.goal ?? 'Unknown'}`,
          detail: `${(event as any).plan?.steps?.length ?? 0} steps`,
        });
        break;

      case 'plan_step_update':
        this.view?.webview.postMessage({
          type: 'planStepUpdate',
          planStep: (event as any).planStep,
        });
        this.activityCallback?.({
          type: 'plan_step',
          title: `Step ${((event as any).planStep?.stepIndex ?? 0) + 1}: ${(event as any).planStep?.status}`,
          detail: (event as any).planStep?.summary,
        });
        break;

      case 'changes_summary':
        this.view?.webview.postMessage({
          type: 'changesSummary',
          summary: (event as any).changesSummary,
        });
        this.activityCallback?.({
          type: 'changes',
          title: `${(event as any).changesSummary?.filesChanged} files changed`,
          detail: `+${(event as any).changesSummary?.linesAdded} −${(event as any).changesSummary?.linesRemoved}`,
        });
        break;
    }
  }

  private getHtml(): string {
    const modelOptions =
      this.pendingModels.length > 0
        ? this.pendingModels
            .map((m) => {
              const display = m.includes('/') ? m.split('/').pop() : m;
              return `<option value="${m}"${m === this.pendingModel ? ' selected' : ''}>${display}</option>`;
            })
            .join('')
        : '<option value="">No models</option>';
    const modelDisabled = this.pendingModels.length === 0 ? ' disabled' : '';

    return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>OpenCob Chat</title>
  <style>
    :root {
      --radius: 6px;
      --gap: 8px;
      --transition: 120ms ease;
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: var(--vscode-font-family);
      font-size: var(--vscode-font-size);
      color: var(--vscode-foreground);
      background: var(--vscode-sideBar-background);
      overflow: hidden;
    }

    /* ─── Layout ─── */
    #app { display: flex; flex-direction: column; height: 100vh; }

    /* ─── Header ─── */
    .header {
      display: flex; align-items: center; gap: 6px;
      padding: 8px 12px; min-height: 38px;
      border-bottom: 1px solid var(--vscode-panel-border);
    }
    .header-brand {
      display: flex; align-items: center; gap: 7px;
      font-size: 13px; font-weight: 600;
      color: var(--vscode-foreground);
    }
    .header-brand svg { opacity: 0.7; }
    .header-spacer { flex: 1; }
    .workspace-scope-pill {
      display: inline-flex;
      align-items: center;
      gap: 4px;
      margin-left: 8px;
      font-size: 10px;
      color: var(--vscode-descriptionForeground);
      border: 1px solid var(--vscode-panel-border);
      border-radius: 999px;
      padding: 1px 7px;
      max-width: 220px;
      overflow: hidden;
      white-space: nowrap;
      text-overflow: ellipsis;
      cursor: pointer;
    }
    .workspace-scope-menu {
      position: absolute;
      top: 42px;
      left: 20px;
      min-width: 260px;
      max-width: 320px;
      border: 1px solid var(--vscode-panel-border);
      border-radius: 8px;
      background: var(--vscode-editorWidget-background);
      box-shadow: 0 8px 24px rgba(0, 0, 0, 0.24);
      z-index: 70;
      padding: 8px;
    }
    .workspace-scope-menu.hidden { display: none; }
    .scope-menu-title {
      font-size: 11px;
      font-weight: 600;
      margin-bottom: 6px;
      color: var(--vscode-foreground);
    }
    .scope-menu-item {
      display: flex;
      align-items: center;
      gap: 6px;
      font-size: 11px;
      color: var(--vscode-foreground);
      margin-bottom: 4px;
    }
    .scope-menu-actions {
      display: flex;
      justify-content: space-between;
      margin-top: 8px;
      gap: 6px;
    }
    .scope-menu-btn {
      border: 1px solid var(--vscode-panel-border);
      background: var(--vscode-sideBar-background);
      color: var(--vscode-foreground);
      border-radius: 6px;
      padding: 3px 8px;
      font-size: 11px;
      cursor: pointer;
    }
    .header-btn {
      background: none; border: none; padding: 4px; border-radius: 4px;
      color: var(--vscode-descriptionForeground); cursor: pointer;
      display: flex; align-items: center; justify-content: center;
    }
    .header-btn:hover { background: var(--vscode-toolbar-hoverBackground); color: var(--vscode-foreground); }
    #status-indicator {
      font-size: 11px; padding: 2px 8px; border-radius: 10px; font-weight: 500;
    }
    #status-indicator.idle { display: none; }
    #status-indicator.thinking {
      display: inline-block;
      background: var(--vscode-inputValidation-infoBackground, rgba(0,120,212,0.15));
      color: var(--vscode-inputValidation-infoBorder, #007acc);
      animation: pulse 1.5s ease-in-out infinite;
    }
    #status-indicator.running {
      display: inline-block;
      background: var(--vscode-inputValidation-warningBackground, rgba(255,165,0,0.15));
      color: var(--vscode-editorWarning-foreground, #cca700);
    }
    @keyframes pulse { 0%,100% { opacity: 1; } 50% { opacity: 0.5; } }

    .right-drawer {
      position: absolute;
      top: 72px;
      right: 0;
      bottom: 0;
      width: 300px;
      border-left: 1px solid var(--vscode-panel-border);
      background: var(--vscode-editor-background);
      z-index: 45;
      display: flex;
      flex-direction: column;
      box-shadow: -6px 0 14px rgba(0, 0, 0, 0.18);
    }
    .right-drawer.hidden { display: none; }
    .drawer-header {
      display: flex; align-items: center; justify-content: space-between;
      padding: 8px 10px;
      border-bottom: 1px solid var(--vscode-panel-border);
      font-size: 12px; font-weight: 600;
    }
    .drawer-tabs {
      display: flex;
      border-bottom: 1px solid var(--vscode-panel-border);
    }
    .drawer-tab {
      flex: 1;
      border: 0;
      border-bottom: 2px solid transparent;
      background: none;
      color: var(--vscode-descriptionForeground);
      font-size: 11px;
      padding: 7px 6px;
      cursor: pointer;
    }
    .drawer-tab.active {
      color: var(--vscode-foreground);
      border-bottom-color: var(--vscode-focusBorder);
    }
    .drawer-body {
      flex: 1;
      overflow: auto;
      padding: 8px;
    }
    .drawer-section.hidden { display: none; }
    .list-item {
      border: 1px solid var(--vscode-panel-border);
      border-radius: 6px;
      padding: 7px 8px;
      margin-bottom: 6px;
      background: var(--vscode-sideBar-background);
      font-size: 11px;
    }
    .list-title {
      display: flex; align-items: center; justify-content: space-between;
      gap: 6px;
      font-weight: 600;
      margin-bottom: 2px;
    }
    .badge {
      border-radius: 999px;
      padding: 1px 6px;
      border: 1px solid var(--vscode-panel-border);
      font-size: 10px;
      color: var(--vscode-descriptionForeground);
    }
    .badge.ok {
      color: var(--vscode-terminal-ansiGreen, #4ec970);
      border-color: var(--vscode-terminal-ansiGreen, #4ec970);
    }
    .muted { color: var(--vscode-descriptionForeground); }

    /* ─── History Panel ─── */
    .history-panel {
      position: absolute; top: 38px; left: 0; right: 0; bottom: 0;
      background: var(--vscode-sideBar-background);
      z-index: 50; display: flex; flex-direction: column;
      border-top: 1px solid var(--vscode-panel-border);
    }
    .history-panel.hidden { display: none; }
    .history-header {
      display: flex; align-items: center; justify-content: space-between;
      padding: 10px 12px; font-size: 12px; font-weight: 600;
      border-bottom: 1px solid var(--vscode-panel-border);
      color: var(--vscode-foreground);
    }
    .history-header button {
      background: none; border: none; color: var(--vscode-descriptionForeground);
      cursor: pointer; font-size: 16px; padding: 2px 6px; border-radius: 4px;
    }
    .history-header button:hover { background: var(--vscode-toolbar-hoverBackground); }
    .history-list { flex: 1; overflow-y: auto; padding: 4px 0; }
    .history-item {
      display: flex; align-items: center; gap: 8px;
      padding: 8px 14px; cursor: pointer; font-size: 12px;
      color: var(--vscode-foreground); border-left: 2px solid transparent;
    }
    .history-item:hover { background: var(--vscode-list-hoverBackground); }
    .history-item.active {
      background: var(--vscode-list-activeSelectionBackground);
      color: var(--vscode-list-activeSelectionForeground);
      border-left-color: var(--vscode-focusBorder);
    }
    .history-item svg { flex-shrink: 0; opacity: 0.5; }
    .history-title { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .history-meta { font-size: 10px; color: var(--vscode-descriptionForeground); white-space: nowrap; }
    .history-delete {
      opacity: 0; background: none; border: none; padding: 2px 4px; border-radius: 3px;
      color: var(--vscode-descriptionForeground); cursor: pointer; font-size: 11px;
    }
    .history-item:hover .history-delete { opacity: 0.6; }
    .history-delete:hover { opacity: 1 !important; color: var(--vscode-errorForeground); background: var(--vscode-toolbar-hoverBackground); }
    .history-empty { padding: 24px; text-align: center; color: var(--vscode-descriptionForeground); font-size: 12px; }

    /* ─── Messages ─── */
    .messages {
      flex: 1; overflow-y: auto; padding: 0; scroll-behavior: smooth;
    }
    .messages::-webkit-scrollbar { width: 6px; }
    .messages::-webkit-scrollbar-thumb { background: var(--vscode-scrollbarSlider-background); border-radius: 3px; }

    /* Welcome */
    .welcome {
      display: flex; flex-direction: column; align-items: center; justify-content: center;
      height: 100%; text-align: center; padding: 24px;
    }
    .welcome-icon { width: 144px; height: 144px; margin-bottom: 14px; }
    .welcome h2 { font-size: 14px; font-weight: 600; margin-bottom: 6px; }
    .welcome p {
      font-size: 12px; color: var(--vscode-descriptionForeground);
      max-width: 240px; line-height: 1.5; margin-bottom: 16px;
    }
    .welcome-actions { display: flex; flex-direction: column; gap: 6px; width: 100%; max-width: 260px; }
    .welcome-action {
      display: flex; align-items: center; gap: 8px;
      padding: 8px 12px; border-radius: var(--radius);
      border: 1px solid var(--vscode-panel-border);
      background: var(--vscode-editor-background);
      color: var(--vscode-foreground); font-size: 12px;
      cursor: pointer; text-align: left; transition: all var(--transition);
    }
    .welcome-action:hover { border-color: var(--vscode-focusBorder); background: var(--vscode-list-hoverBackground); }
    .welcome-action svg { flex-shrink: 0; opacity: 0.5; }

    /* Messages */
    .msg { padding: 12px 16px; position: relative; }
    .msg + .msg { border-top: 1px solid var(--vscode-panel-border); }
    .msg-header { display: flex; align-items: center; gap: 6px; margin-bottom: 6px; }
    .msg-icon {
      width: 20px; height: 20px; border-radius: 50%;
      display: flex; align-items: center; justify-content: center;
      flex-shrink: 0; font-size: 10px; font-weight: 700;
    }
    .msg-user .msg-icon {
      background: var(--vscode-inputOption-activeBorder); color: #fff;
    }
    .msg-assistant .msg-icon {
      background: var(--vscode-badge-background); color: var(--vscode-badge-foreground);
    }
    .msg-role { font-size: 12px; font-weight: 600; }
    .msg-time { font-size: 10px; color: var(--vscode-descriptionForeground); margin-left: auto; }
    .msg-content { line-height: 1.6; word-wrap: break-word; overflow-wrap: break-word; padding-left: 26px; }
    .msg-user .msg-content { white-space: pre-wrap; }

    /* Message actions toolbar */
    .msg-actions {
      display: none; position: absolute; top: 8px; right: 10px;
      gap: 2px; align-items: center;
      background: var(--vscode-editor-background);
      border: 1px solid var(--vscode-panel-border);
      border-radius: 4px; padding: 2px;
      box-shadow: 0 2px 8px rgba(0,0,0,0.12);
    }
    .msg:hover .msg-actions { display: flex; }
    .msg-action-btn {
      background: none; border: none; padding: 3px 5px;
      border-radius: 3px; cursor: pointer;
      color: var(--vscode-descriptionForeground);
      display: flex; align-items: center;
    }
    .msg-action-btn:hover { background: var(--vscode-toolbar-hoverBackground); color: var(--vscode-foreground); }
    .msg-action-btn.active { color: var(--vscode-terminal-ansiGreen, #4ec970); }

    /* Feedback */
    .msg-feedback {
      display: flex; align-items: center; gap: 4px;
      padding: 4px 0 0 26px;
    }
    .feedback-btn {
      background: none; border: none; padding: 2px 4px;
      border-radius: 3px; cursor: pointer;
      color: var(--vscode-descriptionForeground); font-size: 13px;
    }
    .feedback-btn:hover { color: var(--vscode-foreground); background: var(--vscode-toolbar-hoverBackground); }
    .feedback-btn.voted { color: var(--vscode-terminal-ansiGreen, #4ec970); }

    /* Scroll-to-bottom FAB */
    .scroll-fab {
      display: none; position: absolute; bottom: 8px; right: 12px;
      width: 28px; height: 28px; border-radius: 50%;
      background: var(--vscode-button-background); color: var(--vscode-button-foreground);
      border: none; cursor: pointer; z-index: 10;
      align-items: center; justify-content: center;
      box-shadow: 0 2px 8px rgba(0,0,0,0.2);
    }
    .scroll-fab.visible { display: flex; }
    .scroll-fab:hover { background: var(--vscode-button-hoverBackground); }

    /* @ mention popup */
    #at-popup {
      display: none; position: absolute; bottom: 100%; left: 0; right: 0;
      max-height: 180px; overflow-y: auto;
      background: var(--vscode-editorWidget-background);
      border: 1px solid var(--vscode-editorWidget-border, var(--vscode-panel-border));
      border-radius: var(--radius); box-shadow: 0 -4px 12px rgba(0,0,0,0.2); z-index: 100;
    }
    .at-item {
      padding: 7px 10px; font-size: 12px; cursor: pointer;
      display: flex; align-items: center; gap: 8px;
    }
    .at-item:hover, .at-item.selected { background: var(--vscode-list-hoverBackground); }
    .at-name { font-weight: 600; }
    .at-desc { font-size: 11px; color: var(--vscode-descriptionForeground); }

    /* Inline rename */
    .history-rename-input {
      width: 100%; border: 1px solid var(--vscode-focusBorder);
      background: var(--vscode-input-background); color: var(--vscode-input-foreground);
      padding: 2px 6px; border-radius: 3px; font-size: 12px; outline: none;
    }

    /* Tool calls */
    .tool-group { margin: 6px 0 6px 26px; border: 1px solid var(--vscode-panel-border); border-radius: var(--radius); overflow: hidden; }
    .tool-header {
      display: flex; align-items: center; gap: 6px;
      padding: 5px 10px; background: var(--vscode-editorWidget-background);
      cursor: pointer; font-size: 12px; user-select: none;
    }
    .tool-header:hover { background: var(--vscode-list-hoverBackground); }
    .tool-name { font-weight: 500; }
    .tool-chevron { margin-left: auto; transition: transform var(--transition); }
    .tool-chevron.open { transform: rotate(90deg); }
    .tool-body {
      display: none; padding: 8px 10px; font-size: 11px;
      font-family: var(--vscode-editor-font-family);
      background: var(--vscode-editor-background);
      max-height: 200px; overflow-y: auto; white-space: pre-wrap; word-break: break-all;
    }
    .tool-body.open { display: block; }
    .tool-status { font-size: 10px; font-weight: 500; margin-left: 6px; }
    .tool-status.ok { color: var(--vscode-terminal-ansiGreen, #4ec970); }
    .tool-status.err { color: var(--vscode-terminal-ansiRed, #f14c4c); }
    .tool-status.pending { color: var(--vscode-descriptionForeground); animation: pulse 1s infinite; }

    /* Error banner */
    .error-banner {
      display: flex; align-items: flex-start; gap: 8px;
      padding: 10px 14px; margin: 6px 16px 6px 42px; border-radius: var(--radius);
      background: var(--vscode-inputValidation-errorBackground, rgba(255,0,0,0.1));
      border: 1px solid var(--vscode-inputValidation-errorBorder, #be1100);
      font-size: 12px;
    }
    .error-banner svg { flex-shrink: 0; margin-top: 1px; }

    /* ─── Markdown ─── */
    .msg-content p { margin: 0.4em 0; }
    .msg-content h1, .msg-content h2, .msg-content h3 { margin: 0.8em 0 0.3em; font-weight: 600; }
    .msg-content h1 { font-size: 1.3em; border-bottom: 1px solid var(--vscode-panel-border); padding-bottom: 4px; }
    .msg-content h2 { font-size: 1.15em; }
    .msg-content h3 { font-size: 1.05em; }
    .msg-content ul, .msg-content ol { margin: 0.3em 0; padding-left: 1.5em; }
    .msg-content li { margin: 0.15em 0; }
    .msg-content strong { font-weight: 600; }
    .msg-content em { font-style: italic; }
    code:not(.block-code) {
      background: var(--vscode-textCodeBlock-background); padding: 1px 5px;
      border-radius: 3px; font-family: var(--vscode-editor-font-family); font-size: 0.9em;
    }
    .code-block-wrapper { margin: 0.6em 0; border-radius: var(--radius); overflow: hidden; border: 1px solid var(--vscode-panel-border); }
    .code-block-header {
      display: flex; align-items: center;
      padding: 4px 10px; background: var(--vscode-titleBar-activeBackground);
      font-size: 11px; color: var(--vscode-descriptionForeground);
    }
    .code-block-lang { text-transform: uppercase; font-weight: 600; letter-spacing: 0.5px; }
    .code-block-actions { display: flex; gap: 2px; margin-left: auto; }
    .code-action-btn {
      background: none; border: 1px solid var(--vscode-panel-border);
      color: var(--vscode-descriptionForeground); padding: 2px 7px; border-radius: 3px;
      cursor: pointer; font-size: 10px; transition: all var(--transition);
      display: inline-flex; align-items: center; gap: 3px;
    }
    .code-action-btn:hover { background: var(--vscode-button-background); color: var(--vscode-button-foreground); border-color: var(--vscode-button-background); }
    .code-action-btn.copied { color: var(--vscode-terminal-ansiGreen, #4ec970); border-color: var(--vscode-terminal-ansiGreen, #4ec970); }
    .copy-btn {
      background: none; border: 1px solid var(--vscode-panel-border);
      color: var(--vscode-descriptionForeground); padding: 2px 8px; border-radius: 3px;
      cursor: pointer; font-size: 11px; transition: all var(--transition);
    }
    .copy-btn:hover { background: var(--vscode-button-background); color: var(--vscode-button-foreground); border-color: var(--vscode-button-background); }
    .copy-btn.copied { color: var(--vscode-terminal-ansiGreen, #4ec970); border-color: var(--vscode-terminal-ansiGreen, #4ec970); }
    pre { margin: 0; padding: 10px 12px; overflow-x: auto; font-family: var(--vscode-editor-font-family); font-size: var(--vscode-editor-font-size); line-height: 1.5; background: var(--vscode-textCodeBlock-background); }
    pre code.block-code { padding: 0; background: none; white-space: pre; }
    .diff-line-add { background: var(--vscode-diffEditor-insertedTextBackground, rgba(0,180,0,0.15)); display: block; }
    .diff-line-del { background: var(--vscode-diffEditor-removedTextBackground, rgba(255,0,0,0.15)); display: block; }
    .diff-line-header { color: var(--vscode-descriptionForeground); font-weight: 500; display: block; }
    .file-link { color: var(--vscode-textLink-foreground); cursor: pointer; text-decoration: underline dotted; }
    .file-link:hover { text-decoration-style: solid; }

    /* Thinking animation */
    .thinking-dots { display: inline-flex; gap: 3px; padding: 8px 0; }
    .thinking-dots span {
      width: 6px; height: 6px; border-radius: 50%;
      background: var(--vscode-descriptionForeground);
      animation: dot-bounce 1.2s infinite ease-in-out;
    }
    .thinking-dots span:nth-child(2) { animation-delay: 0.2s; }
    .thinking-dots span:nth-child(3) { animation-delay: 0.4s; }
    @keyframes dot-bounce {
      0%, 80%, 100% { transform: scale(0.6); opacity: 0.4; }
      40% { transform: scale(1); opacity: 1; }
    }

    /* Agent badge */
    .agent-badge {
      font-size: 10px; padding: 1px 6px; border-radius: 3px;
      background: var(--vscode-badge-background); color: var(--vscode-badge-foreground);
      font-weight: 500; text-transform: capitalize;
    }

    /* References section */
    .references-section {
      margin: 6px 0 0 26px; border: 1px solid var(--vscode-panel-border);
      border-radius: var(--radius); overflow: hidden;
    }
    .references-header {
      display: flex; align-items: center; gap: 6px; padding: 5px 10px;
      background: var(--vscode-editorWidget-background); cursor: pointer;
      font-size: 11px; user-select: none; color: var(--vscode-descriptionForeground);
    }
    .references-header:hover { background: var(--vscode-list-hoverBackground); }
    .references-body { display: none; padding: 6px 10px; font-size: 11px; }
    .references-body.open { display: block; }
    .ref-item {
      padding: 2px 0; display: flex; align-items: center; gap: 6px;
      color: var(--vscode-textLink-foreground); cursor: pointer;
    }
    .ref-item:hover { text-decoration: underline; }

    /* Turns indicator */
    .turns-badge {
      font-size: 10px; padding: 2px 7px; border-radius: 10px;
      background: var(--vscode-editorWidget-background);
      border: 1px solid var(--vscode-panel-border);
      color: var(--vscode-descriptionForeground);
    }

    /* Keyboard shortcuts overlay */
    .shortcuts-overlay {
      display: none; position: fixed; inset: 0; z-index: 200;
      background: rgba(0,0,0,0.5);
      align-items: center; justify-content: center;
    }
    .shortcuts-overlay.visible { display: flex; }
    .shortcuts-card {
      background: var(--vscode-editorWidget-background);
      border: 1px solid var(--vscode-panel-border);
      border-radius: 8px; padding: 20px 24px; min-width: 300px;
      box-shadow: 0 8px 24px rgba(0,0,0,0.3);
    }
    .shortcuts-title { font-size: 14px; font-weight: 600; margin-bottom: 12px; }
    .shortcut-row {
      display: flex; justify-content: space-between; padding: 5px 0;
      font-size: 12px; border-bottom: 1px solid var(--vscode-panel-border);
    }
    .shortcut-row:last-child { border-bottom: none; }
    .shortcut-key {
      font-family: var(--vscode-editor-font-family); font-size: 11px;
      padding: 1px 6px; border-radius: 3px;
      background: var(--vscode-textCodeBlock-background);
      border: 1px solid var(--vscode-panel-border);
    }

    /* Settings section */
    .settings-group { margin-bottom: 12px; }
    .settings-group-title {
      font-size: 11px; font-weight: 600; text-transform: uppercase;
      letter-spacing: 0.5px; color: var(--vscode-descriptionForeground);
      margin-bottom: 6px;
    }
    .setting-row {
      display: flex; align-items: center; justify-content: space-between;
      padding: 6px 0; font-size: 12px;
      border-bottom: 1px solid var(--vscode-panel-border);
    }
    .setting-row:last-child { border-bottom: none; }
    .setting-label { color: var(--vscode-foreground); }
    .setting-toggle {
      position: relative; width: 28px; height: 16px; border-radius: 8px;
      background: var(--vscode-descriptionForeground); cursor: pointer;
      border: none; transition: background 0.2s;
    }
    .setting-toggle.on { background: var(--vscode-terminal-ansiGreen, #4ec970); }
    .setting-toggle::after {
      content: ''; position: absolute; top: 2px; left: 2px;
      width: 12px; height: 12px; border-radius: 50%; background: #fff;
      transition: transform 0.2s;
    }
    .setting-toggle.on::after { transform: translateX(12px); }

    /* ─── Rich Approval Card ─── */
    .approval-card {
      margin: 8px 0 8px 26px; border-radius: var(--radius);
      border: 1px solid var(--vscode-editorWidget-border, var(--vscode-panel-border));
      background: var(--vscode-editorWidget-background);
      overflow: hidden;
    }
    .approval-card-header {
      display: flex; align-items: center; gap: 8px;
      padding: 10px 12px;
      border-bottom: 1px solid var(--vscode-panel-border);
    }
    .approval-card-icon {
      width: 28px; height: 28px; border-radius: 6px;
      display: flex; align-items: center; justify-content: center;
      background: var(--vscode-inputValidation-warningBackground, rgba(255,200,0,0.15));
      color: var(--vscode-editorWarning-foreground, #cca700);
    }
    .approval-card-info { flex: 1; }
    .approval-card-title { font-size: 12px; font-weight: 600; }
    .approval-card-subtitle { font-size: 11px; color: var(--vscode-descriptionForeground); }
    .approval-card-risk {
      font-size: 10px; padding: 2px 6px; border-radius: 3px; font-weight: 600;
    }
    .approval-card-risk.low { background: rgba(78,201,112,0.15); color: var(--vscode-terminal-ansiGreen, #4ec970); }
    .approval-card-risk.medium { background: rgba(204,167,0,0.15); color: var(--vscode-editorWarning-foreground, #cca700); }
    .approval-card-risk.high { background: rgba(241,76,76,0.15); color: var(--vscode-terminal-ansiRed, #f14c4c); }
    .approval-card-body {
      padding: 8px 12px; font-size: 11px;
      font-family: var(--vscode-editor-font-family);
      background: var(--vscode-editor-background);
      max-height: 120px; overflow-y: auto; white-space: pre-wrap;
    }
    .approval-card-actions {
      display: flex; gap: 6px; padding: 8px 12px;
      border-top: 1px solid var(--vscode-panel-border);
    }
    .approval-btn {
      padding: 4px 12px; border-radius: 4px; font-size: 11px; font-weight: 500;
      cursor: pointer; border: 1px solid transparent;
    }
    .approval-btn.allow {
      background: var(--vscode-button-background); color: var(--vscode-button-foreground);
      border-color: var(--vscode-button-background);
    }
    .approval-btn.allow:hover { background: var(--vscode-button-hoverBackground); }
    .approval-btn.deny {
      background: none; color: var(--vscode-descriptionForeground);
      border-color: var(--vscode-panel-border);
    }
    .approval-btn.deny:hover { background: var(--vscode-toolbar-hoverBackground); color: var(--vscode-foreground); }
    .approval-btn.always {
      background: none; color: var(--vscode-terminal-ansiGreen, #4ec970);
      border-color: var(--vscode-terminal-ansiGreen, #4ec970);
    }
    .approval-btn.always:hover { background: rgba(78,201,112,0.1); }

    /* ─── Toast Notifications ─── */
    .toast-container {
      position: fixed; top: 8px; right: 8px; z-index: 300;
      display: flex; flex-direction: column; gap: 6px;
      pointer-events: none;
    }
    .toast {
      display: flex; align-items: center; gap: 8px;
      padding: 8px 14px; border-radius: var(--radius);
      background: var(--vscode-editorWidget-background);
      border: 1px solid var(--vscode-panel-border);
      box-shadow: 0 4px 12px rgba(0,0,0,0.2);
      font-size: 12px; pointer-events: auto;
      animation: toast-in 0.3s ease;
      max-width: 280px;
    }
    .toast.success { border-left: 3px solid var(--vscode-terminal-ansiGreen, #4ec970); }
    .toast.error { border-left: 3px solid var(--vscode-terminal-ansiRed, #f14c4c); }
    .toast.info { border-left: 3px solid var(--vscode-inputValidation-infoBorder, #007acc); }
    .toast-icon { flex-shrink: 0; }
    .toast-text { flex: 1; }
    .toast-close {
      background: none; border: none; padding: 2px 4px; cursor: pointer;
      color: var(--vscode-descriptionForeground); border-radius: 3px;
    }
    .toast-close:hover { background: var(--vscode-toolbar-hoverBackground); }
    @keyframes toast-in { from { opacity: 0; transform: translateX(20px); } to { opacity: 1; transform: translateX(0); } }

    /* ─── Search in Conversation ─── */
    .search-bar {
      display: none; align-items: center; gap: 6px;
      padding: 6px 12px;
      border-bottom: 1px solid var(--vscode-panel-border);
      background: var(--vscode-editorWidget-background);
    }
    .search-bar.visible { display: flex; }
    .search-bar input {
      flex: 1; border: 1px solid var(--vscode-input-border);
      background: var(--vscode-input-background); color: var(--vscode-input-foreground);
      padding: 4px 8px; border-radius: 4px; font-size: 12px; outline: none;
    }
    .search-bar input:focus { border-color: var(--vscode-focusBorder); }
    .search-count { font-size: 11px; color: var(--vscode-descriptionForeground); white-space: nowrap; }
    .search-nav-btn {
      background: none; border: none; padding: 3px; border-radius: 3px;
      color: var(--vscode-descriptionForeground); cursor: pointer;
    }
    .search-nav-btn:hover { background: var(--vscode-toolbar-hoverBackground); color: var(--vscode-foreground); }
    .search-highlight { background: var(--vscode-editor-findMatchHighlightBackground, rgba(234,169,0,0.4)); border-radius: 2px; }
    .search-highlight.active { background: var(--vscode-editor-findMatchBackground, rgba(234,169,0,0.7)); }

    /* ─── Model Info Card ─── */
    .model-info-card {
      border: 1px solid var(--vscode-panel-border); border-radius: var(--radius);
      background: var(--vscode-editor-background); padding: 10px 12px; margin-bottom: 8px;
    }
    .model-info-header { display: flex; align-items: center; gap: 8px; margin-bottom: 8px; }
    .model-info-name { font-size: 12px; font-weight: 600; }
    .model-info-provider { font-size: 10px; color: var(--vscode-descriptionForeground); }
    .model-info-stats {
      display: grid; grid-template-columns: 1fr 1fr; gap: 6px;
    }
    .model-stat {
      font-size: 11px; display: flex; flex-direction: column; gap: 2px;
    }
    .model-stat-label { color: var(--vscode-descriptionForeground); font-size: 10px; }
    .model-stat-value { font-weight: 600; }

    /* ─── Custom Agent Dialog ─── */
    .agent-dialog-overlay {
      display: none; position: fixed; inset: 0; z-index: 200;
      background: rgba(0,0,0,0.5); align-items: center; justify-content: center;
    }
    .agent-dialog-overlay.visible { display: flex; }
    .agent-dialog {
      background: var(--vscode-editorWidget-background);
      border: 1px solid var(--vscode-panel-border);
      border-radius: 8px; padding: 20px; width: 320px;
      box-shadow: 0 8px 24px rgba(0,0,0,0.3);
    }
    .agent-dialog-title { font-size: 14px; font-weight: 600; margin-bottom: 14px; }
    .agent-field { margin-bottom: 10px; }
    .agent-field label {
      display: block; font-size: 11px; font-weight: 600;
      color: var(--vscode-descriptionForeground); margin-bottom: 4px;
    }
    .agent-field input, .agent-field textarea, .agent-field select {
      width: 100%; padding: 6px 8px; border-radius: 4px;
      border: 1px solid var(--vscode-input-border);
      background: var(--vscode-input-background); color: var(--vscode-input-foreground);
      font-size: 12px; font-family: var(--vscode-font-family); outline: none;
    }
    .agent-field input:focus, .agent-field textarea:focus { border-color: var(--vscode-focusBorder); }
    .agent-field textarea { resize: vertical; min-height: 60px; }
    .agent-dialog-actions { display: flex; gap: 8px; justify-content: flex-end; margin-top: 14px; }
    .agent-dialog-btn {
      padding: 5px 14px; border-radius: 4px; font-size: 12px; cursor: pointer; border: none;
    }
    .agent-dialog-btn.primary { background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
    .agent-dialog-btn.primary:hover { background: var(--vscode-button-hoverBackground); }
    .agent-dialog-btn.secondary { background: none; border: 1px solid var(--vscode-panel-border); color: var(--vscode-foreground); }
    .agent-dialog-btn.secondary:hover { background: var(--vscode-toolbar-hoverBackground); }

    /* ─── Drag & Drop Zone ─── */
    .drop-zone {
      display: none; position: absolute; inset: 0; z-index: 60;
      background: rgba(0,120,212,0.08);
      border: 2px dashed var(--vscode-focusBorder);
      border-radius: var(--radius);
      align-items: center; justify-content: center;
      flex-direction: column; gap: 8px;
    }
    .drop-zone.active { display: flex; }
    .drop-zone-icon { opacity: 0.4; }
    .drop-zone-text { font-size: 12px; color: var(--vscode-descriptionForeground); }

    /* ─── Markdown table ─── */
    .msg-content table {
      border-collapse: collapse; margin: 0.6em 0; font-size: 12px; width: 100%;
    }
    .msg-content th, .msg-content td {
      border: 1px solid var(--vscode-panel-border); padding: 4px 8px; text-align: left;
    }
    .msg-content th {
      background: var(--vscode-editorWidget-background); font-weight: 600;
    }
    .msg-content tr:nth-child(even) td {
      background: var(--vscode-textCodeBlock-background);
    }
    .msg-content a {
      color: var(--vscode-textLink-foreground); text-decoration: none;
    }
    .msg-content a:hover { text-decoration: underline; }

    /* ─── Progress Bar ─── */
    .progress-card {
      margin: 6px 0 6px 26px; border: 1px solid var(--vscode-panel-border);
      border-radius: var(--radius); overflow: hidden; padding: 10px 12px;
      background: var(--vscode-editorWidget-background);
    }
    .progress-label { font-size: 11px; margin-bottom: 6px; color: var(--vscode-descriptionForeground); }
    .progress-track {
      height: 4px; border-radius: 2px; background: var(--vscode-progressBar-background, rgba(0,120,212,0.2));
      overflow: hidden;
    }
    .progress-fill {
      height: 100%; border-radius: 2px;
      background: var(--vscode-progressBar-background, #0078d4);
      transition: width 0.3s ease;
    }
    .progress-fill.indeterminate {
      width: 40% !important; animation: progress-slide 1.5s infinite ease-in-out;
    }
    @keyframes progress-slide { 0% { transform: translateX(-100%); } 100% { transform: translateX(350%); } }

    /* ─── Collapsible Messages (F1.2) ─── */
    .msg.collapsible .msg-content { max-height: 300px; overflow: hidden; position: relative; }
    .msg.collapsible .msg-content.collapsed::after {
      content: ''; position: absolute; bottom: 0; left: 0; right: 0;
      height: 40px; background: linear-gradient(transparent, var(--vscode-sideBar-background));
      pointer-events: none;
    }
    .msg-expand-btn {
      display: none; margin: 4px 0 0 26px; background: none; border: none;
      color: var(--vscode-textLink-foreground); font-size: 11px;
      cursor: pointer; padding: 2px 0;
    }
    .msg.collapsible .msg-expand-btn { display: inline-block; }
    .msg-expand-btn:hover { text-decoration: underline; }

    /* ─── Diff Preview (F1.2) ─── */
    .diff-card {
      margin: 8px 0 8px 26px; border: 1px solid var(--vscode-panel-border);
      border-radius: var(--radius); overflow: hidden;
    }
    .diff-card-header {
      display: flex; align-items: center; gap: 8px;
      padding: 8px 12px;
      background: var(--vscode-editorWidget-background);
      font-size: 12px;
    }
    .diff-card-file {
      font-weight: 600; flex: 1;
      color: var(--vscode-foreground);
    }
    .diff-card-actions { display: flex; gap: 4px; }
    .diff-accept-btn {
      padding: 3px 10px; border-radius: 4px; font-size: 11px; cursor: pointer; border: none;
      background: var(--vscode-terminal-ansiGreen, #4ec970); color: #fff; font-weight: 500;
    }
    .diff-accept-btn:hover { opacity: 0.85; }
    .diff-reject-btn {
      padding: 3px 10px; border-radius: 4px; font-size: 11px; cursor: pointer;
      border: 1px solid var(--vscode-panel-border); background: none;
      color: var(--vscode-descriptionForeground);
    }
    .diff-reject-btn:hover { background: var(--vscode-toolbar-hoverBackground); color: var(--vscode-foreground); }
    .diff-card-body {
      font-family: var(--vscode-editor-font-family); font-size: 12px;
      line-height: 1.6; padding: 0; overflow-x: auto;
      max-height: 300px; overflow-y: auto;
    }
    .diff-card-body .diff-line {
      padding: 0 12px; white-space: pre; display: block;
    }
    .diff-card-body .diff-line-add { background: var(--vscode-diffEditor-insertedTextBackground, rgba(0,180,0,0.12)); }
    .diff-card-body .diff-line-del { background: var(--vscode-diffEditor-removedTextBackground, rgba(255,0,0,0.12)); }
    .diff-card-body .diff-line-ctx { color: var(--vscode-descriptionForeground); }
    .diff-card-body .diff-line-hdr { color: var(--vscode-descriptionForeground); font-weight: 500; background: var(--vscode-editorWidget-background); }
    .diff-card.accepted { opacity: 0.6; }
    .diff-card.accepted .diff-card-actions { display: none; }
    .diff-card.rejected { opacity: 0.5; }
    .diff-card.rejected .diff-card-body { display: none; }

    /* ─── Syntax Highlight Token Colors ─── */
    .tok-keyword { color: var(--vscode-debugTokenExpression-name, #569cd6); }
    .tok-string { color: var(--vscode-debugTokenExpression-string, #ce9178); }
    .tok-number { color: var(--vscode-debugTokenExpression-number, #b5cea8); }
    .tok-comment { color: var(--vscode-descriptionForeground); font-style: italic; }
    .tok-function { color: var(--vscode-symbolIcon-functionForeground, #dcdcaa); }
    .tok-type { color: var(--vscode-symbolIcon-classForeground, #4ec9b0); }
    .tok-operator { color: var(--vscode-foreground); }
    .tok-punctuation { color: var(--vscode-descriptionForeground); }

    /* ─── Input Composite (Copilot-style) ─── */
    .input-composite {
      border-top: 1px solid var(--vscode-panel-border);
      background: var(--vscode-sideBar-background);
    }

    .input-area { padding: 10px 12px 0 12px; position: relative; }
    .input-box {
      border: 1px solid var(--vscode-input-border); border-radius: var(--radius);
      background: var(--vscode-input-background); overflow: hidden;
      transition: border-color var(--transition);
    }
    .input-box:focus-within { border-color: var(--vscode-focusBorder); }
    .input-box textarea {
      width: 100%; border: none; background: transparent;
      color: var(--vscode-input-foreground);
      padding: 8px 10px; font-family: var(--vscode-font-family);
      font-size: var(--vscode-font-size); resize: none;
      min-height: 36px; max-height: 140px; line-height: 1.5; outline: none;
    }

    .input-bottom {
      display: flex; align-items: center; padding: 6px 12px 8px 12px;
      min-height: 36px;
    }
    .input-bottom-left { display: flex; align-items: center; gap: 6px; flex: 1; }
    .input-bottom-right { display: flex; align-items: center; gap: 8px; flex-shrink: 0; }

    /* Agent dropdown wrapper — needs relative for popup positioning */
    .agent-dropdown-wrap { position: relative; display: inline-flex; align-items: center; }

    /* Chat/Agent toggle — single button */
    .mode-toggle-single {
      background: none; border: 1px solid var(--vscode-panel-border); border-radius: 4px;
      color: var(--vscode-foreground); font-size: 11px; padding: 0 10px;
      cursor: pointer; font-family: var(--vscode-font-family); font-weight: 600;
      transition: background 0.15s; height: 24px; line-height: 24px;
    }
    .mode-toggle-single:hover { background: var(--vscode-toolbar-hoverBackground); }

    /* New chat + button */
    .new-chat-btn {
      background: none; border: 1px solid var(--vscode-panel-border); border-radius: 4px;
      color: var(--vscode-descriptionForeground); cursor: pointer;
      width: 24px; height: 24px; display: inline-flex; align-items: center; justify-content: center;
      flex-shrink: 0;
    }
    .new-chat-btn:hover { background: var(--vscode-toolbar-hoverBackground); color: var(--vscode-foreground); border-color: var(--vscode-focusBorder); }

    /* Agent/Mode dropdown */
    .agent-dropdown {
      display: inline-flex; align-items: center; gap: 4px;
      background: none; border: 1px solid var(--vscode-panel-border); border-radius: 4px;
      color: var(--vscode-foreground); cursor: pointer;
      padding: 0 8px; font-size: 11px; font-weight: 500;
      height: 24px; position: relative; flex-shrink: 0;
    }
    .agent-dropdown:hover { background: var(--vscode-toolbar-hoverBackground); border-color: var(--vscode-focusBorder); }
    .agent-dropdown > svg { opacity: 0.6; }
    .agent-dropdown-icon { display: inline-flex; align-items: center; }
    .agent-dropdown-icon svg { width: 13px; height: 13px; opacity: 0.8; }

    /* Agent dropdown popup */
    .agent-popup {
      display: none; position: absolute; bottom: calc(100% + 4px); left: 0;
      min-width: 200px; background: var(--vscode-editorWidget-background);
      border: 1px solid var(--vscode-editorWidget-border, var(--vscode-panel-border));
      border-radius: var(--radius); box-shadow: 0 -4px 16px rgba(0,0,0,0.35);
      z-index: 300; padding: 4px 0; max-height: 280px; overflow-y: auto;
    }
    .agent-popup.visible { display: block; }
    .agent-popup-item {
      padding: 6px 12px; font-size: 12px; cursor: pointer;
      display: flex; align-items: center; gap: 8px;
    }
    .agent-popup-item:hover { background: var(--vscode-list-hoverBackground); }
    .agent-popup-item.active { background: var(--vscode-list-activeSelectionBackground); color: var(--vscode-list-activeSelectionForeground); }
    .agent-popup-item svg { opacity: 0.7; width: 14px; height: 14px; color: inherit; fill: none; }
    .agent-popup-divider { height: 1px; background: var(--vscode-panel-border); margin: 4px 0; }
    .agent-popup-item.create { color: var(--vscode-textLink-foreground); }

    /* Tools config icon */
    .tools-btn {
      background: none; border: none; border-radius: 4px;
      color: var(--vscode-descriptionForeground); cursor: pointer;
      width: 24px; height: 24px; display: inline-flex; align-items: center; justify-content: center;
      flex-shrink: 0;
    }
    .tools-btn:hover { background: var(--vscode-toolbar-hoverBackground); color: var(--vscode-foreground); }

    .context-btn {
      display: inline-flex; align-items: center; gap: 4px;
      background: none; border: none; font-size: 12px;
      color: var(--vscode-descriptionForeground); cursor: pointer;
      padding: 3px 6px; border-radius: 4px;
    }
    .context-btn:hover { background: var(--vscode-toolbar-hoverBackground); color: var(--vscode-foreground); }
    .context-btn svg { opacity: 0.6; }

    .model-select {
      background: var(--vscode-dropdown-background); color: var(--vscode-dropdown-foreground);
      border: none; font-size: 11px; padding: 0 8px; border-radius: 4px;
      cursor: pointer; font-family: var(--vscode-font-family);
      max-width: 140px; text-overflow: ellipsis; height: 24px;
      color-scheme: dark;
      -webkit-appearance: none; -moz-appearance: none; appearance: none;
    }
    .model-select option {
      background: var(--vscode-dropdown-background, #1e1e1e);
      color: var(--vscode-dropdown-foreground, #ccc);
    }
    .model-select:hover { background: var(--vscode-toolbar-hoverBackground); }
    .model-select:focus { outline: 1px solid var(--vscode-focusBorder); }
    .model-select:disabled { opacity: 0.4; cursor: default; }

    /* Context ring (circular gauge) */
    .context-ring {
      position: relative; width: 22px; height: 22px;
      display: flex; align-items: center; justify-content: center;
      cursor: default;
    }
    .context-ring svg { position: absolute; top: 0; left: 0; }
    .context-ring-fill { transition: stroke-dashoffset 0.4s ease; }
    .context-ring-label {
      font-size: 7px; font-weight: 600; color: var(--vscode-descriptionForeground);
      position: relative; z-index: 1;
    }

    .send-btn {
      background: var(--vscode-button-background); color: var(--vscode-button-foreground);
      border: none; padding: 0 10px; border-radius: 4px; height: 24px;
      cursor: pointer; display: inline-flex; align-items: center; justify-content: center;
      transition: all var(--transition);
    }
    .send-btn:hover { background: var(--vscode-button-hoverBackground); }
    .send-btn:disabled { opacity: 0.35; cursor: default; }

    .enhance-btn {
      background: none; border: none; padding: 0 6px; border-radius: 4px;
      color: var(--vscode-descriptionForeground); cursor: pointer;
      display: inline-flex; align-items: center; height: 24px;
    }
    .enhance-btn:hover { background: var(--vscode-toolbar-hoverBackground); color: var(--vscode-foreground); }
    .enhance-btn.enhancing { animation: pulse 1s infinite; }

    /* Context popup */
    #context-popup {
      display: none; position: absolute; bottom: 100%; left: 0; right: 0;
      max-height: 200px; overflow-y: auto;
      background: var(--vscode-editorWidget-background);
      border: 1px solid var(--vscode-editorWidget-border, var(--vscode-panel-border));
      border-radius: var(--radius); box-shadow: 0 -4px 12px rgba(0,0,0,0.2); z-index: 100;
    }
    .ctx-item {
      padding: 6px 10px; font-size: 12px; cursor: pointer;
      white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
      display: flex; align-items: center; gap: 6px;
    }
    .ctx-item svg { flex-shrink: 0; opacity: 0.5; }
    .ctx-item:hover, .ctx-item.selected { background: var(--vscode-list-hoverBackground); }

    /* Approve bar (compact, inside input composite) */
    .approve-bar {
      display: flex; align-items: center; gap: 2px;
      padding: 2px 12px 6px 12px; font-size: 11px;
    }
    .approve-label {
      font-size: 10px; color: var(--vscode-descriptionForeground);
      text-transform: uppercase; letter-spacing: 0.5px; margin-right: 4px;
    }
    .approve-toggle {
      display: inline-flex; align-items: center; gap: 3px;
      font-size: 11px; padding: 1px 5px; border-radius: 3px;
      cursor: pointer; user-select: none;
      color: var(--vscode-descriptionForeground); border: none; background: none;
    }
    .approve-toggle:hover { background: var(--vscode-toolbar-hoverBackground); }
    .approve-toggle.active { color: var(--vscode-terminal-ansiGreen, #4ec970); }
    .approve-toggle input { display: none; }
    .approve-dot { width: 5px; height: 5px; border-radius: 50%; background: currentColor; opacity: 0.4; }
    .approve-toggle.active .approve-dot { opacity: 1; }

    /* ─── Context Chips ─── */
    .context-chips {
      display: flex; flex-wrap: wrap; gap: 4px;
      padding: 0 12px; min-height: 0;
    }
    .context-chips:empty { display: none; padding: 0; }
    .context-chips:not(:empty) { padding-top: 6px; }
    .chip {
      display: inline-flex; align-items: center; gap: 4px;
      height: 22px; padding: 0 8px;
      border-radius: 999px;
      border: 1px solid var(--vscode-panel-border);
      background: var(--vscode-editor-background);
      font-size: 11px;
      color: var(--vscode-foreground);
      white-space: nowrap;
      max-width: 200px;
      overflow: hidden; text-overflow: ellipsis;
    }
    .chip svg { flex-shrink: 0; opacity: 0.5; }
    .chip-remove {
      cursor: pointer; border: none; background: none;
      color: var(--vscode-descriptionForeground); font-size: 13px;
      line-height: 1; padding: 0 0 0 2px;
    }
    .chip-remove:hover { color: var(--vscode-errorForeground); }

    /* ─── Slash Command Menu ─── */
    #slash-popup {
      display: none; position: absolute; bottom: 100%; left: 0; right: 0;
      max-height: 200px; overflow-y: auto;
      background: var(--vscode-editorWidget-background);
      border: 1px solid var(--vscode-editorWidget-border, var(--vscode-panel-border));
      border-radius: var(--radius); box-shadow: 0 -4px 12px rgba(0,0,0,0.2); z-index: 100;
    }
    .slash-item {
      padding: 7px 10px; font-size: 12px; cursor: pointer;
      display: flex; align-items: baseline; gap: 8px;
    }
    .slash-item:hover, .slash-item.selected {
      background: var(--vscode-list-hoverBackground);
    }
    .slash-cmd { font-weight: 600; color: var(--vscode-foreground); }
    .slash-desc { color: var(--vscode-descriptionForeground); font-size: 11px; }

    /* ─── Stop Button ─── */
    .stop-btn {
      display: none; align-items: center; justify-content: center; gap: 4px;
      background: var(--vscode-inputValidation-errorBackground, rgba(255,0,0,0.1));
      border: 1px solid var(--vscode-inputValidation-errorBorder, #be1100);
      color: var(--vscode-errorForeground, #f14c4c);
      border-radius: 4px; padding: 3px 10px;
      font-size: 11px; cursor: pointer;
    }
    .stop-btn.visible { display: inline-flex; }
    .stop-btn:hover { background: rgba(255,0,0,0.18); }

    /* ─── Input Counter ─── */
    .input-counter {
      font-size: 10px;
      color: var(--vscode-descriptionForeground);
      margin-left: auto;
      white-space: nowrap;
    }
    .input-counter.warn { color: var(--vscode-editorWarning-foreground, #cca700); }

    /* ─── Clickable agent items ─── */
    .list-item.clickable { cursor: pointer; transition: border-color var(--transition); }
    .list-item.clickable:hover { border-color: var(--vscode-focusBorder); }

    /* ─── History search ─── */
    .history-search {
      padding: 6px 12px;
      border-bottom: 1px solid var(--vscode-panel-border);
    }
    .history-search input {
      width: 100%; border: 1px solid var(--vscode-input-border);
      background: var(--vscode-input-background);
      color: var(--vscode-input-foreground);
      padding: 4px 8px; border-radius: 4px;
      font-size: 12px; outline: none;
    }
    .history-search input:focus { border-color: var(--vscode-focusBorder); }
    .history-group-label {
      padding: 6px 14px 2px; font-size: 10px;
      text-transform: uppercase; letter-spacing: 0.5px;
      color: var(--vscode-descriptionForeground); font-weight: 600;
    }
  </style>
</head>
<body>
  <div id="app">
    <!-- Header -->
    <div class="header">
      <div class="header-brand">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/></svg>
        <span>OpenCob</span>
        <span class="workspace-scope-pill" id="workspace-scope" title="Workspace scope">scope: loading...</span>
      </div>
      <div class="header-spacer"></div>
      <span class="turns-badge" id="turns-badge" title="Conversation turns">0 turns</span>
      <span id="status-indicator" class="idle"></span>
      <button class="header-btn" id="shortcuts-btn" title="Keyboard shortcuts (Ctrl+/)">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="2" y="4" width="20" height="16" rx="2"/><path d="M6 8h.01M10 8h.01M14 8h.01M18 8h.01M8 12h.01M12 12h.01M16 12h.01M7 16h10"/></svg>
      </button>
      <button class="header-btn" id="history-btn" title="Chat history">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>
      </button>
      <button class="header-btn" id="new-chat-btn" title="New conversation">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
      </button>
    </div>

    <div class="workspace-scope-menu hidden" id="workspace-scope-menu"></div>

    <!-- History Panel (hidden by default) -->
    <div id="history-panel" class="history-panel hidden">
      <div class="history-header">
        <span>Chat History</span>
        <button id="history-close">&times;</button>
      </div>
      <div class="history-search">
        <input type="text" id="history-search-input" placeholder="Search conversations..." />
      </div>
      <div class="history-list" id="history-list">
        <div class="history-empty">No conversations yet</div>
      </div>
    </div>

    <div id="right-drawer" class="right-drawer hidden">
      <div class="drawer-header">
        <span id="drawer-title">Workspace</span>
        <button class="header-btn" id="drawer-close" title="Close">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
        </button>
      </div>
      <div class="drawer-tabs">
        <button class="drawer-tab active" data-drawer-tab="tools">Tools</button>
        <button class="drawer-tab" data-drawer-tab="modes">Agents</button>
        <button class="drawer-tab" data-drawer-tab="session">Session</button>
        <button class="drawer-tab" data-drawer-tab="settings">Settings</button>
      </div>
      <div class="drawer-body">
        <div class="drawer-section" id="drawer-tools"></div>
        <div class="drawer-section hidden" id="drawer-modes"></div>
        <div class="drawer-section hidden" id="drawer-session"></div>
        <div class="drawer-section hidden" id="drawer-settings">
          <div class="settings-group">
            <div class="settings-group-title">Interface</div>
            <div class="setting-row"><span class="setting-label">Show timestamps</span><button class="setting-toggle on" data-setting="timestamps"></button></div>
            <div class="setting-row"><span class="setting-label">Show thinking animation</span><button class="setting-toggle on" data-setting="thinking"></button></div>
            <div class="setting-row"><span class="setting-label">Stream responses</span><button class="setting-toggle on" data-setting="streaming"></button></div>
          </div>
          <div class="settings-group">
            <div class="settings-group-title">Behavior</div>
            <div class="setting-row"><span class="setting-label">Auto-scroll on response</span><button class="setting-toggle on" data-setting="autoscroll"></button></div>
            <div class="setting-row"><span class="setting-label">Sound notifications</span><button class="setting-toggle" data-setting="sounds"></button></div>
            <div class="setting-row"><span class="setting-label">Save conversations</span><button class="setting-toggle on" data-setting="saveHistory"></button></div>
          </div>
          <div class="settings-group">
            <div class="settings-group-title">Context</div>
            <div class="setting-row"><span class="setting-label">Max context tokens</span><span class="muted">128k</span></div>
            <div class="setting-row"><span class="setting-label">Include workspace files</span><button class="setting-toggle on" data-setting="wsContext"></button></div>
            <div class="setting-row"><span class="setting-label">Include git history</span><button class="setting-toggle" data-setting="gitContext"></button></div>
          </div>
        </div>
      </div>
    </div>

    <!-- Search in conversation -->
    <div class="search-bar" id="search-bar">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/></svg>
      <input type="text" id="search-input" placeholder="Search in conversation..." />
      <span class="search-count" id="search-count"></span>
      <button class="search-nav-btn" id="search-prev" title="Previous">
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="18 15 12 9 6 15"/></svg>
      </button>
      <button class="search-nav-btn" id="search-next" title="Next">
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="6 9 12 15 18 9"/></svg>
      </button>
      <button class="search-nav-btn" id="search-close" title="Close">
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
      </button>
    </div>

    <!-- Messages -->
    <div class="messages" id="messages" style="position: relative;">
      <div class="drop-zone" id="drop-zone">
        <svg class="drop-zone-icon" width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>
        <span class="drop-zone-text">Drop files to add as context</span>
      </div>
      <div class="welcome" id="welcome">
        <svg class="welcome-icon" viewBox="0 0 128 128"><rect width="128" height="128" rx="16" fill="transparent"/><rect x="40" y="76" width="48" height="32" rx="6" fill="#1a1a1a" stroke="#33ff33" stroke-width="1.5"/><rect x="48" y="80" width="32" height="16" rx="3" fill="#0d1a0d" stroke="#33ff33" stroke-width="0.8"/><line x1="51" y1="85" x2="68" y2="85" stroke="#33ff33" stroke-width="1" opacity="0.8"/><line x1="51" y1="89" x2="75" y2="89" stroke="#33ff33" stroke-width="1" opacity="0.6"/><line x1="51" y1="93" x2="63" y2="93" stroke="#33ff33" stroke-width="1" opacity="0.7"/><rect x="58" y="70" width="12" height="7" rx="2" fill="#1a1a1a" stroke="#33ff33" stroke-width="1"/><rect x="46" y="20" width="36" height="52" rx="18" fill="#2d5a00" stroke="#33ff33" stroke-width="1.5"/><path d="M46 30 Q36 38 35 50 Q37 60 43 68" fill="#1a3d00" fill-opacity="0.6" stroke="#33ff33" stroke-width="1.5" stroke-linecap="round"/><path d="M82 30 Q92 38 93 50 Q91 60 85 68" fill="#1a3d00" fill-opacity="0.6" stroke="#33ff33" stroke-width="1.5" stroke-linecap="round"/><path d="M61 20 Q60 12 58 6" fill="none" stroke="#33ff33" stroke-width="1" stroke-linecap="round" opacity="0.7"/><path d="M64 20 Q64 11 64 4" fill="none" stroke="#33ff33" stroke-width="1.2" stroke-linecap="round" opacity="0.8"/><path d="M67 20 Q68 12 70 6" fill="none" stroke="#33ff33" stroke-width="1" stroke-linecap="round" opacity="0.7"/><rect x="53" y="35" width="10" height="8" rx="2" fill="#0d1a0d" stroke="#33ff33" stroke-width="1.2"/><rect x="56" y="37" width="4" height="4" rx="1" fill="#33ff33"/><rect x="57" y="38" width="2" height="2" fill="#88ff88"/><path d="M77 35 L70 39 L77 43" fill="none" stroke="#33ff33" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/><path d="M57 54 Q64 61 71 54" fill="#0d1a0d" stroke="#33ff33" stroke-width="1.5" stroke-linecap="round"/><rect x="28" y="78" width="10" height="24" rx="5" fill="#1a1a1a" stroke="#33ff33" stroke-width="1.2"/><g><animateTransform attributeName="transform" type="rotate" values="0 95 78;-20 95 78;0 95 78" dur="1s" repeatCount="indefinite"/><rect x="90" y="78" width="10" height="24" rx="5" fill="#1a1a1a" stroke="#33ff33" stroke-width="1.2"/><circle cx="95" cy="78" r="4" fill="#1a1a1a" stroke="#33ff33" stroke-width="1"/><circle cx="95" cy="104" r="5" fill="#1a1a1a" stroke="#33ff33" stroke-width="1.2"/></g><circle cx="33" cy="78" r="4" fill="#1a1a1a" stroke="#33ff33" stroke-width="1"/><circle cx="33" cy="104" r="5" fill="#1a1a1a" stroke="#33ff33" stroke-width="1.2"/><rect x="48" y="108" width="10" height="12" rx="4" fill="#1a1a1a" stroke="#33ff33" stroke-width="1.2"/><rect x="70" y="108" width="10" height="12" rx="4" fill="#1a1a1a" stroke="#33ff33" stroke-width="1.2"/><ellipse cx="53" cy="122" rx="8" ry="4" fill="#1a1a1a" stroke="#33ff33" stroke-width="1.2"/><ellipse cx="75" cy="122" rx="8" ry="4" fill="#1a1a1a" stroke="#33ff33" stroke-width="1.2"/></svg>
        <h2>OpenCob</h2>
        <p>AI-powered COBOL analysis, refactoring, and modernization assistant.</p>
        <div class="welcome-actions">
          <button class="welcome-action" data-prompt="Explain the structure of this workspace">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>
            <span>Explain workspace</span>
          </button>
          <button class="welcome-action" data-prompt="Find potential issues and code smells in the current project">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="m21 21-4.35-4.35"/><circle cx="11" cy="11" r="8"/></svg>
            <span>Scan for issues</span>
          </button>
          <button class="welcome-action" data-prompt="Help me refactor the selected code for better readability">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"/></svg>
            <span>Refactor code</span>
          </button>
        </div>
      </div>
      <button class="scroll-fab" id="scroll-fab" title="Scroll to bottom">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="6 9 12 15 18 9"/></svg>
      </button>
    </div>

    <!-- Input Composite (Copilot-style) -->
    <div class="input-composite">
      <!-- Context chips -->
      <div class="context-chips" id="context-chips"></div>

      <!-- Input area -->
      <div class="input-area">
        <div id="context-popup"><div id="context-list"></div></div>
        <div id="slash-popup"></div>
        <div id="at-popup"></div>
        <div class="input-box">
          <textarea id="input" rows="1" placeholder="Ask OpenCob or type / for commands, @ for participants"></textarea>
        </div>
      </div>

      <!-- Bottom bar: + | Chat/Agent toggle | /Agent ▼ | model ▼ | ⚙ tools | ... | Send -->
      <div class="input-bottom">
        <div class="input-bottom-left">
          <button class="new-chat-btn" id="new-chat-bottom-btn" title="New conversation (Ctrl+N)">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
          </button>
          <button class="mode-toggle-single" id="mode-toggle-btn" title="Toggle Chat/Agent mode">Agent</button>
          <div class="agent-dropdown-wrap">
            <button class="agent-dropdown" id="agent-dropdown" title="Switch agent mode">
              <span id="agent-dropdown-icon" class="agent-dropdown-icon"></span>
              <span id="agent-dropdown-label">Agent</span>
              <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="6 9 12 15 18 9"/></svg>
            </button>
            <div class="agent-popup" id="agent-popup"></div>
          </div>
          <select class="model-select" id="model-select" title="Switch model"${modelDisabled}>
            ${modelOptions}
          </select>
          <button class="tools-btn" id="tools-config-btn" title="Configure tools">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>
          </button>
          <button class="enhance-btn" id="enhance-btn" title="Enhance prompt with AI">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="m12 3-1.9 5.8a2 2 0 0 1-1.3 1.3L3 12l5.8 1.9a2 2 0 0 1 1.3 1.3L12 21l1.9-5.8a2 2 0 0 1 1.3-1.3L21 12l-5.8-1.9a2 2 0 0 1-1.3-1.3L12 3Z"/></svg>
          </button>
          <button class="stop-btn" id="stop-btn" title="Stop generation">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor"><rect x="4" y="4" width="16" height="16" rx="2"/></svg>
            Stop
          </button>
          <span class="input-counter" id="input-counter"></span>
        </div>
        <div class="input-bottom-right">
          <div class="context-ring" id="context-ring" title="Context usage">
            <svg width="22" height="22" viewBox="0 0 36 36">
              <circle cx="18" cy="18" r="15" fill="none" stroke="var(--vscode-editorWidget-background)" stroke-width="3"/>
              <circle class="context-ring-fill" id="context-ring-fill" cx="18" cy="18" r="15" fill="none" stroke="var(--vscode-focusBorder)" stroke-width="3" stroke-dasharray="94.2" stroke-dashoffset="94.2" stroke-linecap="round" transform="rotate(-90 18 18)"/>
            </svg>
            <span class="context-ring-label" id="context-ring-label">0%</span>
          </div>
          <button class="send-btn" id="send-btn" title="Send (Enter)">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg>
          </button>
        </div>
      </div>

      <!-- Auto-approve (compact) -->
      <div class="approve-bar">
        <span class="approve-label">Auto-approve</span>
        <label class="approve-toggle" title="Auto-approve reads"><input type="checkbox" data-group="read"><span class="approve-dot"></span> Read</label>
        <label class="approve-toggle" title="Auto-approve writes"><input type="checkbox" data-group="edit"><span class="approve-dot"></span> Write</label>
        <label class="approve-toggle" title="Auto-approve commands"><input type="checkbox" data-group="command"><span class="approve-dot"></span> Cmd</label>
        <label class="approve-toggle" title="Auto-approve MCP"><input type="checkbox" data-group="mcp"><span class="approve-dot"></span> MCP</label>
      </div>
    </div>
  </div>

  <!-- Keyboard shortcuts overlay -->
  <div class="shortcuts-overlay" id="shortcuts-overlay">
    <div class="shortcuts-card">
      <div class="shortcuts-title">Keyboard Shortcuts</div>
      <div class="shortcut-row"><span>Send message</span><span class="shortcut-key">Enter</span></div>
      <div class="shortcut-row"><span>New line</span><span class="shortcut-key">Shift+Enter</span></div>
      <div class="shortcut-row"><span>New conversation</span><span class="shortcut-key">Ctrl+N</span></div>
      <div class="shortcut-row"><span>Add context file</span><span class="shortcut-key"># + filename</span></div>
      <div class="shortcut-row"><span>Mention participant</span><span class="shortcut-key">@ + name</span></div>
      <div class="shortcut-row"><span>Slash commands</span><span class="shortcut-key">/ + command</span></div>
      <div class="shortcut-row"><span>Toggle history</span><span class="shortcut-key">Ctrl+H</span></div>
      <div class="shortcut-row"><span>Show shortcuts</span><span class="shortcut-key">Ctrl+/</span></div>
      <div class="shortcut-row"><span>Stop generation</span><span class="shortcut-key">Escape</span></div>
      <div class="shortcut-row"><span>Search in conversation</span><span class="shortcut-key">Ctrl+F</span></div>
      <div class="shortcut-row"><span>Focus input</span><span class="shortcut-key">Ctrl+L</span></div>
      <div class="shortcut-row"><span>Cycle mode</span><span class="shortcut-key">Ctrl+.</span></div>
    </div>
  </div>

  <!-- Custom Agent Dialog -->
  <div class="agent-dialog-overlay" id="agent-dialog-overlay">
    <div class="agent-dialog">
      <div class="agent-dialog-title">Create Custom Agent</div>
      <div class="agent-field"><label>Name</label><input type="text" id="agent-name" placeholder="e.g. security-reviewer" /></div>
      <div class="agent-field"><label>Display Name</label><input type="text" id="agent-display" placeholder="e.g. Security Reviewer" /></div>
      <div class="agent-field"><label>Role Definition</label><textarea id="agent-role" placeholder="You are an expert security reviewer who..."></textarea></div>
      <div class="agent-field"><label>When to Use</label><input type="text" id="agent-when" placeholder="When the user asks about security..." /></div>
      <div class="agent-field">
        <label>Tool Groups</label>
        <select id="agent-tools" multiple>
          <option value="read" selected>Read</option>
          <option value="edit">Edit</option>
          <option value="command">Command</option>
          <option value="mcp">MCP</option>
          <option value="browser">Browser</option>
        </select>
      </div>
      <div class="agent-dialog-actions">
        <button class="agent-dialog-btn secondary" id="agent-cancel">Cancel</button>
        <button class="agent-dialog-btn primary" id="agent-create">Create Agent</button>
      </div>
    </div>
  </div>

  <!-- Toast container -->
  <div class="toast-container" id="toast-container"></div>

  <script>
    const vscode = acquireVsCodeApi();
    const messagesEl = document.getElementById('messages');
    const welcomeEl = document.getElementById('welcome');
    const input = document.getElementById('input');
    const sendBtn = document.getElementById('send-btn');
    const enhanceBtn = document.getElementById('enhance-btn');
    const modelSelect = document.getElementById('model-select');
    const statusEl = document.getElementById('status-indicator');
    const newChatBtn = document.getElementById('new-chat-btn');
    const historyBtn = document.getElementById('history-btn');
    const historyPanel = document.getElementById('history-panel');
    const historyClose = document.getElementById('history-close');
    const workspaceScopePill = document.getElementById('workspace-scope');
    const workspaceScopeMenu = document.getElementById('workspace-scope-menu');
    const historyList = document.getElementById('history-list');
    const attachBtn = document.getElementById('attach-btn');
    const modePill = document.getElementById('mode-pill');
    const toolsBtn = document.getElementById('tools-btn');
    const sessionBtn = document.getElementById('session-btn');
    const activeModeLabel = document.getElementById('active-mode-label');
    const contextRingFill = document.getElementById('context-ring-fill');
    const contextRingLabel = document.getElementById('context-ring-label');
    const rightDrawer = document.getElementById('right-drawer');
    const drawerClose = document.getElementById('drawer-close');
    const drawerTitle = document.getElementById('drawer-title');
    const drawerTools = document.getElementById('drawer-tools');
    const drawerModes = document.getElementById('drawer-modes');
    const drawerSession = document.getElementById('drawer-session');
    const drawerSettings = document.getElementById('drawer-settings');
    const contextChipsEl = document.getElementById('context-chips');
    const slashPopup = document.getElementById('slash-popup');
    const stopBtn = document.getElementById('stop-btn');
    const inputCounter = document.getElementById('input-counter');
    const historySearchInput = document.getElementById('history-search-input');
    const scrollFab = document.getElementById('scroll-fab');
    const atPopup = document.getElementById('at-popup');
    const turnsBadge = document.getElementById('turns-badge');
    const shortcutsBtn = document.getElementById('shortcuts-btn');
    const shortcutsOverlay = document.getElementById('shortcuts-overlay');
    const searchBar = document.getElementById('search-bar');
    const searchInput = document.getElementById('search-input');
    const searchCount = document.getElementById('search-count');
    const searchPrev = document.getElementById('search-prev');
    const searchNext = document.getElementById('search-next');
    const searchCloseBtn = document.getElementById('search-close');
    const toastContainer = document.getElementById('toast-container');
    const agentDialogOverlay = document.getElementById('agent-dialog-overlay');
    const dropZone = document.getElementById('drop-zone');
    let currentAssistantEl = null;
    let assistantText = '';
    let currentToolEl = null;
    let activeMode = 'code';
    let turnCount = 0;
    let searchMatches = [];
    let searchIdx = -1;
    let lastUsage = { used: 0, max: 1, messageCount: 0 };
    let contextAttachments = [];
    let settings = { timestamps: true, thinking: true, streaming: true, autoscroll: true, sounds: false, saveHistory: true, wsContext: true, gitContext: false };
    let slashCommands = [
      { cmd: '/explain', desc: 'Explain selected code or concept' },
      { cmd: '/refactor', desc: 'Refactor code for readability' },
      { cmd: '/fix', desc: 'Fix issues in the current code' },
      { cmd: '/test', desc: 'Generate unit tests' },
      { cmd: '/plan', desc: 'Create an implementation plan' },
      { cmd: '/scan', desc: 'Scan project for issues' },
      { cmd: '/clear', desc: 'Clear conversation' },
    ];
    let slashSelectedIdx = 0;
    let allConversations = [];
    let workspaceScope = [];
    let workspaceScopeSelected = [];

    // ── Context Chips ──
    function addChip(file) {
      if (contextAttachments.includes(file)) return;
      contextAttachments.push(file);
      renderChips();
    }
    function removeChip(file) {
      contextAttachments = contextAttachments.filter(function(f) { return f !== file; });
      renderChips();
    }
    function renderChips() {
      contextChipsEl.innerHTML = contextAttachments.map(function(f) {
        var short = f.length > 28 ? '\\u2026' + f.slice(-26) : f;
        return '<span class="chip" title="' + escapeHtml(f) + '">' +
          '<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>' +
          '<span>' + escapeHtml(short) + '</span>' +
          '<button class="chip-remove" data-file="' + escapeHtml(f) + '">&times;</button>' +
          '</span>';
      }).join('');
      contextChipsEl.querySelectorAll('.chip-remove').forEach(function(btn) {
        btn.addEventListener('click', function() { removeChip(btn.dataset.file); });
      });
    }

    // ── Input Counter ──
    function updateInputCounter() {
      var len = input.value.length;
      var tokens = Math.ceil(len / 4);
      if (len === 0) {
        inputCounter.textContent = '';
        inputCounter.classList.remove('warn');
      } else {
        inputCounter.textContent = tokens + ' tok';
        inputCounter.classList.toggle('warn', tokens > 4000);
      }
    }

    // ── Slash Commands ──
    function handleSlashTrigger() {
      var val = input.value;
      if (!val.startsWith('/')) { slashPopup.style.display = 'none'; return; }
      var query = val.split(' ')[0].toLowerCase();
      var matches = slashCommands.filter(function(c) { return c.cmd.startsWith(query); });
      if (matches.length === 0 || val.includes(' ')) { slashPopup.style.display = 'none'; return; }
      slashSelectedIdx = 0;
      slashPopup.innerHTML = matches.map(function(c, i) {
        return '<div class="slash-item' + (i === 0 ? ' selected' : '') + '" data-idx="' + i + '">' +
          '<span class="slash-cmd">' + escapeHtml(c.cmd) + '</span>' +
          '<span class="slash-desc">' + escapeHtml(c.desc) + '</span></div>';
      }).join('');
      slashPopup.style.display = 'block';
      slashPopup.querySelectorAll('.slash-item').forEach(function(el) {
        el.addEventListener('click', function() { pickSlash(parseInt(el.dataset.idx), matches); });
      });
    }
    function pickSlash(idx, matches) {
      var cmd = (matches || slashCommands)[idx];
      if (!cmd) return;
      if (cmd.cmd === '/clear') {
        vscode.postMessage({ type: 'newConversation' });
        input.value = '';
      } else {
        input.value = cmd.cmd + ' ';
        input.focus();
      }
      slashPopup.style.display = 'none';
    }

    // ── Stop generation ──
    stopBtn.addEventListener('click', function() {
      // Attempt graceful stop by sending a signal
      vscode.postMessage({ type: 'stopGeneration' });
      setStatus('idle', '');
      stopBtn.classList.remove('visible');
      sendBtn.disabled = false;
    });

    // ── @ Participant mentions ──
    var atParticipants = [
      { name: '@workspace', desc: 'Search across all workspace files' },
      { name: '@terminal', desc: 'Include recent terminal output' },
      { name: '@selection', desc: 'Include editor selection' },
      { name: '@file', desc: 'Reference a specific file' },
      { name: '@problems', desc: 'Include diagnostics/problems' },
      { name: '@git', desc: 'Include git status/diff' },
    ];
    var atSelectedIdx = 0;
    var atStartIdx = -1;

    function handleAtTrigger() {
      var val = input.value;
      var cursor = input.selectionStart;
      var before = val.substring(0, cursor);
      var atIdx = before.lastIndexOf('@');
      if (atIdx === -1 || (atIdx > 0 && before[atIdx - 1] !== ' ' && before[atIdx - 1] !== '\\n')) {
        atPopup.style.display = 'none'; return;
      }
      var query = before.substring(atIdx).toLowerCase();
      if (query.includes(' ') && query.length > 20) { atPopup.style.display = 'none'; return; }
      atStartIdx = atIdx;
      var matches = atParticipants.filter(function(p) { return p.name.startsWith(query); });
      if (!matches.length) { atPopup.style.display = 'none'; return; }
      atSelectedIdx = 0;
      atPopup.innerHTML = matches.map(function(p, i) {
        return '<div class="at-item' + (i === 0 ? ' selected' : '') + '" data-idx="' + i + '">' +
          '<span class="at-name">' + escapeHtml(p.name) + '</span>' +
          '<span class="at-desc">' + escapeHtml(p.desc) + '</span></div>';
      }).join('');
      atPopup.style.display = 'block';
      atPopup.querySelectorAll('.at-item').forEach(function(el) {
        el.addEventListener('click', function() { pickAt(parseInt(el.dataset.idx), matches); });
      });
    }

    function pickAt(idx, matches) {
      var participant = (matches || atParticipants)[idx];
      if (!participant) return;
      var before = input.value.substring(0, atStartIdx);
      var after = input.value.substring(input.selectionStart);
      input.value = before + participant.name + ' ' + after;
      input.selectionStart = input.selectionEnd = before.length + participant.name.length + 1;
      atPopup.style.display = 'none';
      input.focus();
    }

    // ── Scroll-to-bottom FAB ──
    messagesEl.addEventListener('scroll', function() {
      var distFromBottom = messagesEl.scrollHeight - messagesEl.scrollTop - messagesEl.clientHeight;
      scrollFab.classList.toggle('visible', distFromBottom > 100);
    });
    scrollFab.addEventListener('click', function() {
      messagesEl.scrollTop = messagesEl.scrollHeight;
    });

    // ── Format timestamp ──
    function formatTime(date) {
      var h = date.getHours();
      var m = date.getMinutes();
      return (h < 10 ? '0' : '') + h + ':' + (m < 10 ? '0' : '') + m;
    }

    function setUsage(used, max, messageCount) {
      lastUsage = { used: used || 0, max: max || 1, messageCount: messageCount || 0 };
      var pct = Math.max(0, Math.min(100, Math.round((lastUsage.used / Math.max(lastUsage.max, 1)) * 100)));
      // Update circular gauge
      var circumference = 94.2; // 2 * PI * 15
      var offset = circumference - (circumference * pct / 100);
      if (contextRingFill) contextRingFill.setAttribute('stroke-dashoffset', String(offset));
      if (contextRingLabel) contextRingLabel.textContent = pct + '%';
      var ring = document.getElementById('context-ring');
      if (ring) ring.title = 'Estimated tokens: ' + lastUsage.used + ' / ' + lastUsage.max + ' | Messages: ' + lastUsage.messageCount;
    }

    function openDrawer(tab) {
      rightDrawer.classList.remove('hidden');
      switchDrawerTab(tab || 'tools');
    }

    function closeDrawer() {
      rightDrawer.classList.add('hidden');
    }

    function switchDrawerTab(tab) {
      document.querySelectorAll('.drawer-tab').forEach(function(t) {
        t.classList.toggle('active', t.dataset.drawerTab === tab);
      });
      drawerTools.classList.toggle('hidden', tab !== 'tools');
      drawerModes.classList.toggle('hidden', tab !== 'modes');
      drawerSession.classList.toggle('hidden', tab !== 'session');
      drawerSettings.classList.toggle('hidden', tab !== 'settings');
      var titles = { tools: 'Tools', modes: 'Agents', session: 'Session', settings: 'Settings' };
      drawerTitle.textContent = titles[tab] || 'Tools';
    }

    // ── Helpers ──
    function hideWelcome() {
      if (welcomeEl) welcomeEl.style.display = 'none';
    }

    function setStatus(state, text) {
      statusEl.className = state;
      statusEl.textContent = text || '';
    }

    function escapeHtml(text) {
      const el = document.createElement('span');
      el.textContent = text;
      return el.innerHTML;
    }

    // ── Welcome actions ──
    document.querySelectorAll('.welcome-action').forEach(function(btn) {
      btn.addEventListener('click', function() {
        const prompt = btn.dataset.prompt;
        if (prompt) { input.value = prompt; send(); }
      });
    });

    // ── History ──
    historyBtn.addEventListener('click', function() {
      const isHidden = historyPanel.classList.contains('hidden');
      if (isHidden) {
        historyPanel.classList.remove('hidden');
        vscode.postMessage({ type: 'getHistory' });
      } else {
        historyPanel.classList.add('hidden');
      }
    });
    historyClose.addEventListener('click', function() {
      historyPanel.classList.add('hidden');
    });
    if (toolsBtn) toolsBtn.addEventListener('click', function() {
      openDrawer('tools');
      vscode.postMessage({ type: 'getTools' });
    });
    if (modePill) modePill.addEventListener('click', function() {
      openDrawer('modes');
      vscode.postMessage({ type: 'getModes' });
    });
    if (sessionBtn) sessionBtn.addEventListener('click', function() {
      openDrawer('session');
      vscode.postMessage({ type: 'getTokenUsage' });
      vscode.postMessage({ type: 'getHistory' });
    });
    drawerClose.addEventListener('click', closeDrawer);
    document.querySelectorAll('.drawer-tab').forEach(function(tab) {
      tab.addEventListener('click', function() {
        switchDrawerTab(tab.dataset.drawerTab || 'tools');
      });
    });

    function renderHistory(conversations) {
      allConversations = conversations || [];
      filterAndRenderHistory('');
    }

    function filterAndRenderHistory(query) {
      var filtered = allConversations;
      if (query) {
        var q = query.toLowerCase();
        filtered = allConversations.filter(function(c) {
          return c.title.toLowerCase().includes(q);
        });
      }
      if (!filtered.length) {
        historyList.innerHTML = '<div class="history-empty">' + (query ? 'No matches' : 'No conversations yet') + '</div>';
        return;
      }
      // Group by date
      var now = Date.now();
      var today = new Date(); today.setHours(0,0,0,0);
      var yesterday = new Date(today); yesterday.setDate(yesterday.getDate() - 1);
      var weekAgo = new Date(today); weekAgo.setDate(weekAgo.getDate() - 7);
      var groups = { today: [], yesterday: [], week: [], older: [] };
      filtered.forEach(function(c) {
        var d = c.updatedAt;
        if (d >= today.getTime()) groups.today.push(c);
        else if (d >= yesterday.getTime()) groups.yesterday.push(c);
        else if (d >= weekAgo.getTime()) groups.week.push(c);
        else groups.older.push(c);
      });
      var html = '';
      if (groups.today.length) {
        html += '<div class="history-group-label">Today</div>';
        html += renderHistoryItems(groups.today);
      }
      if (groups.yesterday.length) {
        html += '<div class="history-group-label">Yesterday</div>';
        html += renderHistoryItems(groups.yesterday);
      }
      if (groups.week.length) {
        html += '<div class="history-group-label">This Week</div>';
        html += renderHistoryItems(groups.week);
      }
      if (groups.older.length) {
        html += '<div class="history-group-label">Older</div>';
        html += renderHistoryItems(groups.older);
      }
      historyList.innerHTML = html;
      historyList.querySelectorAll('.history-item').forEach(function(el) {
        el.addEventListener('click', function(e) {
          if (e.target.closest('.history-delete') || e.target.closest('.history-rename-input')) return;
          vscode.postMessage({ type: 'switchConversation', id: el.dataset.id });
          historyPanel.classList.add('hidden');
        });
        // Inline rename on double-click
        var titleEl = el.querySelector('.history-title');
        if (titleEl) {
          titleEl.addEventListener('dblclick', function(e) {
            e.stopPropagation();
            var oldTitle = titleEl.textContent;
            var inp = document.createElement('input');
            inp.type = 'text';
            inp.className = 'history-rename-input';
            inp.value = oldTitle;
            titleEl.replaceWith(inp);
            inp.focus();
            inp.select();
            function commitRename() {
              var newTitle = inp.value.trim() || oldTitle;
              var span = document.createElement('span');
              span.className = 'history-title';
              span.textContent = newTitle;
              inp.replaceWith(span);
              if (newTitle !== oldTitle) {
                vscode.postMessage({ type: 'renameConversation', id: el.dataset.id, title: newTitle });
              }
              // Re-attach dblclick on new span
              span.addEventListener('dblclick', arguments.callee);
            }
            inp.addEventListener('blur', commitRename);
            inp.addEventListener('keydown', function(ke) {
              if (ke.key === 'Enter') { ke.preventDefault(); inp.blur(); }
              if (ke.key === 'Escape') { inp.value = oldTitle; inp.blur(); }
            });
          });
        }
      });
      historyList.querySelectorAll('.history-delete').forEach(function(btn) {
        btn.addEventListener('click', function(e) {
          e.stopPropagation();
          vscode.postMessage({ type: 'deleteConversation', id: btn.dataset.id });
        });
      });
    }

    function renderHistoryItems(items) {
      return items.map(function(c) {
        var date = new Date(c.updatedAt);
        var ago = formatTimeAgo(date);
        return '<div class="history-item' + (c.active ? ' active' : '') + '" data-id="' + escapeHtml(c.id) + '">' +
          '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>' +
          '<span class="history-title">' + escapeHtml(c.title) + '</span>' +
          '<span class="history-meta">' + ago + '</span>' +
          '<button class="history-delete" data-id="' + escapeHtml(c.id) + '" title="Delete">&times;</button>' +
          '</div>';
      }).join('');
    }

    historySearchInput.addEventListener('input', function() {
      filterAndRenderHistory(historySearchInput.value.trim());
    });

    function formatTimeAgo(date) {
      const now = Date.now();
      const diff = now - date.getTime();
      const mins = Math.floor(diff / 60000);
      if (mins < 1) return 'now';
      if (mins < 60) return mins + 'm';
      const hours = Math.floor(mins / 60);
      if (hours < 24) return hours + 'h';
      const days = Math.floor(hours / 24);
      if (days < 7) return days + 'd';
      return date.toLocaleDateString();
    }

    function renderTools(tools) {
      if (!tools || tools.length === 0) {
        drawerTools.innerHTML = '<div class="muted">No tools available.</div>';
        return;
      }
      // Model info card at top
      var modelName = modelSelect.value || 'Unknown';
      var modelHtml = '<div class="model-info-card">' +
        '<div class="model-info-header">' +
        '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="3"/><path d="M12 1v2M12 21v2M4.22 4.22l1.42 1.42M18.36 18.36l1.42 1.42M1 12h2M21 12h2M4.22 19.78l1.42-1.42M18.36 5.64l1.42-1.42"/></svg>' +
        '<span class="model-info-name">' + escapeHtml(modelName) + '</span></div>' +
        '<div class="model-info-stats">' +
        '<div class="model-stat"><span class="model-stat-label">Context</span><span class="model-stat-value">128K</span></div>' +
        '<div class="model-stat"><span class="model-stat-label">Tools</span><span class="model-stat-value">' + tools.length + '</span></div>' +
        '<div class="model-stat"><span class="model-stat-label">Mode</span><span class="model-stat-value">' + escapeHtml(activeMode) + '</span></div>' +
        '<div class="model-stat"><span class="model-stat-label">Status</span><span class="model-stat-value" style="color:var(--vscode-terminal-ansiGreen)">Ready</span></div>' +
        '</div></div>';
      // Group tools by category
      var groups = {};
      tools.forEach(function(t) {
        if (!groups[t.group]) groups[t.group] = [];
        groups[t.group].push(t);
      });
      var toolsHtml = Object.keys(groups).sort().map(function(g) {
        return '<div class="settings-group-title" style="margin-top:8px;">' + escapeHtml(g.toUpperCase()) + ' (' + groups[g].length + ')</div>' +
          groups[g].map(function(t) {
            return '<div class="list-item">' +
              '<div class="list-title"><span>' + escapeHtml(t.name) + '</span>' +
              '<span class="badge ' + (t.enabled ? 'ok' : '') + '">' + (t.enabled ? 'on' : 'off') + '</span></div>' +
              '<div class="muted">' + escapeHtml(t.description || '') + '</div>' +
              '</div>';
          }).join('');
      }).join('');
      drawerTools.innerHTML = modelHtml + toolsHtml;
    }

    function renderModes(modes) {
      if (!modes || modes.length === 0) {
        drawerModes.innerHTML = '<div class="muted">No modes configured.</div>';
        return;
      }

      // Update the agent dropdown list with all available modes
      var lucideIcons = {
        code: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="4 17 10 11 4 5"/><line x1="12" y1="19" x2="20" y2="19"/></svg>',
        ask: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>',
        plan: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg>',
        advanced: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"/></svg>',
        orchestrator: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M12 2v4m0 12v4m10-10h-4M6 12H2m15.07-5.07l-2.83 2.83M9.76 14.24l-2.83 2.83m9.9 0l-2.83-2.83M9.76 9.76L6.93 6.93"/></svg>'
      };
      var defaultIcon = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="12 2 2 7 12 12 22 7 12 2"/><polyline points="2 17 12 22 22 17"/><polyline points="2 12 12 17 22 12"/></svg>';
      agentModes = modes.map(function(m) {
        var cleanName = m.name.replace(/^[\u{1F000}-\u{1FFFF}\u{2600}-\u{27BF}\u{FE00}-\u{FEFF}\u{200D}\u{20E3}\u{E0020}-\u{E007F}]+/u, '').trimStart();
        return { slug: m.slug, name: cleanName, icon: lucideIcons[m.slug] || defaultIcon };
      });
      // Sync dropdown to current activeMode (already set by modeChanged)
      var activeMatch = agentModes.find(function(m) { return m.slug === activeMode; });
      if (activeMatch) {
        agentDropdownLabel.textContent = activeMatch.name;
        updateDropdownIcon();
      }

      var html = modes.map(function(m) {
        return '<div class="list-item clickable" data-slug="' + escapeHtml(m.slug) + '">' +
          '<div class="list-title"><span>' + escapeHtml(m.name) + '</span>' +
          '<span class="badge ' + (m.active ? 'ok' : '') + '">' + (m.active ? 'active' : 'click to switch') + '</span></div>' +
          '<div class="muted">' + escapeHtml(m.whenToUse || '') + '</div>' +
          '<div class="muted">groups: ' + escapeHtml((m.groups || []).join(', ')) + '</div>' +
          '</div>';
      }).join('');
      html += '<div style="margin-top:10px;text-align:center;"><button class="agent-dialog-btn primary" id="open-agent-dialog" style="width:100%;">+ Create Custom Agent</button></div>';
      drawerModes.innerHTML = html;
      drawerModes.querySelectorAll('.list-item.clickable').forEach(function(el) {
        el.addEventListener('click', function() {
          var slug = el.dataset.slug;
          activeMode = slug;
          if (activeModeLabel) activeModeLabel.textContent = slug;
          agentDropdownLabel.textContent = agentModes.find(function(m) { return m.slug === slug; })?.name || slug;
          vscode.postMessage({ type: 'switchMode', mode: slug });
          vscode.postMessage({ type: 'getModes' });
          vscode.postMessage({ type: 'getTools' });
        });
      });
      var openDialogBtn = document.getElementById('open-agent-dialog');
      if (openDialogBtn) {
        openDialogBtn.addEventListener('click', function() {
          agentDialogOverlay.classList.add('visible');
        });
      }
    }

    function renderSessionCard() {
      var usagePct = Math.max(0, Math.min(100, Math.round((lastUsage.used / Math.max(lastUsage.max, 1)) * 100)));
      var selectedCount = workspaceScopeSelected.length > 0 ? workspaceScopeSelected.length : workspaceScope.length;
      var scopeHtml = workspaceScope.length
        ? '<div class="list-item">' +
            '<div class="list-title"><span>Workspace Scope</span><span class="badge">' + selectedCount + '/' + workspaceScope.length + '</span></div>' +
            workspaceScope.map(function(f) {
              var active = workspaceScopeSelected.length === 0 || workspaceScopeSelected.includes(f.name);
              return '<div class="muted" title="' + escapeHtml(f.path) + '">' + (active ? '\u2022 ' : '\u25CB ') + escapeHtml(f.name) + '</div>';
            }).join('') +
          '</div>'
        : '<div class="list-item"><div class="list-title"><span>Workspace Scope</span></div><div class="muted">No workspace folders detected.</div></div>';
      drawerSession.innerHTML =
        '<div class="list-item">' +
          '<div class="list-title"><span>Context Window</span><span class="badge">' + usagePct + '%</span></div>' +
          '<div class="muted">Estimated tokens: ' + lastUsage.used + ' / ' + lastUsage.max + '</div>' +
          '<div class="muted">Messages: ' + lastUsage.messageCount + '</div>' +
        '</div>' +
        scopeHtml +
        '<div class="list-item">' +
          '<div class="list-title"><span>Actions</span></div>' +
          '<button class="utility-btn" id="export-session-btn">Export Active Chat</button>' +
        '</div>';
      var exportBtn = document.getElementById('export-session-btn');
      if (exportBtn) {
        exportBtn.addEventListener('click', function() {
          vscode.postMessage({ type: 'exportConversation' });
        });
      }
    }

    function renderWorkspaceScopePill() {
      var pill = document.getElementById('workspace-scope');
      if (!pill) return;
      if (!workspaceScope.length) {
        pill.textContent = 'scope: none';
        pill.title = 'No workspace folders detected';
        return;
      }
      var selected = workspaceScopeSelected.length > 0
        ? workspaceScope.filter(function(f) { return workspaceScopeSelected.includes(f.name); })
        : workspaceScope;
      var names = selected.map(function(f) { return f.name; });
      pill.textContent = 'scope: ' + names.join(', ');
      pill.title = workspaceScope.map(function(f) {
        var active = workspaceScopeSelected.length === 0 || workspaceScopeSelected.includes(f.name);
        return (active ? '[x] ' : '[ ] ') + f.name + ' — ' + f.path;
      }).join('\n');
    }

    function renderWorkspaceScopeMenu() {
      if (!workspaceScopeMenu) return;
      if (!workspaceScope.length) {
        workspaceScopeMenu.innerHTML = '<div class="scope-menu-title">Workspace Scope</div><div class="muted">No folders available.</div>';
        return;
      }

      var rows = workspaceScope.map(function(f, idx) {
        var checked = workspaceScopeSelected.length === 0 || workspaceScopeSelected.includes(f.name);
        return '<label class="scope-menu-item" title="' + escapeHtml(f.path) + '">' +
          '<input type="checkbox" class="scope-menu-cb" data-idx="' + idx + '" ' + (checked ? 'checked' : '') + ' />' +
          '<span>' + escapeHtml(f.name) + '</span>' +
          '</label>';
      }).join('');

      workspaceScopeMenu.innerHTML =
        '<div class="scope-menu-title">Select folders for chat context</div>' +
        rows +
        '<div class="scope-menu-actions">' +
          '<button class="scope-menu-btn" id="scope-all-btn">All</button>' +
          '<button class="scope-menu-btn" id="scope-apply-btn">Apply</button>' +
        '</div>';

      var allBtn = document.getElementById('scope-all-btn');
      if (allBtn) {
        allBtn.addEventListener('click', function() {
          workspaceScopeSelected = [];
          vscode.postMessage({ type: 'updateWorkspaceScopeFilter', folders: [] });
          workspaceScopeMenu.classList.add('hidden');
        });
      }

      var applyBtn = document.getElementById('scope-apply-btn');
      if (applyBtn) {
        applyBtn.addEventListener('click', function() {
          var selectedNames = [];
          workspaceScopeMenu.querySelectorAll('.scope-menu-cb').forEach(function(cb) {
            if (cb.checked) {
              var idx = Number(cb.dataset.idx || -1);
              if (idx >= 0 && workspaceScope[idx]) selectedNames.push(workspaceScope[idx].name);
            }
          });
          workspaceScopeSelected = selectedNames.length === workspaceScope.length ? [] : selectedNames;
          vscode.postMessage({ type: 'updateWorkspaceScopeFilter', folders: workspaceScopeSelected });
          workspaceScopeMenu.classList.add('hidden');
        });
      }
    }

    if (workspaceScopePill) {
      workspaceScopePill.addEventListener('click', function(e) {
        e.preventDefault();
        e.stopPropagation();
        renderWorkspaceScopeMenu();
        workspaceScopeMenu.classList.toggle('hidden');
      });
    }

    document.addEventListener('click', function(e) {
      if (!workspaceScopeMenu || !workspaceScopePill) return;
      if (workspaceScopeMenu.classList.contains('hidden')) return;
      if (!workspaceScopeMenu.contains(e.target) && !workspaceScopePill.contains(e.target)) {
        workspaceScopeMenu.classList.add('hidden');
      }
    });

    // ── Agent/Mode dropdown (Copilot-style) ──
    var agentDropdown = document.getElementById('agent-dropdown');
    var agentDropdownLabel = document.getElementById('agent-dropdown-label');
    var agentDropdownIcon = document.getElementById('agent-dropdown-icon');
    var agentPopup = document.getElementById('agent-popup');
    var agentModes = [
      { slug: 'code', name: 'Agent', icon: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="4 17 10 11 4 5"/><line x1="12" y1="19" x2="20" y2="19"/></svg>' },
      { slug: 'ask', name: 'Ask', icon: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>' },
      { slug: 'plan', name: 'Plan', icon: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg>' },
    ];

    function updateDropdownIcon() {
      var match = agentModes.find(function(m) { return m.slug === activeMode; });
      if (match && agentDropdownIcon) agentDropdownIcon.innerHTML = match.icon;
    }
    updateDropdownIcon();

    function renderAgentPopup() {
      var html = agentModes.map(function(m) {
        return '<div class="agent-popup-item' + (m.slug === activeMode ? ' active' : '') + '" data-mode="' + m.slug + '">' +
          '<span class="agent-popup-icon">' + m.icon + '</span><span>' + m.name + '</span></div>';
      }).join('');
      html += '<div class="agent-popup-divider"></div>';
      html += '<div class="agent-popup-item create" id="create-agent-popup-btn"><span>+ Create Agent...</span></div>';
      agentPopup.innerHTML = html;
      agentPopup.querySelectorAll('.agent-popup-item[data-mode]').forEach(function(item) {
        item.addEventListener('mousedown', function(e) {
          e.preventDefault();
          e.stopPropagation();
          activeMode = item.dataset.mode;
          var match = agentModes.find(function(m) { return m.slug === activeMode; });
          agentDropdownLabel.textContent = match ? match.name : activeMode;
          updateDropdownIcon();
          if (activeModeLabel) activeModeLabel.textContent = activeMode;
          agentPopup.classList.remove('visible');
          // Update the toggle label to reflect current state
          if (modeToggleBtn) modeToggleBtn.textContent = (activeMode === 'ask') ? 'Chat' : 'Agent';
          vscode.postMessage({ type: 'switchMode', mode: activeMode });
          vscode.postMessage({ type: 'getTools' });
        });
      });
      var createBtn = document.getElementById('create-agent-popup-btn');
      if (createBtn) createBtn.addEventListener('mousedown', function(e) {
        e.preventDefault();
        e.stopPropagation();
        agentPopup.classList.remove('visible');
        document.getElementById('agent-dialog-overlay').classList.add('visible');
      });
    }

    agentDropdown.addEventListener('click', function(e) {
      e.preventDefault();
      e.stopPropagation();
      renderAgentPopup();
      var isVisible = agentPopup.classList.contains('visible');
      agentPopup.classList.toggle('visible', !isVisible);
    });
    document.addEventListener('click', function(e) {
      if (!agentPopup.contains(e.target) && !agentDropdown.contains(e.target)) {
        agentPopup.classList.remove('visible');
      }
    });

    // ── New chat (+ button in bottom bar) ──
    var newChatBottomBtn = document.getElementById('new-chat-bottom-btn');
    newChatBottomBtn.addEventListener('click', function() {
      vscode.postMessage({ type: 'newConversation' });
    });

    // ── Chat/Agent toggle (single button) ──
    var modeToggleBtn = document.getElementById('mode-toggle-btn');
    var isAgentMode = true;
    function setModeToggle(isAgent) {
      isAgentMode = isAgent;
      modeToggleBtn.textContent = isAgent ? 'Agent' : 'Chat';
      // Show/hide agent dropdown when in agent mode
      document.querySelector('.agent-dropdown-wrap').style.display = isAgent ? 'inline-flex' : 'none';
      document.getElementById('tools-config-btn').style.display = isAgent ? '' : 'none';
    }
    modeToggleBtn.addEventListener('click', function() {
      if (isAgentMode) {
        setModeToggle(false);
        activeMode = 'ask';
        agentDropdownLabel.textContent = 'Ask';
        if (activeModeLabel) activeModeLabel.textContent = 'ask';
        vscode.postMessage({ type: 'switchMode', mode: 'ask' });
      } else {
        setModeToggle(true);
        activeMode = 'code';
        agentDropdownLabel.textContent = agentModes.find(function(m) { return m.slug === activeMode; })?.name || 'Agent';
        if (activeModeLabel) activeModeLabel.textContent = activeMode;
        vscode.postMessage({ type: 'switchMode', mode: activeMode });
        vscode.postMessage({ type: 'getTools' });
      }
    });

    // ── Tools config button ──
    var toolsConfigBtn = document.getElementById('tools-config-btn');
    toolsConfigBtn.addEventListener('click', function() {
      // Open the right drawer to Tools tab
      rightDrawer.classList.remove('hidden');
      document.querySelectorAll('.drawer-tab').forEach(function(t) { t.classList.remove('active'); });
      var toolsTab = document.querySelector('.drawer-tab[data-drawer-tab="tools"]');
      if (toolsTab) toolsTab.classList.add('active');
      drawerTools.classList.remove('hidden');
      drawerModes.classList.add('hidden');
      drawerSession.classList.add('hidden');
      drawerSettings.classList.add('hidden');
      drawerTitle.textContent = 'Tools';
      vscode.postMessage({ type: 'getTools' });
    });

    // ── New chat (header button, keep working too) ──
    newChatBtn.addEventListener('click', function() {
      vscode.postMessage({ type: 'newConversation' });
    });

    // ── Model switch ──
    modelSelect.addEventListener('change', function() {
      const model = modelSelect.value;
      if (model) vscode.postMessage({ type: 'switchModel', model: model });
    });

    // ── Auto-approve toggles ──
    document.querySelectorAll('.approve-toggle input').forEach(function(cb) {
      cb.addEventListener('change', function() {
        var group = cb.dataset.group;
        var toggle = cb.closest('.approve-toggle');
        toggle.classList.toggle('active', cb.checked);
        vscode.postMessage({ type: 'autoApproveToggle', group: group, enabled: cb.checked });
      });
    });

    // ── Enhance prompt ──
    enhanceBtn.addEventListener('click', function() {
      var text = input.value.trim();
      if (!text) return;
      enhanceBtn.classList.add('enhancing');
      vscode.postMessage({ type: 'enhancePrompt', text: text });
    });

    // ── Attach (focus input with # hint) ──
    if (attachBtn) attachBtn.addEventListener('click', function() {
      input.value += '#';
      input.focus();
      handleContextTrigger();
    });

    // ── Send ──
    sendBtn.addEventListener('click', send);
    input.addEventListener('keydown', function(e) {
      // @ popup navigation
      if (atPopup.style.display !== 'none') {
        var atItems = atPopup.querySelectorAll('.at-item');
        if (e.key === 'ArrowDown') { e.preventDefault(); atSelectedIdx = Math.min(atSelectedIdx + 1, atItems.length - 1); atItems.forEach(function(el, i) { el.classList.toggle('selected', i === atSelectedIdx); }); return; }
        if (e.key === 'ArrowUp') { e.preventDefault(); atSelectedIdx = Math.max(atSelectedIdx - 1, 0); atItems.forEach(function(el, i) { el.classList.toggle('selected', i === atSelectedIdx); }); return; }
        if (e.key === 'Tab' || (e.key === 'Enter' && atItems.length > 0)) {
          e.preventDefault();
          var before = input.value.substring(0, input.selectionStart);
          var query = before.substring(atStartIdx).toLowerCase();
          var matches = atParticipants.filter(function(p) { return p.name.startsWith(query); });
          pickAt(atSelectedIdx, matches);
          return;
        }
        if (e.key === 'Escape') { atPopup.style.display = 'none'; e.preventDefault(); return; }
      }
      // Slash popup navigation
      if (slashPopup.style.display !== 'none') {
        var slashItems = slashPopup.querySelectorAll('.slash-item');
        if (e.key === 'ArrowDown') { e.preventDefault(); slashSelectedIdx = Math.min(slashSelectedIdx + 1, slashItems.length - 1); updateSlashSelection(); return; }
        if (e.key === 'ArrowUp') { e.preventDefault(); slashSelectedIdx = Math.max(slashSelectedIdx - 1, 0); updateSlashSelection(); return; }
        if (e.key === 'Tab' || (e.key === 'Enter' && slashItems.length > 0)) {
          e.preventDefault();
          var matches = slashCommands.filter(function(c) { return c.cmd.startsWith(input.value.split(' ')[0].toLowerCase()); });
          pickSlash(slashSelectedIdx, matches);
          return;
        }
        if (e.key === 'Escape') { slashPopup.style.display = 'none'; e.preventDefault(); return; }
      }
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
      if (e.key === 'Escape' && contextPopup.style.display !== 'none') {
        contextPopup.style.display = 'none';
        e.preventDefault();
      }
      if (e.key === 'Escape' && atPopup.style.display !== 'none') {
        atPopup.style.display = 'none';
        e.preventDefault();
      }
    });
    input.addEventListener('input', function() {
      input.style.height = 'auto';
      input.style.height = Math.min(input.scrollHeight, 140) + 'px';
      handleContextTrigger();
      handleSlashTrigger();
      handleAtTrigger();
      updateInputCounter();
    });

    function send() {
      var text = input.value.trim();
      if (!text) return;
      hideWelcome();
      // Prepend context chips as # references if not already in text
      var extraContext = '';
      contextAttachments.forEach(function(f) {
        if (text.indexOf('#' + f) === -1) { extraContext += '#' + f + ' '; }
      });
      var fullText = extraContext ? extraContext + text : text;
      addMessage('user', fullText);
      vscode.postMessage({ type: 'chat', text: fullText });
      input.value = '';
      input.style.height = 'auto';
      sendBtn.disabled = true;
      stopBtn.classList.add('visible');
      contextAttachments = [];
      renderChips();
      updateInputCounter();
      updateTurns();
    }

    // ── # context picker ──
    var contextPopup = document.getElementById('context-popup');
    var contextListEl = document.getElementById('context-list');
    var contextFiles = [];
    var contextQuery = '';
    var contextStartIdx = -1;
    var contextSelectedIdx = 0;

    function handleContextTrigger() {
      var val = input.value;
      var cursor = input.selectionStart;
      var before = val.substring(0, cursor);
      var hashIdx = before.lastIndexOf('#');
      if (hashIdx === -1 || (hashIdx > 0 && before[hashIdx - 1] !== ' ' && before[hashIdx - 1] !== '\\n')) {
        contextPopup.style.display = 'none';
        return;
      }
      var query = before.substring(hashIdx + 1);
      if (query.includes(' ') && query.length > 30) { contextPopup.style.display = 'none'; return; }
      contextStartIdx = hashIdx;
      contextQuery = query.toLowerCase();
      vscode.postMessage({ type: 'contextSearch', query: contextQuery });
    }

    function showContextPopup(files) {
      contextFiles = files;
      contextSelectedIdx = 0;
      if (!files.length) { contextPopup.style.display = 'none'; return; }
      contextListEl.innerHTML = files.slice(0, 12).map(function(f, i) {
        return '<div class="ctx-item' + (i === 0 ? ' selected' : '') + '" data-idx="' + i + '">' +
          '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>' +
          escapeHtml(f) + '</div>';
      }).join('');
      contextPopup.style.display = 'block';
      contextListEl.querySelectorAll('.ctx-item').forEach(function(el) {
        el.addEventListener('click', function() { pickContext(parseInt(el.dataset.idx)); });
      });
    }

    function pickContext(idx) {
      var file = contextFiles[idx];
      if (!file) return;
      var before = input.value.substring(0, contextStartIdx);
      var after = input.value.substring(input.selectionStart);
      input.value = before + '#' + file + ' ' + after;
      input.selectionStart = input.selectionEnd = before.length + 1 + file.length + 1;
      contextPopup.style.display = 'none';
      addChip(file);
      input.focus();
    }

    function updateSlashSelection() {
      slashPopup.querySelectorAll('.slash-item').forEach(function(el, i) {
        el.classList.toggle('selected', i === slashSelectedIdx);
      });
    }

    input.addEventListener('keydown', function(e) {
      if (contextPopup.style.display === 'none') return;
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        contextSelectedIdx = Math.min(contextSelectedIdx + 1, contextFiles.length - 1);
        updateContextSelection();
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        contextSelectedIdx = Math.max(contextSelectedIdx - 1, 0);
        updateContextSelection();
      } else if (e.key === 'Enter' || e.key === 'Tab') {
        if (contextFiles.length > 0) { e.preventDefault(); pickContext(contextSelectedIdx); }
      }
    });

    function updateContextSelection() {
      contextListEl.querySelectorAll('.ctx-item').forEach(function(el, i) {
        el.classList.toggle('selected', i === contextSelectedIdx);
      });
    }

    // ── Message rendering ──
    function addMessage(role, content) {
      hideWelcome();
      var msg = document.createElement('div');
      msg.className = 'msg msg-' + role;

      var header = document.createElement('div');
      header.className = 'msg-header';

      var icon = document.createElement('div');
      icon.className = 'msg-icon';
      icon.textContent = role === 'user' ? 'U' : 'O';

      var roleEl = document.createElement('span');
      roleEl.className = 'msg-role';
      roleEl.textContent = role === 'user' ? 'You' : 'OpenCob';

      var timeEl = document.createElement('span');
      timeEl.className = 'msg-time';
      timeEl.textContent = formatTime(new Date());

      header.appendChild(icon);
      header.appendChild(roleEl);
      header.appendChild(timeEl);

      var contentEl = document.createElement('div');
      contentEl.className = 'msg-content';
      if (role === 'assistant') {
        contentEl.innerHTML = renderMarkdown(content);
      } else {
        contentEl.textContent = content;
      }

      // Message actions toolbar
      var actions = document.createElement('div');
      actions.className = 'msg-actions';
      actions.innerHTML = '<button class="msg-action-btn" data-action="copy" title="Copy">' +
        '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg></button>' +
        (role === 'user' ? '<button class="msg-action-btn" data-action="edit" title="Edit">' +
        '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"/></svg></button>' : '') +
        (role === 'assistant' ? '<button class="msg-action-btn" data-action="retry" title="Retry">' +
        '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/></svg></button>' : '');

      msg.appendChild(actions);
      msg.appendChild(header);
      msg.appendChild(contentEl);

      // Feedback for assistant messages
      if (role === 'assistant') {
        var feedback = document.createElement('div');
        feedback.className = 'msg-feedback';
        feedback.innerHTML = '<button class="feedback-btn" data-vote="up" title="Helpful">&#x1F44D;</button>' +
          '<button class="feedback-btn" data-vote="down" title="Not helpful">&#x1F44E;</button>';
        msg.appendChild(feedback);
      }

      // Wire action buttons
      msg.querySelectorAll('.msg-action-btn').forEach(function(btn) {
        btn.addEventListener('click', function(e) {
          e.stopPropagation();
          var action = btn.dataset.action;
          if (action === 'copy') {
            var text = contentEl.innerText || contentEl.textContent;
            navigator.clipboard.writeText(text);
            btn.classList.add('active');
            setTimeout(function() { btn.classList.remove('active'); }, 1500);
          } else if (action === 'edit') {
            input.value = contentEl.textContent;
            input.focus();
            input.style.height = 'auto';
            input.style.height = Math.min(input.scrollHeight, 140) + 'px';
          } else if (action === 'retry') {
            // Find the last user message and resend
            var userMsgs = messagesEl.querySelectorAll('.msg-user .msg-content');
            if (userMsgs.length) {
              var lastUserMsg = userMsgs[userMsgs.length - 1].textContent;
              vscode.postMessage({ type: 'chat', content: lastUserMsg });
            }
          }
        });
      });

      // Wire feedback buttons
      msg.querySelectorAll('.feedback-btn').forEach(function(btn) {
        btn.addEventListener('click', function(e) {
          e.stopPropagation();
          msg.querySelectorAll('.feedback-btn').forEach(function(b) { b.classList.remove('voted'); });
          btn.classList.add('voted');
        });
      });

      messagesEl.appendChild(msg);
      messagesEl.scrollTop = messagesEl.scrollHeight;

      // Check if message should be collapsible (over 300px tall)
      requestAnimationFrame(function() {
        if (contentEl.scrollHeight > 300) {
          msg.classList.add('collapsible');
          contentEl.classList.add('collapsed');
          var expandBtn = document.createElement('button');
          expandBtn.className = 'msg-expand-btn';
          expandBtn.textContent = 'Show more';
          expandBtn.addEventListener('click', function() {
            var isCollapsed = contentEl.classList.toggle('collapsed');
            expandBtn.textContent = isCollapsed ? 'Show more' : 'Show less';
            if (isCollapsed) contentEl.style.maxHeight = '300px';
            else contentEl.style.maxHeight = 'none';
          });
          msg.appendChild(expandBtn);
        }
      });

      return msg;
    }

    // ── Diff Preview Card (F1.2) ──
    function showDiffCard(filePath, diffContent) {
      var card = document.createElement('div');
      card.className = 'diff-card';
      var lines = diffContent.split('\\n').map(function(line) {
        var cls = 'diff-line-ctx';
        if (line.startsWith('+') && !line.startsWith('+++')) cls = 'diff-line-add';
        else if (line.startsWith('-') && !line.startsWith('---')) cls = 'diff-line-del';
        else if (line.startsWith('@@')) cls = 'diff-line-hdr';
        return '<span class="diff-line ' + cls + '">' + escapeHtml(line) + '</span>';
      }).join('');

      card.innerHTML =
        '<div class="diff-card-header">' +
          '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>' +
          '<span class="diff-card-file">' + escapeHtml(filePath) + '</span>' +
          '<div class="diff-card-actions">' +
            '<button class="diff-accept-btn">Accept</button>' +
            '<button class="diff-reject-btn">Reject</button>' +
          '</div>' +
        '</div>' +
        '<div class="diff-card-body">' + lines + '</div>';

      card.querySelector('.diff-accept-btn').addEventListener('click', function() {
        card.classList.add('accepted');
        card.querySelector('.diff-card-header').insertAdjacentHTML('beforeend',
          '<span style="font-size:11px;color:var(--vscode-terminal-ansiGreen);margin-left:8px;">\\u2713 Applied</span>');
        vscode.postMessage({ type: 'acceptDiff', file: filePath, diff: diffContent });
        showToast('Changes applied to ' + filePath, 'success');
      });
      card.querySelector('.diff-reject-btn').addEventListener('click', function() {
        card.classList.add('rejected');
        card.querySelector('.diff-card-header').insertAdjacentHTML('beforeend',
          '<span style="font-size:11px;color:var(--vscode-terminal-ansiRed);margin-left:8px;">\\u2717 Rejected</span>');
        vscode.postMessage({ type: 'rejectDiff', file: filePath });
      });

      messagesEl.appendChild(card);
      messagesEl.scrollTop = messagesEl.scrollHeight;
      return card;
    }

    // ── Basic Syntax Highlighting ──
    function highlightCode(code, lang) {
      if (!lang || lang === 'text') return code;
      var keywords, commentPattern;
      switch (lang.toLowerCase()) {
        case 'javascript': case 'js': case 'typescript': case 'ts':
          keywords = /\\b(const|let|var|function|return|if|else|for|while|class|import|export|from|async|await|new|this|typeof|switch|case|break|default|try|catch|throw|interface|type|extends|implements)\\b/g;
          commentPattern = /(\\/\\/.*$|\\/\\*[\\s\\S]*?\\*\\/)/gm;
          break;
        case 'python': case 'py':
          keywords = /\\b(def|class|import|from|return|if|elif|else|for|while|try|except|finally|with|as|yield|lambda|pass|raise|and|or|not|in|is|True|False|None)\\b/g;
          commentPattern = /(#.*$)/gm;
          break;
        case 'cobol': case 'cob':
          keywords = /\\b(IDENTIFICATION|DIVISION|ENVIRONMENT|DATA|PROCEDURE|SECTION|PERFORM|MOVE|TO|FROM|IF|ELSE|END-IF|DISPLAY|ACCEPT|STOP|RUN|WORKING-STORAGE|PICTURE|PIC|VALUE|CALL|USING|COPY|REPLACING|GO|THRU|UNTIL|VARYING|ADD|SUBTRACT|MULTIPLY|DIVIDE|COMPUTE|READ|WRITE|OPEN|CLOSE|EVALUATE|WHEN|END-EVALUATE|STRING|UNSTRING|INSPECT|SEARCH)\\b/gi;
          commentPattern = /(^.{6}\\*.*$)/gm;
          break;
        case 'java': case 'kotlin': case 'csharp': case 'cs':
          keywords = /\\b(public|private|protected|static|final|class|interface|extends|implements|import|package|return|if|else|for|while|new|this|void|int|string|boolean|try|catch|throw|throws|abstract|override|val|var|fun|suspend)\\b/g;
          commentPattern = /(\\/\\/.*$|\\/\\*[\\s\\S]*?\\*\\/)/gm;
          break;
        case 'sql':
          keywords = /\\b(SELECT|FROM|WHERE|JOIN|LEFT|RIGHT|INNER|OUTER|ON|INSERT|INTO|VALUES|UPDATE|SET|DELETE|CREATE|TABLE|ALTER|DROP|INDEX|GROUP|BY|ORDER|HAVING|LIMIT|OFFSET|UNION|AND|OR|NOT|NULL|AS|IN|EXISTS|BETWEEN|LIKE|DISTINCT|COUNT|SUM|AVG|MAX|MIN)\\b/gi;
          commentPattern = /(--.*$|\\/\\*[\\s\\S]*?\\*\\/)/gm;
          break;
        case 'json':
          code = code.replace(/"([^"]+)"\\s*:/g, '<span class="tok-keyword">"$1"</span>:');
          code = code.replace(/:[ ]*"([^"]*)"/g, ': <span class="tok-string">"$1"</span>');
          code = code.replace(/:[ ]*(\\d+\\.?\\d*)/g, ': <span class="tok-number">$1</span>');
          code = code.replace(/:[ ]*(true|false|null)/g, ': <span class="tok-keyword">$1</span>');
          return code;
        default: return code;
      }
      // Apply patterns
      if (commentPattern) code = code.replace(commentPattern, '<span class="tok-comment">$1</span>');
      if (keywords) code = code.replace(keywords, '<span class="tok-keyword">$&</span>');
      code = code.replace(/"([^"]*)"/g, '<span class="tok-string">"$1"</span>');
      code = code.replace(/'([^']*)'/g, '<span class="tok-string">\\'$1\\'</span>');
      code = code.replace(/\\b(\\d+\\.?\\d*)\\b/g, '<span class="tok-number">$1</span>');
      return code;
    }

    function addToolCall(toolName, parameters) {
      hideWelcome();
      var group = document.createElement('div');
      group.className = 'tool-group';

      var header = document.createElement('div');
      header.className = 'tool-header';
      header.innerHTML =
        '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"/></svg>' +
        '<span class="tool-name">' + escapeHtml(toolName) + '</span>' +
        '<span class="tool-status pending">running\\u2026</span>' +
        '<svg class="tool-chevron" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="9 18 15 12 9 6"/></svg>';

      var body = document.createElement('div');
      body.className = 'tool-body';
      body.textContent = JSON.stringify(parameters, null, 2);

      header.addEventListener('click', function() {
        body.classList.toggle('open');
        header.querySelector('.tool-chevron').classList.toggle('open');
      });

      group.appendChild(header);
      group.appendChild(body);
      messagesEl.appendChild(group);
      messagesEl.scrollTop = messagesEl.scrollHeight;
      currentToolEl = group;
      return group;
    }

    function completeToolCall(toolName, success, content) {
      if (currentToolEl) {
        var status = currentToolEl.querySelector('.tool-status');
        if (status) {
          status.className = 'tool-status ' + (success ? 'ok' : 'err');
          status.textContent = success ? 'done' : 'error';
        }
        if (!success) {
          var body = currentToolEl.querySelector('.tool-body');
          var chevron = currentToolEl.querySelector('.tool-chevron');
          if (body) { body.classList.add('open'); body.textContent += '\\n\\n' + content; }
          if (chevron) chevron.classList.add('open');
        }
      }
      currentToolEl = null;
    }

    // ── Markdown renderer ──
    function renderMarkdown(md) {
      if (!md) return '';
      var html = escapeHtml(md);

      html = html.replace(/\`\`\`(\\w*)\\n([\\s\\S]*?)\`\`\`/g, function(_, lang, code) {
        var langLabel = lang || 'text';
        var isDiff = langLabel === 'diff';
        var codeHtml = code;
        if (isDiff) {
          codeHtml = code.split('\\n').map(function(line) {
            if (line.startsWith('+')) return '<span class="diff-line-add">' + line + '</span>';
            if (line.startsWith('-')) return '<span class="diff-line-del">' + line + '</span>';
            if (line.startsWith('@@')) return '<span class="diff-line-header">' + line + '</span>';
            return line;
          }).join('\\n');
        } else {
          codeHtml = highlightCode(code, langLabel);
        }
        var id = 'cb-' + Math.random().toString(36).slice(2, 8);
        return '<div class="code-block-wrapper">' +
          '<div class="code-block-header"><span class="code-block-lang">' + langLabel + '</span>' +
          '<div class="code-block-actions">' +
          '<button class="code-action-btn" onclick="copyCode(this, \\'' + id + '\\')" title="Copy code">' +
          '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg> Copy</button>' +
          '<button class="code-action-btn" onclick="insertAtCursor(\\'' + id + '\\')" title="Insert at cursor">' +
          '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 5v14M5 12h14"/></svg> Insert</button>' +
          '<button class="code-action-btn" onclick="applyToFile(\\'' + id + '\\', \\'' + langLabel + '\\')" title="Apply to file">' +
          '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="20 6 9 17 4 12"/></svg> Apply</button>' +
          '</div></div>' +
          '<pre><code class="block-code" id="' + id + '">' + codeHtml + '</code></pre></div>';
      });

      html = html.replace(/\`([^\`]+)\`/g, '<code>$1</code>');
      html = html.replace(/\\*\\*(.+?)\\*\\*/g, '<strong>$1</strong>');
      html = html.replace(/\\*(.+?)\\*/g, '<em>$1</em>');
      html = html.replace(/~~(.+?)~~/g, '<del>$1</del>');
      html = html.replace(/^### (.+)$/gm, '<h3>$1</h3>');
      html = html.replace(/^## (.+)$/gm, '<h2>$1</h2>');
      html = html.replace(/^# (.+)$/gm, '<h1>$1</h1>');
      html = html.replace(/^---$/gm, '<hr/>');

      // Numbered lists
      html = html.replace(/^(\\d+)\\. (.+)$/gm, '<li class="ol-item">$2</li>');
      html = html.replace(/(<li class="ol-item">.*<\\/li>\\n?)+/g, function(m) { return '<ol>' + m + '</ol>'; });

      // Unordered lists
      html = html.replace(/^- (.+)$/gm, '<li>$1</li>');
      html = html.replace(/(<li>(?!class).*<\\/li>\\n?)+/g, function(m) { return '<ul>' + m + '</ul>'; });

      // Tables
      html = html.replace(/(\\|.+\\|\\n)(\\|[-: |]+\\|\\n)((?:\\|.+\\|\\n?)+)/g, function(_, headerRow, sepRow, bodyRows) {
        var headers = headerRow.trim().split('|').filter(function(c) { return c.trim(); });
        var rows = bodyRows.trim().split('\\n').map(function(r) {
          return r.split('|').filter(function(c) { return c.trim(); });
        });
        var tableHtml = '<table><thead><tr>' + headers.map(function(h) { return '<th>' + h.trim() + '</th>'; }).join('') + '</tr></thead><tbody>';
        rows.forEach(function(r) {
          tableHtml += '<tr>' + r.map(function(c) { return '<td>' + c.trim() + '</td>'; }).join('') + '</tr>';
        });
        tableHtml += '</tbody></table>';
        return tableHtml;
      });

      // Links: [text](url)
      html = html.replace(/\\[([^\\]]+)\\]\\(([^)]+)\\)/g, '<a href="$2" title="$2">$1</a>');

      // Auto-link bare URLs
      html = html.replace(/(^|\\s)(https?:\\/\\/[^\\s<]+)/g, '$1<a href="$2">$2</a>');

      html = html.replace(/\\n\\n/g, '</p><p>');
      html = '<p>' + html + '</p>';
      html = html.replace(/<p><(h[1-3]|ul|ol|div|pre|table|hr)/g, '<$1');
      html = html.replace(/<\\/(h[1-3]|ul|ol|div|pre|table)><\\/p>/g, '</$1>');
      html = html.replace(/<hr\\/><\\/p>/g, '<hr/>');
      return html;
    }

    function copyCode(btn, id) {
      var codeEl = document.getElementById(id);
      if (!codeEl) return;
      navigator.clipboard.writeText(codeEl.textContent).then(function() {
        btn.innerHTML = '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="20 6 9 17 4 12"/></svg> Copied!';
        btn.classList.add('copied');
        setTimeout(function() {
          btn.innerHTML = '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg> Copy';
          btn.classList.remove('copied');
        }, 2000);
      });
    }

    function insertAtCursor(id) {
      var codeEl = document.getElementById(id);
      if (!codeEl) return;
      vscode.postMessage({ type: 'insertAtCursor', code: codeEl.textContent });
    }

    function applyToFile(id, lang) {
      var codeEl = document.getElementById(id);
      if (!codeEl) return;
      vscode.postMessage({ type: 'applyToFile', code: codeEl.textContent, language: lang });
    }

    function openFile(path) {
      vscode.postMessage({ type: 'openFile', path: path });
    }

    // ── Message handler ──
    window.addEventListener('message', function(e) {
      var msg = e.data;
      switch (msg.type) {
        case 'responseStart':
          hideWelcome();
          assistantText = '';
          currentAssistantEl = addMessage('assistant', '');
          // Show thinking animation
          if (settings.thinking && currentAssistantEl) {
            var content = currentAssistantEl.querySelector('.msg-content');
            if (content) content.innerHTML = '<div class="thinking-dots"><span></span><span></span><span></span></div>';
          }
          setStatus('thinking', 'Thinking\\u2026');
          break;

        case 'responseChunk':
          if (msg.text) {
            assistantText += msg.text;
            if (currentAssistantEl) {
              var content = currentAssistantEl.querySelector('.msg-content');
              if (content) content.innerHTML = renderMarkdown(assistantText);
              messagesEl.scrollTop = messagesEl.scrollHeight;
            }
          }
          break;

        case 'toolCall':
          addToolCall(msg.toolName, msg.parameters);
          setStatus('running', msg.toolName + '\\u2026');
          break;

        case 'toolApproval':
          showApprovalCard(msg.toolName, msg.parameters, msg.risk || 'medium');
          setStatus('thinking', 'Awaiting approval\\u2026');
          break;

        case 'toolResult':
          completeToolCall(msg.toolName, msg.success, msg.content);
          break;

        case 'progress':
          if (msg.label) showProgress(msg.label, msg.percent || -1);
          break;

        case 'diffPreview':
          showDiffCard(msg.file || 'unknown', msg.diff || '');
          break;

        case 'responseEnd':
          // Add agent badge to completed assistant message
          if (currentAssistantEl) {
            var hdr = currentAssistantEl.querySelector('.msg-header');
            if (hdr && !hdr.querySelector('.agent-badge')) {
              var badge = document.createElement('span');
              badge.className = 'agent-badge';
              badge.textContent = activeMode;
              hdr.insertBefore(badge, hdr.querySelector('.msg-time'));
            }
          }
          currentAssistantEl = null;
          assistantText = '';
          setStatus('idle', '');
          sendBtn.disabled = false;
          stopBtn.classList.remove('visible');
          updateTurns();
          vscode.postMessage({ type: 'getTokenUsage' });
          break;

        case 'error':
          hideWelcome();
          var errDiv = document.createElement('div');
          errDiv.className = 'error-banner';
          errDiv.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg><span>' + escapeHtml(msg.text) + '</span>';
          messagesEl.appendChild(errDiv);
          messagesEl.scrollTop = messagesEl.scrollHeight;
          setStatus('idle', '');
          sendBtn.disabled = false;
          break;

        case 'modeChanged':
          activeMode = msg.mode;
          if (activeModeLabel) activeModeLabel.textContent = msg.mode;
          var match = agentModes.find(function(m) { return m.slug === msg.mode; });
          if (match && agentDropdownLabel) agentDropdownLabel.textContent = match.name;
          updateDropdownIcon();
          if (modeToggleBtn) modeToggleBtn.textContent = (msg.mode === 'ask') ? 'Chat' : 'Agent';
          break;

        case 'modelChanged':
          if (modelSelect) modelSelect.value = msg.model;
          break;

        case 'modelsAvailable':
          if (modelSelect) {
            modelSelect.innerHTML = '';
            modelSelect.disabled = false;
            (msg.models || []).forEach(function(m) {
              var opt = document.createElement('option');
              opt.value = m;
              opt.textContent = m.indexOf('/') !== -1 ? m.split('/').pop() : m;
              if (m === msg.current) opt.selected = true;
              modelSelect.appendChild(opt);
            });
          }
          break;

        case 'connectionStatus':
          if (msg.connected) {
            modelSelect.title = msg.provider + ' (' + msg.modelCount + ' models)';
          } else {
            modelSelect.disabled = true;
            modelSelect.innerHTML = '<option value="">Disconnected</option>';
          }
          break;

        case 'newConversation':
          messagesEl.innerHTML = '';
          var w = document.createElement('div');
          w.className = 'welcome';
          w.id = 'welcome';
          w.innerHTML = '<svg class="welcome-icon" viewBox="0 0 128 128"><rect width="128" height="128" rx="16" fill="transparent"/><rect x="40" y="76" width="48" height="32" rx="6" fill="#1a1a1a" stroke="#33ff33" stroke-width="1.5"/><rect x="48" y="80" width="32" height="16" rx="3" fill="#0d1a0d" stroke="#33ff33" stroke-width="0.8"/><line x1="51" y1="85" x2="68" y2="85" stroke="#33ff33" stroke-width="1" opacity="0.8"/><line x1="51" y1="89" x2="75" y2="89" stroke="#33ff33" stroke-width="1" opacity="0.6"/><line x1="51" y1="93" x2="63" y2="93" stroke="#33ff33" stroke-width="1" opacity="0.7"/><rect x="58" y="70" width="12" height="7" rx="2" fill="#1a1a1a" stroke="#33ff33" stroke-width="1"/><rect x="46" y="20" width="36" height="52" rx="18" fill="#2d5a00" stroke="#33ff33" stroke-width="1.5"/><path d="M46 30 Q36 38 35 50 Q37 60 43 68" fill="#1a3d00" fill-opacity="0.6" stroke="#33ff33" stroke-width="1.5" stroke-linecap="round"/><path d="M82 30 Q92 38 93 50 Q91 60 85 68" fill="#1a3d00" fill-opacity="0.6" stroke="#33ff33" stroke-width="1.5" stroke-linecap="round"/><path d="M61 20 Q60 12 58 6" fill="none" stroke="#33ff33" stroke-width="1" stroke-linecap="round" opacity="0.7"/><path d="M64 20 Q64 11 64 4" fill="none" stroke="#33ff33" stroke-width="1.2" stroke-linecap="round" opacity="0.8"/><path d="M67 20 Q68 12 70 6" fill="none" stroke="#33ff33" stroke-width="1" stroke-linecap="round" opacity="0.7"/><rect x="53" y="35" width="10" height="8" rx="2" fill="#0d1a0d" stroke="#33ff33" stroke-width="1.2"/><rect x="56" y="37" width="4" height="4" rx="1" fill="#33ff33"/><rect x="57" y="38" width="2" height="2" fill="#88ff88"/><path d="M77 35 L70 39 L77 43" fill="none" stroke="#33ff33" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/><path d="M57 54 Q64 61 71 54" fill="#0d1a0d" stroke="#33ff33" stroke-width="1.5" stroke-linecap="round"/><rect x="28" y="78" width="10" height="24" rx="5" fill="#1a1a1a" stroke="#33ff33" stroke-width="1.2"/><g><animateTransform attributeName="transform" type="rotate" values="0 95 78;-20 95 78;0 95 78" dur="1s" repeatCount="indefinite"/><rect x="90" y="78" width="10" height="24" rx="5" fill="#1a1a1a" stroke="#33ff33" stroke-width="1.2"/><circle cx="95" cy="78" r="4" fill="#1a1a1a" stroke="#33ff33" stroke-width="1"/><circle cx="95" cy="104" r="5" fill="#1a1a1a" stroke="#33ff33" stroke-width="1.2"/></g><circle cx="33" cy="78" r="4" fill="#1a1a1a" stroke="#33ff33" stroke-width="1"/><circle cx="33" cy="104" r="5" fill="#1a1a1a" stroke="#33ff33" stroke-width="1.2"/><rect x="48" y="108" width="10" height="12" rx="4" fill="#1a1a1a" stroke="#33ff33" stroke-width="1.2"/><rect x="70" y="108" width="10" height="12" rx="4" fill="#1a1a1a" stroke="#33ff33" stroke-width="1.2"/><ellipse cx="53" cy="122" rx="8" ry="4" fill="#1a1a1a" stroke="#33ff33" stroke-width="1.2"/><ellipse cx="75" cy="122" rx="8" ry="4" fill="#1a1a1a" stroke="#33ff33" stroke-width="1.2"/></svg><h2>OpenCob</h2><p>AI-powered COBOL analysis, refactoring, and modernization assistant.</p>';
          messagesEl.appendChild(w);
          currentAssistantEl = null;
          assistantText = '';
          break;

        case 'conversationLoaded':
          messagesEl.innerHTML = '';
          if (msg.messages && msg.messages.length > 0) {
            msg.messages.forEach(function(m) {
              if (m.role === 'user' || m.role === 'assistant') {
                addMessage(m.role, m.content);
              }
            });
          }
          currentAssistantEl = null;
          assistantText = '';
          updateTurns();
          vscode.postMessage({ type: 'getTokenUsage' });
          break;

        case 'historyList':
          renderHistory(msg.conversations);
          break;

        case 'toolsList':
          renderTools(msg.tools || []);
          break;

        case 'modesList':
          renderModes(msg.modes || []);
          break;

        case 'tokenUsage':
          setUsage(msg.used, msg.max, msg.messageCount);
          renderSessionCard();
          break;

        case 'workspaceScope':
          workspaceScope = msg.folders || [];
          workspaceScopeSelected = msg.selected || [];
          renderWorkspaceScopePill();
          renderSessionCard();
          renderWorkspaceScopeMenu();
          break;

        case 'response':
          addMessage('assistant', msg.text);
          break;

        case 'enhancedPrompt':
          input.value = msg.text;
          enhanceBtn.classList.remove('enhancing');
          input.focus();
          break;

        case 'contextFiles':
          showContextPopup(msg.files || []);
          break;
      }
    });

    if (activeModeLabel) activeModeLabel.textContent = activeMode;
    renderWorkspaceScopePill();
    renderSessionCard();

    // ── Keyboard shortcuts overlay ──
    shortcutsBtn.addEventListener('click', function() {
      shortcutsOverlay.classList.add('visible');
    });
    shortcutsOverlay.addEventListener('click', function(e) {
      if (e.target === shortcutsOverlay) shortcutsOverlay.classList.remove('visible');
    });
    document.addEventListener('keydown', function(e) {
      if (e.ctrlKey && e.key === '/') {
        e.preventDefault();
        shortcutsOverlay.classList.toggle('visible');
      }
      if (e.key === 'Escape' && shortcutsOverlay.classList.contains('visible')) {
        shortcutsOverlay.classList.remove('visible');
        e.preventDefault();
      }
      if (e.ctrlKey && e.key === 'n') {
        e.preventDefault();
        vscode.postMessage({ type: 'newConversation' });
      }
      if (e.ctrlKey && e.key === 'h') {
        e.preventDefault();
        historyPanel.classList.toggle('hidden');
        if (!historyPanel.classList.contains('hidden')) {
          vscode.postMessage({ type: 'getHistory' });
        }
      }
      if (e.ctrlKey && e.key === 'l') {
        e.preventDefault();
        input.focus();
      }
      if (e.ctrlKey && e.key === 'f') {
        e.preventDefault();
        searchBar.classList.add('visible');
        searchInput.focus();
      }
      if (e.ctrlKey && e.key === '.') {
        e.preventDefault();
        vscode.postMessage({ type: 'cycleMode' });
      }
    });

    // ── Toast notification system ──
    function showToast(message, type) {
      type = type || 'info';
      var icons = {
        success: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="20 6 9 17 4 12"/></svg>',
        error: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg>',
        info: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg>'
      };
      var toast = document.createElement('div');
      toast.className = 'toast ' + type;
      toast.innerHTML = '<span class="toast-icon">' + (icons[type] || icons.info) + '</span>' +
        '<span class="toast-text">' + escapeHtml(message) + '</span>' +
        '<button class="toast-close">&times;</button>';
      toastContainer.appendChild(toast);
      toast.querySelector('.toast-close').addEventListener('click', function() {
        toast.remove();
      });
      setTimeout(function() { toast.remove(); }, 4000);
    }

    // ── Search in conversation ──
    searchCloseBtn.addEventListener('click', function() {
      searchBar.classList.remove('visible');
      clearSearchHighlights();
      searchInput.value = '';
      searchCount.textContent = '';
    });
    searchInput.addEventListener('input', function() {
      performSearch(searchInput.value.trim());
    });
    searchPrev.addEventListener('click', function() {
      if (searchMatches.length) {
        searchIdx = (searchIdx - 1 + searchMatches.length) % searchMatches.length;
        highlightMatch(searchIdx);
      }
    });
    searchNext.addEventListener('click', function() {
      if (searchMatches.length) {
        searchIdx = (searchIdx + 1) % searchMatches.length;
        highlightMatch(searchIdx);
      }
    });

    function clearSearchHighlights() {
      messagesEl.querySelectorAll('.search-highlight').forEach(function(el) {
        var parent = el.parentNode;
        parent.replaceChild(document.createTextNode(el.textContent), el);
        parent.normalize();
      });
      searchMatches = [];
      searchIdx = -1;
    }

    function performSearch(query) {
      clearSearchHighlights();
      if (!query) { searchCount.textContent = ''; return; }
      var escaped = query.replace(/[.*+?^\\$\\{\\}()|[\\]\\\\]/g, '\\\\$&');
      var regex = new RegExp('(' + escaped + ')', 'gi');
      var contents = messagesEl.querySelectorAll('.msg-content');
      searchMatches = [];
      contents.forEach(function(contentEl) {
        var walker = document.createTreeWalker(contentEl, NodeFilter.SHOW_TEXT, null);
        var textNodes = [];
        while (walker.nextNode()) textNodes.push(walker.currentNode);
        textNodes.forEach(function(node) {
          if (regex.test(node.textContent)) {
            var span = document.createElement('span');
            span.innerHTML = node.textContent.replace(regex, '<mark class="search-highlight">$1</mark>');
            node.parentNode.replaceChild(span, node);
            span.querySelectorAll('.search-highlight').forEach(function(m) {
              searchMatches.push(m);
            });
          }
          regex.lastIndex = 0;
        });
      });
      searchCount.textContent = searchMatches.length + ' found';
      if (searchMatches.length) { searchIdx = 0; highlightMatch(0); }
    }

    function highlightMatch(idx) {
      searchMatches.forEach(function(m, i) {
        m.classList.toggle('active', i === idx);
      });
      if (searchMatches[idx]) {
        searchMatches[idx].scrollIntoView({ block: 'center', behavior: 'smooth' });
      }
    }

    // ── Drag & Drop file attachment ──
    messagesEl.addEventListener('dragover', function(e) {
      e.preventDefault();
      e.stopPropagation();
      dropZone.classList.add('active');
    });
    messagesEl.addEventListener('dragleave', function(e) {
      e.preventDefault();
      dropZone.classList.remove('active');
    });
    dropZone.addEventListener('dragleave', function(e) {
      e.preventDefault();
      dropZone.classList.remove('active');
    });
    dropZone.addEventListener('drop', function(e) {
      e.preventDefault();
      dropZone.classList.remove('active');
      var files = e.dataTransfer.files;
      for (var i = 0; i < files.length; i++) {
        var name = files[i].name;
        addChip(name);
        contextAttachments.push(name);
      }
      renderChips();
      showToast(files.length + ' file(s) added as context', 'success');
    });

    // ── Custom Agent Dialog ──
    document.getElementById('agent-cancel').addEventListener('click', function() {
      agentDialogOverlay.classList.remove('visible');
    });
    agentDialogOverlay.addEventListener('click', function(e) {
      if (e.target === agentDialogOverlay) agentDialogOverlay.classList.remove('visible');
    });
    document.getElementById('agent-create').addEventListener('click', function() {
      var name = document.getElementById('agent-name').value.trim();
      var display = document.getElementById('agent-display').value.trim();
      var role = document.getElementById('agent-role').value.trim();
      var when = document.getElementById('agent-when').value.trim();
      var toolSelect = document.getElementById('agent-tools');
      var tools = Array.from(toolSelect.selectedOptions).map(function(o) { return o.value; });
      if (!name || !role) {
        showToast('Name and role definition are required', 'error');
        return;
      }
      vscode.postMessage({
        type: 'createCustomAgent',
        agent: { slug: name, name: display || name, roleDefinition: role, whenToUse: when, groups: tools }
      });
      agentDialogOverlay.classList.remove('visible');
      showToast('Agent "' + (display || name) + '" created', 'success');
      // Clear form
      document.getElementById('agent-name').value = '';
      document.getElementById('agent-display').value = '';
      document.getElementById('agent-role').value = '';
      document.getElementById('agent-when').value = '';
    });

    // ── Show approval card ──
    function showApprovalCard(toolName, parameters, riskLevel) {
      riskLevel = riskLevel || 'medium';
      var card = document.createElement('div');
      card.className = 'approval-card';
      card.innerHTML =
        '<div class="approval-card-header">' +
          '<div class="approval-card-icon"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg></div>' +
          '<div class="approval-card-info"><div class="approval-card-title">' + escapeHtml(toolName) + '</div>' +
          '<div class="approval-card-subtitle">Requires your approval to proceed</div></div>' +
          '<span class="approval-card-risk ' + riskLevel + '">' + riskLevel + '</span>' +
        '</div>' +
        '<div class="approval-card-body">' + escapeHtml(JSON.stringify(parameters, null, 2)) + '</div>' +
        '<div class="approval-card-actions">' +
          '<button class="approval-btn allow">Allow</button>' +
          '<button class="approval-btn always">Always Allow</button>' +
          '<button class="approval-btn deny">Deny</button>' +
        '</div>';
      messagesEl.appendChild(card);
      messagesEl.scrollTop = messagesEl.scrollHeight;

      card.querySelector('.approval-btn.allow').addEventListener('click', function() {
        vscode.postMessage({ type: 'approveAction', tool: toolName, decision: 'allow' });
        card.querySelector('.approval-card-actions').innerHTML = '<span style="font-size:11px;color:var(--vscode-terminal-ansiGreen)">\\u2713 Approved</span>';
        showToast(toolName + ' approved', 'success');
      });
      card.querySelector('.approval-btn.always').addEventListener('click', function() {
        vscode.postMessage({ type: 'approveAction', tool: toolName, decision: 'always' });
        card.querySelector('.approval-card-actions').innerHTML = '<span style="font-size:11px;color:var(--vscode-terminal-ansiGreen)">\\u2713 Always allowed</span>';
        showToast(toolName + ' always allowed', 'success');
      });
      card.querySelector('.approval-btn.deny').addEventListener('click', function() {
        vscode.postMessage({ type: 'approveAction', tool: toolName, decision: 'deny' });
        card.querySelector('.approval-card-actions').innerHTML = '<span style="font-size:11px;color:var(--vscode-terminal-ansiRed)">\\u2717 Denied</span>';
        showToast(toolName + ' denied', 'info');
      });
      return card;
    }

    // ── Progress indicator ──
    function showProgress(label, percent) {
      var card = document.createElement('div');
      card.className = 'progress-card';
      card.innerHTML = '<div class="progress-label">' + escapeHtml(label) + '</div>' +
        '<div class="progress-track"><div class="progress-fill' + (percent < 0 ? ' indeterminate' : '') + '" style="width:' + (percent < 0 ? '40' : percent) + '%"></div></div>';
      messagesEl.appendChild(card);
      messagesEl.scrollTop = messagesEl.scrollHeight;
      return card;
    }

    function updateProgress(card, percent) {
      if (!card) return;
      var fill = card.querySelector('.progress-fill');
      if (fill) {
        fill.classList.remove('indeterminate');
        fill.style.width = percent + '%';
      }
    }

    // ── Settings toggles ──
    document.querySelectorAll('.setting-toggle').forEach(function(btn) {
      var key = btn.dataset.setting;
      if (settings[key]) btn.classList.add('on');
      else btn.classList.remove('on');
      btn.addEventListener('click', function() {
        settings[key] = !settings[key];
        btn.classList.toggle('on', settings[key]);
      });
    });

    // ── Turns counter ──
    function updateTurns() {
      var userMsgs = messagesEl.querySelectorAll('.msg-user');
      turnCount = userMsgs.length;
      turnsBadge.textContent = turnCount + (turnCount === 1 ? ' turn' : ' turns');
    }

    vscode.postMessage({ type: 'webviewReady' });
    vscode.postMessage({ type: 'getModes' });
    vscode.postMessage({ type: 'getTools' });
    vscode.postMessage({ type: 'getTokenUsage' });
  </script>
</body>
</html>`;
  }
}
