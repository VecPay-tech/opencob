import * as vscode from 'vscode';
import * as path from 'node:path';
import { ChatPanelProvider } from './chat/chat-panel-provider.js';
import { InlineCompletionProvider } from './completion/inline-completion-provider.js';
import { FindingsProvider, type Finding } from './findings/findings-provider.js';
import { EEClient } from './enterprise/ee-client.js';
import {
  ModeEngine,
  OllamaAdapter,
  ToolRegistry,
  ConversationManager,
  AgentLoop,
  RedactionEngine,
  FileFilter,
  ConfigLoader,
  SnapshotManager,
  MCPClient,
  FindingsScanner,
  WorkspaceIndexer,
  RAGPipeline,
  ModelRouter,
  LiterateCodingEngine,
  createReadFileTool,
  createListFilesTool,
  createSearchFilesTool,
  createWriteFileTool,
  createApplyDiffTool,
  createExecuteCommandTool,
  createAskFollowupTool,
  createSwitchModeTool,
  createListCodeDefinitionsTool,
  createInsertContentTool,
  createUndoLastTurnTool,
  createAnalyzeCodeTool,
  createGenerateDiagramTool,
  createUseMcpTool,
  createSemanticSearchTool,
  createFindReferencesTool,
  createShowImpactChainTool,
  createMultiEditTool,
  createManageTodoTool,
} from '@opencob/core';

export function activate(context: vscode.ExtensionContext): void {
  const workspaceRoot =
    vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.cwd();

  // Load configuration
  const configLoader = new ConfigLoader(workspaceRoot);
  configLoader.load().then((projectConfig) => {
    // Apply any custom modes from .OpenCob/custom_modes.json
    if (projectConfig.customModes.length > 0) {
      for (const cm of projectConfig.customModes) {
        modeEngine.registerMode({
          slug: cm.slug,
          name: cm.name,
          roleDefinition: cm.roleDefinition,
          whenToUse: cm.whenToUse,
          groups: cm.groups,
          customInstructions: cm.customInstructions,
        });
      }
    }
  });

  // Initialize core components
  const modeEngine = new ModeEngine();
  const config = vscode.workspace.getConfiguration('OpenCob');
  const ollamaAdapter = new OllamaAdapter({
    baseUrl: config.get<string>('ollama.baseUrl', 'http://127.0.0.1:11434'),
    chatModel: config.get<string>('model.chat', 'qwen2.5-coder:7b'),
    completionModel: config.get<string>('model.completion', 'qwen2.5-coder:1.5b'),
  });

  const fileFilter = new FileFilter(workspaceRoot);
  fileFilter.loadIgnoreFile();

  const redactionEngine = new RedactionEngine();
  const snapshotManager = new SnapshotManager(workspaceRoot);

  // Initialize MCP client
  const mcpClient = new MCPClient();
  mcpClient.loadConfig(workspaceRoot).then(async (servers) => {
    for (const server of servers) {
      try {
        await mcpClient.connect(server);
        console.log(`[OpenCob] MCP server connected: ${server.id}`);
      } catch (err) {
        console.error(`[OpenCob] MCP server failed: ${server.id}`, err);
      }
    }
  });

  // Initialize Findings Scanner
  const findingsScanner = new FindingsScanner(workspaceRoot);

  // Initialize Workspace Indexer & RAG Pipeline (F8)
  const workspaceIndexer = new WorkspaceIndexer(workspaceRoot, fileFilter);
  const ragPipeline = new RAGPipeline();

  // Initialize Findings Provider for TreeView
  const findingsProvider = new FindingsProvider(context);
  context.subscriptions.push(
    vscode.window.registerTreeDataProvider('OpenCob.findings', findingsProvider),
  );

  // Initialize Model Router (F9)
  const modelRouter = new ModelRouter(ollamaAdapter, {
    chat: config.get<string>('model.chat', 'qwen2.5-coder:7b'),
    completion: config.get<string>('model.completion', 'qwen2.5-coder:1.5b'),
    embedding: config.get<string>('model.embedding', 'nomic-embed-text'),
  });

  // Initialize Literate Coding (F18)
  const literateCoding = new LiterateCodingEngine();

  const toolRegistry = new ToolRegistry(modeEngine, {
    approvalCallback: async (tool, params) => {
      const serialized = JSON.stringify(params, null, 2);
      const preview = serialized.length > 600
        ? `${serialized.slice(0, 600)}\n...`
        : serialized;
      const decision = await vscode.window.showWarningMessage(
        `OpenCob requests approval for ${tool.name}.`,
        {
          modal: true,
          detail: `Tool group: ${tool.group}\n\nParameters:\n${preview}`,
        },
        'Approve',
        'Reject',
      );
      return decision === 'Approve';
    },
    fileFilter: fileFilter.getFilterFn(),
    autoApprove: {
      read: config.get<boolean>('autoApprove.read', false),
      edit: config.get<boolean>('autoApprove.edit', config.get<boolean>('autoApprove.write', false)),
      command: config.get<boolean>('autoApprove.command', false),
      mcp: config.get<boolean>('autoApprove.mcp', false),
    },
  });

  // Register built-in tools
  toolRegistry.registerAll([
    createReadFileTool(workspaceRoot),
    createListFilesTool(workspaceRoot),
    createSearchFilesTool(workspaceRoot),
    createWriteFileTool(workspaceRoot),
    createApplyDiffTool(workspaceRoot),
    createExecuteCommandTool(workspaceRoot),
    createAskFollowupTool(),
    createSwitchModeTool(modeEngine),
    createListCodeDefinitionsTool(workspaceRoot),
    createInsertContentTool(workspaceRoot),
    createUndoLastTurnTool(snapshotManager),
    createAnalyzeCodeTool(workspaceRoot),
    createGenerateDiagramTool(workspaceRoot),
    createUseMcpTool(mcpClient),
    createSemanticSearchTool(ragPipeline),
    createFindReferencesTool(workspaceRoot),
    createShowImpactChainTool(workspaceRoot),
    createMultiEditTool(workspaceRoot, snapshotManager),
    createManageTodoTool(),
  ]);

  const conversationManager = new ConversationManager({
    persistencePath: path.join(workspaceRoot, '.opencob', 'conversations.json'),
  });
  const agentLoop = new AgentLoop(
    ollamaAdapter,
    toolRegistry,
    conversationManager,
    modeEngine,
    { workspaceRoot },
    redactionEngine,
    snapshotManager,
  );
  void agentLoop.loadCustomCommands();

  // Register Inline Completion Provider (F2)
  const inlineCompletionProvider = new InlineCompletionProvider(
    ollamaAdapter,
    redactionEngine,
  );
  context.subscriptions.push(
    vscode.languages.registerInlineCompletionItemProvider(
      { pattern: '**' },
      inlineCompletionProvider,
    ),
    inlineCompletionProvider,
  );

  const chatProvider = new ChatPanelProvider(
    context.extensionUri,
    agentLoop,
    modeEngine,
  );

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider('OpenCob.chatPanel', chatProvider),

    vscode.commands.registerCommand('OpenCob.openChat', () => {
      vscode.commands.executeCommand('OpenCob.chatPanel.focus');
    }),

    vscode.commands.registerCommand('OpenCob.switchMode', async () => {
      const modes = modeEngine.listModes().map((m) => ({
        label: m.name,
        description: m.whenToUse,
        slug: m.slug,
      }));
      const selected = await vscode.window.showQuickPick(modes, {
        placeHolder: 'Select OpenCob mode',
      });
      if (selected) {
        modeEngine.setActive(selected.slug);
        chatProvider.setMode(selected.label);
      }
    }),

    vscode.commands.registerCommand('OpenCob.newConversation', () => {
      conversationManager.clear();
      chatProvider.newConversation();
    }),

    // Model picker (F9)
    vscode.commands.registerCommand('OpenCob.selectModel', async () => {
      const available = await ollamaAdapter.isAvailable();
      if (!available) {
        vscode.window.showErrorMessage('OpenCob: Ollama is not running. Start it with: ollama serve');
        return;
      }
      const models = await ollamaAdapter.listModels();
      const items = models.map((m) => ({ label: m, description: 'Ollama model' }));
      const selected = await vscode.window.showQuickPick(items, {
        placeHolder: 'Select a model for chat',
      });
      if (selected) {
        ollamaAdapter.setChatModel(selected.label);
        statusBarItem.text = `$(hubot) ${selected.label}`;
        vscode.window.showInformationMessage(`OpenCob: Switched to ${selected.label}`);
      }
    }),

    // Undo last turn (F20 / F6.4)
    vscode.commands.registerCommand('OpenCob.undoLastTurn', () => {
      const result = snapshotManager.undoLastTurn();
      if (!result) {
        vscode.window.showInformationMessage('OpenCob: Nothing to undo.');
        return;
      }
      vscode.window.showInformationMessage(
        `OpenCob: Undid turn ${result.turnId} — restored ${result.restoredFiles.length} file(s)`,
      );
    }),

    // Scan workspace for findings (F7)
    vscode.commands.registerCommand('OpenCob.scanWorkspace', () => {
      const findings = findingsScanner.scanWorkspace();
      const counts = findingsScanner.getCounts();
      vscode.window.showInformationMessage(
        `OpenCob Scan: ${counts.error} errors, ${counts.warning} warnings, ${counts.info} info (${counts.total} total)`,

          // Open finding in editor
          vscode.commands.registerCommand('opencob.openFinding', async (finding: Finding) => {
            const fileUri = vscode.Uri.file(path.join(workspaceRoot, finding.file));
            const doc = await vscode.workspace.openTextDocument(fileUri);
            const editor = await vscode.window.showTextDocument(doc);
            const line = Math.max(0, finding.line - 1);
            editor.selection = new vscode.Selection(line, 0, line, 0);
            editor.revealRange(new vscode.Range(line, 0, line, 0), vscode.TextEditorRevealType.InCenter);
          }),

          // Toggle findings view mode
          vscode.commands.registerCommand('OpenCob.toggleFindingsMode', async () => {
            const result = await vscode.window.showQuickPick(
              [
                { label: 'Group by File', description: 'Organize findings by source file', mode: 'file' },
                { label: 'Group by Severity', description: 'Organize findings by severity level', mode: 'severity' },
              ],
              { placeHolder: 'Select findings view mode' },
            );
            if (result) {
              findingsProvider.setViewMode(result.mode as 'file' | 'severity');
            }
          }),

          // Clear findings
          vscode.commands.registerCommand('OpenCob.clearFindings', () => {
            findingsProvider.clear();
            vscode.window.showInformationMessage('OpenCob: Findings cleared');
          }),
      );
    }),
  );

  // Background scan on file save (F7) + incremental re-indexing (F8)
  context.subscriptions.push(
    vscode.workspace.onDidSaveTextDocument((doc) => {
      const relPath = vscode.workspace.asRelativePath(doc.uri);
      findingsScanner.scanFile(relPath);
      // Incremental re-index
      workspaceIndexer.reindexFile(relPath);
      ragPipeline.reindexFile(relPath, workspaceIndexer.getFileChunks(relPath));
      ragPipeline.trackRecentEdit(relPath);

      // Wire findings to the TreeView provider
      context.subscriptions.push(
        vscode.commands.registerCommand('OpenCob.showFindings', () => {
          const allFindings = findingsScanner.getFindings();
          const findings: Finding[] = allFindings.map(f => ({
            id: f.id,
            file: f.file,
            line: f.line,
            severity: f.severity as 'error' | 'warning' | 'info',
            type: f.type,
            message: f.message,
            details: f.details,
            suggestion: f.suggestion,
            timestamp: Date.now(),
          }));
          findingsProvider.addFindings(findings);
          vscode.commands.executeCommand('OpenCob.findings.focus');
          const counts = findingsProvider.getCount();
          vscode.window.showInformationMessage(
            `OpenCob: ${counts.errors} errors, ${counts.warnings} warnings, ${counts.infos} info (${counts.total} total)`,
          );
        }),
      );
    }),
  );

  // Workspace indexing on activation (F8)
  const indexStatusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 50);
  indexStatusBar.text = '$(sync~spin) Indexing...';
  indexStatusBar.tooltip = 'OpenCob: Indexing workspace for code intelligence';
  indexStatusBar.show();
  context.subscriptions.push(indexStatusBar);

  workspaceIndexer.onProgress((status) => {
    if (status.isIndexing) {
      indexStatusBar.text = `$(sync~spin) Indexing ${status.indexedFiles}/${status.totalFiles}`;
    } else {
      indexStatusBar.text = `$(database) ${status.indexedFiles} files indexed`;
      // Auto-hide after 5s
      setTimeout(() => { indexStatusBar.hide(); }, 5000);
    }
  });

  workspaceIndexer.indexWorkspace().then(() => {
    // Feed chunks to RAG pipeline
    ragPipeline.indexChunks(workspaceIndexer.getAllChunks());
    console.log(`[OpenCob] Workspace indexed: ${workspaceIndexer.getStatus().indexedFiles} files`);
  });

  // Literate Coding command (F18)
  context.subscriptions.push(
    vscode.commands.registerCommand('OpenCob.literateCoding', async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) {
        vscode.window.showWarningMessage('OpenCob: No active editor');
        return;
      }
      const doc = editor.document;
      const content = doc.getText();
      const language = doc.languageId;
      const blocks = literateCoding.detectBlocks(content, language);

      if (blocks.length === 0) {
        vscode.window.showInformationMessage('OpenCob: No literate coding blocks found (use // @OpenCob: <instruction>)');
        return;
      }

      vscode.window.showInformationMessage(`OpenCob: Found ${blocks.length} literate block(s) — generating code...`);
    }),
  );

  // ── Enterprise Edition handshake ────────────────────────────────────
  const eeClient = new EEClient({
    onStateChange: (state) => {
      if (state.connected) {
        eeStatusBar.text = `$(cloud) EE: ${state.user?.displayName ?? 'Connected'}`;
        eeStatusBar.tooltip = `Connected to ${state.serverUrl}`;
        eeStatusBar.show();
      } else {
        eeStatusBar.hide();
      }
    },
  });

  const eeStatusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 99);
  eeStatusBar.command = 'OpenCob.connectEnterprise';
  context.subscriptions.push(eeStatusBar);

  // Auto-connect if token and URL are saved in settings
  const eeServerUrl = config.get<string>('enterprise.serverUrl', '');
  const eeToken = config.get<string>('enterprise.token', '');
  if (eeServerUrl && eeToken) {
    eeClient.connectWithToken(eeServerUrl, eeToken).catch(() => {
      // Silent failure on startup — user can reconnect manually
    });
  }

  context.subscriptions.push(
    vscode.commands.registerCommand('OpenCob.connectEnterprise', async () => {
      const serverUrl = await vscode.window.showInputBox({
        prompt: 'Enter the OpenCob Enterprise server URL',
        value: config.get<string>('enterprise.serverUrl', ''),
        placeHolder: 'https://opencob-ee.company.com',
      });
      if (!serverUrl) return;

      const email = await vscode.window.showInputBox({
        prompt: 'Enter your email address',
        placeHolder: 'user@company.com',
      });
      if (!email) return;

      try {
        const state = await eeClient.connect(serverUrl, email);
        // Save settings
        await vscode.workspace.getConfiguration('OpenCob').update('enterprise.serverUrl', serverUrl, vscode.ConfigurationTarget.Global);
        await vscode.workspace.getConfiguration('OpenCob').update('enterprise.token', state.user ? eeClient['token'] : '', vscode.ConfigurationTarget.Global);

        const caps = state.capabilities?.capabilities;
        const capList = caps
          ? Object.entries(caps).map(([k, v]) => `${k}: ${(v as string[]).join(', ')}`).join('\n')
          : 'none';

        vscode.window.showInformationMessage(
          `OpenCob: Connected to Enterprise server as ${state.user?.displayName ?? state.user?.email}\n\nCapabilities:\n${capList}`,
        );
      } catch (error) {
        vscode.window.showErrorMessage(
          `OpenCob: Failed to connect — ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }),

    vscode.commands.registerCommand('OpenCob.disconnectEnterprise', async () => {
      eeClient.disconnect();
      await vscode.workspace.getConfiguration('OpenCob').update('enterprise.token', '', vscode.ConfigurationTarget.Global);
      vscode.window.showInformationMessage('OpenCob: Disconnected from Enterprise server');
    }),
  );

  const statusBarItem = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Right,
    100,
  );
  statusBarItem.text = `$(hubot) ${config.get<string>('model.chat', 'qwen2.5-coder:7b')}`;
  statusBarItem.tooltip = 'OpenCob — Click to switch model';
  statusBarItem.command = 'OpenCob.selectModel';
  statusBarItem.show();
  context.subscriptions.push(statusBarItem);

  // Disconnect MCP servers on deactivation
  context.subscriptions.push({
    dispose: () => mcpClient.disconnectAll(),
  });

  console.log('OpenCob CE activated');
}

export function deactivate(): void {
  // cleanup
}
