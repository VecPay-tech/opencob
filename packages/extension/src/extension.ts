import * as vscode from 'vscode';
import * as path from 'node:path';
import { ChatPanelProvider } from './chat/chat-panel-provider.js';
import { InlineCompletionProvider } from './completion/inline-completion-provider.js';
import { FindingsProvider, type Finding } from './findings/findings-provider.js';

import { EEClient } from './enterprise/ee-client.js';
import {
  ModeEngine,
  OllamaAdapter,
  OpenAICompatibleAdapter,
  PROVIDER_PRESETS,
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
  const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.cwd();

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
  const provider = config.get<string>('model.provider', 'ollama');

  // Create the appropriate LLM adapter based on provider setting
  let llmAdapter: OllamaAdapter | OpenAICompatibleAdapter;
  if (provider === 'ollama') {
    llmAdapter = new OllamaAdapter({
      baseUrl: config.get<string>('ollama.baseUrl', 'http://127.0.0.1:11434'),
      chatModel: config.get<string>('model.chat', 'qwen2.5-coder:7b'),
      completionModel: config.get<string>('model.completion', 'qwen2.5-coder:1.5b'),
    });
  } else {
    // All non-Ollama providers use OpenAI-compatible protocol
    const presets = PROVIDER_PRESETS[provider] ?? PROVIDER_PRESETS['openai-compatible'];
    const providerSection = provider === 'openai-compatible' ? 'openaiCompatible' : provider;
    llmAdapter = new OpenAICompatibleAdapter({
      baseUrl: config.get<string>(`${providerSection}.baseUrl`, presets.baseUrl ?? ''),
      apiKey: config.get<string>(`${providerSection}.apiKey`, ''),
      chatModel: config.get<string>('model.chat', presets.chatModel ?? 'gpt-4o'),
      completionModel: config.get<string>(
        'model.completion',
        presets.completionModel ?? 'gpt-4o-mini',
      ),
      providerName: provider,
    });
  }

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
  const modelRouter = new ModelRouter(llmAdapter, {
    chat: config.get<string>('model.chat', 'qwen2.5-coder:7b'),
    completion: config.get<string>('model.completion', 'qwen2.5-coder:1.5b'),
    embedding: config.get<string>('model.embedding', 'nomic-embed-text'),
  });

  // Initialize Literate Coding (F18)
  const literateCoding = new LiterateCodingEngine();

  const toolRegistry = new ToolRegistry(modeEngine, {
    approvalCallback: async (tool, params) => {
      const serialized = JSON.stringify(params, null, 2);
      const preview = serialized.length > 600 ? `${serialized.slice(0, 600)}\n...` : serialized;
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
      edit: config.get<boolean>(
        'autoApprove.edit',
        config.get<boolean>('autoApprove.write', false),
      ),
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
    llmAdapter,
    toolRegistry,
    conversationManager,
    modeEngine,
    { workspaceRoot },
    redactionEngine,
    snapshotManager,
  );
  void agentLoop.loadCustomCommands();

  // Register Inline Completion Provider (F2)
  const inlineCompletionProvider = new InlineCompletionProvider(llmAdapter, redactionEngine);
  context.subscriptions.push(
    vscode.languages.registerInlineCompletionItemProvider(
      { pattern: '**' },
      inlineCompletionProvider,
    ),
    inlineCompletionProvider,
  );

  const chatProvider = new ChatPanelProvider(context.extensionUri, agentLoop, modeEngine);

  // Model type classifier — used to filter models into chat/completion vs embedding
  const EMBEDDING_PATTERNS = /embed|embedding|nomic-embed|mxbai-embed|text-embedding|bge-|e5-/i;
  const SKIP_PATTERNS = /whisper|tts|dall-e|image-gen|canary|rerank/i;
  function isEmbeddingModel(name: string): boolean {
    return EMBEDDING_PATTERNS.test(name);
  }
  function isChatModel(name: string): boolean {
    return !isEmbeddingModel(name) && !SKIP_PATTERNS.test(name);
  }

  /** Write discovered models into the extension's package.json enum fields so settings show dropdowns */
  async function updateModelEnums(allModels: string[]): Promise<void> {
    try {
      const extPath = context.extensionPath;
      const pkgPath = path.join(extPath, 'package.json');
      const raw = await require('fs').promises.readFile(pkgPath, 'utf-8');
      const pkg = JSON.parse(raw);

      const chatModels = allModels.filter((m) => isChatModel(m));
      const embeddingModels = allModels.filter((m) => isEmbeddingModel(m));

      // Navigate to configuration properties and set enums
      const configs: any[] = pkg.contributes?.configuration;
      if (!configs) return;

      for (const section of configs) {
        const props = section.properties;
        if (!props) continue;
        if (props['OpenCob.model.chat'] && chatModels.length > 0) {
          props['OpenCob.model.chat'].enum = chatModels;
        }
        if (props['OpenCob.model.completion'] && chatModels.length > 0) {
          props['OpenCob.model.completion'].enum = chatModels;
        }
        if (props['OpenCob.model.embedding'] && embeddingModels.length > 0) {
          props['OpenCob.model.embedding'].enum = embeddingModels;
        }
      }

      await require('fs').promises.writeFile(pkgPath, JSON.stringify(pkg, null, 2), 'utf-8');
    } catch {
      // Non-critical — settings will still work as text fields
    }
  }

  // Load persisted models from previous test connection so Chat dropdown is populated immediately
  const cachedModels = context.globalState.get<string[]>('cachedModels', []);
  if (cachedModels.length > 0) {
    chatProvider.setAvailableModels(cachedModels, llmAdapter.getChatModel());
    // Ensure settings dropdowns are populated from cache
    void updateModelEnums(cachedModels);
  } else {
    // No cached list yet — at minimum show the configured model name
    const currentChat = llmAdapter.getChatModel();
    if (currentChat) {
      chatProvider.setAvailableModels([currentChat], currentChat);
    }
  }

  // Auto-detect models from provider on startup
  (async () => {
    // Small delay to let webview resolve
    await new Promise((r) => setTimeout(r, 1000));
    chatProvider.setModel(llmAdapter.getChatModel());

    try {
      const reachable = await llmAdapter.isAvailable();
      if (!reachable) {
        statusBarItem.text = `$(warning) ${provider} offline`;
        statusBarItem.tooltip = `OpenCob: Cannot reach ${provider}. Click to test connection.`;
        statusBarItem.command = 'OpenCob.testConnection';
        chatProvider.setConnectionStatus(false, provider, 0);
        return;
      }

      const models = await llmAdapter.listModels();
      chatProvider.setConnectionStatus(true, provider, models.length);
      chatProvider.setAvailableModels(models, llmAdapter.getChatModel());

      // Persist for next reload
      await context.globalState.update('cachedModels', models);

      // Update package.json enum so settings show dropdowns
      await updateModelEnums(models);

      if (models.length === 0) return;

      const currentChat = llmAdapter.getChatModel();
      const currentCompletion = llmAdapter.getCompletionModel();

      // If user's configured model isn't available, prompt to pick one
      if (!models.includes(currentChat)) {
        const action = await vscode.window.showWarningMessage(
          `OpenCob: Chat model "${currentChat}" not found on ${provider} (${models.length} models available).`,
          'Pick a Model',
          'Dismiss',
        );
        if (action === 'Pick a Model') {
          const items = models.map((m) => ({ label: m }));
          const selected = await vscode.window.showQuickPick(items, {
            placeHolder: `Select chat model from ${provider}`,
          });
          if (selected) {
            llmAdapter.setChatModel(selected.label);
            statusBarItem.text = `$(hubot) ${selected.label}`;
            chatProvider.setModel(selected.label);
            // Persist the choice to settings
            await vscode.workspace
              .getConfiguration('OpenCob')
              .update('model.chat', selected.label, vscode.ConfigurationTarget.Global);
          }
        }
      }

      if (!models.includes(currentCompletion)) {
        const action = await vscode.window.showWarningMessage(
          `OpenCob: Completion model "${currentCompletion}" not found on ${provider}.`,
          'Pick a Model',
          'Dismiss',
        );
        if (action === 'Pick a Model') {
          const items = models.map((m) => ({ label: m }));
          const selected = await vscode.window.showQuickPick(items, {
            placeHolder: `Select completion model from ${provider}`,
          });
          if (selected) {
            llmAdapter.setCompletionModel(selected.label);
            await vscode.workspace
              .getConfiguration('OpenCob')
              .update('model.completion', selected.label, vscode.ConfigurationTarget.Global);
          }
        }
      }
    } catch {
      // Silent — don't block activation
    }
  })();

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

    // Model picker — Chat model (F9)
    vscode.commands.registerCommand('OpenCob.selectModel', async () => {
      const available = await llmAdapter.isAvailable();
      if (!available) {
        vscode.window.showErrorMessage(
          `OpenCob: ${provider === 'ollama' ? 'Ollama is not running. Start it with: ollama serve' : 'LLM provider is not reachable. Check your settings.'}`,
        );
        return;
      }
      const models = await llmAdapter.listModels();
      const chatModels = models.filter((m) => !isEmbeddingModel(m));
      const currentChat = llmAdapter.getChatModel();
      const items = chatModels.map((m) => ({
        label: m,
        description: m === currentChat ? '(current)' : '',
      }));
      const selected = await vscode.window.showQuickPick(items, {
        placeHolder: `Select chat model (${provider}) — current: ${currentChat}`,
        matchOnDescription: true,
      });
      if (selected) {
        llmAdapter.setChatModel(selected.label);
        statusBarItem.text = `$(hubot) ${selected.label}`;
        chatProvider.setModel(selected.label);
        await vscode.workspace
          .getConfiguration('OpenCob')
          .update('model.chat', selected.label, vscode.ConfigurationTarget.Global);
        vscode.window.showInformationMessage(`OpenCob: Chat model → ${selected.label}`);
      }
    }),

    // Model picker — Completion model
    vscode.commands.registerCommand('OpenCob.selectCompletionModel', async () => {
      const available = await llmAdapter.isAvailable();
      if (!available) {
        vscode.window.showErrorMessage(
          `OpenCob: ${provider === 'ollama' ? 'Ollama is not running. Start it with: ollama serve' : 'LLM provider is not reachable. Check your settings.'}`,
        );
        return;
      }
      const models = await llmAdapter.listModels();
      const completionModels = models.filter((m) => !isEmbeddingModel(m));
      const currentCompletion = llmAdapter.getCompletionModel();
      const items = completionModels.map((m) => ({
        label: m,
        description: m === currentCompletion ? '(current)' : '',
      }));
      const selected = await vscode.window.showQuickPick(items, {
        placeHolder: `Select completion model (${provider}) — current: ${currentCompletion}`,
        matchOnDescription: true,
      });
      if (selected) {
        llmAdapter.setCompletionModel(selected.label);
        await vscode.workspace
          .getConfiguration('OpenCob')
          .update('model.completion', selected.label, vscode.ConfigurationTarget.Global);
        vscode.window.showInformationMessage(`OpenCob: Completion model → ${selected.label}`);
      }
    }),

    // Model picker — Embedding model
    vscode.commands.registerCommand('OpenCob.selectEmbeddingModel', async () => {
      const available = await llmAdapter.isAvailable();
      if (!available) {
        vscode.window.showErrorMessage(
          `OpenCob: ${provider === 'ollama' ? 'Ollama is not running. Start it with: ollama serve' : 'LLM provider is not reachable. Check your settings.'}`,
        );
        return;
      }
      const models = await llmAdapter.listModels();
      const embeddingModels = models.filter((m) => isEmbeddingModel(m));
      const currentEmbedding = config.get<string>('model.embedding', 'nomic-embed-text');
      if (embeddingModels.length === 0) {
        vscode.window.showInformationMessage(
          `OpenCob: No embedding models found on ${provider}. All ${models.length} models appear to be chat/completion models.`,
        );
        return;
      }
      const items = embeddingModels.map((m) => ({
        label: m,
        description: m === currentEmbedding ? '(current)' : '',
      }));
      const selected = await vscode.window.showQuickPick(items, {
        placeHolder: `Select embedding model (${provider}) — current: ${currentEmbedding}`,
        matchOnDescription: true,
      });
      if (selected) {
        await vscode.workspace
          .getConfiguration('OpenCob')
          .update('model.embedding', selected.label, vscode.ConfigurationTarget.Global);
        vscode.window.showInformationMessage(`OpenCob: Embedding model → ${selected.label}`);
      }
    }),

    // Switch model from chat panel dropdown (no QuickPick, direct switch)
    vscode.commands.registerCommand('OpenCob.switchModelTo', (model: string) => {
      if (!model) return;
      llmAdapter.setChatModel(model);
      statusBarItem.text = `$(hubot) ${model}`;
      chatProvider.setModel(model);
    }),

    // Test connection to the configured provider
    vscode.commands.registerCommand('OpenCob.testConnection', async () => {
      const providerSection = provider === 'openai-compatible' ? 'openaiCompatible' : provider;
      const baseUrl =
        provider === 'ollama'
          ? config.get<string>('ollama.baseUrl', 'http://127.0.0.1:11434')
          : config.get<string>(`${providerSection}.baseUrl`, '');

      await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: `Testing connection to ${provider}...`,
          cancellable: false,
        },
        async () => {
          const start = Date.now();
          const reachable = await llmAdapter.isAvailable();
          const latency = Date.now() - start;

          if (!reachable) {
            chatProvider.setConnectionStatus(false, provider, 0);
            vscode.window
              .showErrorMessage(
                `OpenCob: ❌ Cannot reach ${provider} at ${baseUrl}\n\nCheck:\n• Is the server running?\n• Is the URL correct?\n• Is the API key valid?`,
                'Open Settings',
              )
              .then((action) => {
                if (action === 'Open Settings') {
                  vscode.commands.executeCommand(
                    'workbench.action.openSettings',
                    `OpenCob.${providerSection}`,
                  );
                }
              });
            return;
          }

          // Connection OK — now try listing models
          const models = await llmAdapter.listModels();
          chatProvider.setConnectionStatus(true, provider, models.length);
          chatProvider.setAvailableModels(models, llmAdapter.getChatModel());
          statusBarItem.text = `$(hubot) ${llmAdapter.getChatModel()}`;
          statusBarItem.command = 'OpenCob.selectModel';

          // Persist and update settings dropdowns
          await context.globalState.update('cachedModels', models);
          await updateModelEnums(models);

          const chatModel = llmAdapter.getChatModel();
          const completionModel = llmAdapter.getCompletionModel();

          const chatAvailable = models.includes(chatModel);
          const completionAvailable = models.includes(completionModel);

          let message = `✅ Connected to **${provider}** (${latency}ms)\n`;
          message += `\n📡 Endpoint: ${baseUrl}`;
          message += `\n📦 Models available: ${models.length}`;
          message += `\n💬 Chat model: ${chatModel} ${chatAvailable ? '✅' : '⚠️ not found'}`;
          message += `\n⚡ Completion model: ${completionModel} ${completionAvailable ? '✅' : '⚠️ not found'}`;

          if (!chatAvailable || !completionAvailable) {
            const action = await vscode.window.showWarningMessage(
              `OpenCob: Connected to ${provider} (${models.length} models, ${latency}ms) but some configured models not found.`,
              'Select Chat Model',
              'Select Completion Model',
              'Show All Models',
            );
            if (action === 'Select Chat Model') {
              vscode.commands.executeCommand('OpenCob.selectModel');
            } else if (action === 'Select Completion Model') {
              vscode.commands.executeCommand('OpenCob.selectCompletionModel');
            } else if (action === 'Show All Models') {
              const modelList = models.join('\n');
              const doc = await vscode.workspace.openTextDocument({
                content: `# Available models on ${provider}\n# Endpoint: ${baseUrl}\n# Total: ${models.length}\n\n${modelList}`,
                language: 'markdown',
              });
              vscode.window.showTextDocument(doc, { preview: true });
            }
          } else {
            vscode.window.showInformationMessage(
              `OpenCob: ✅ ${provider} connected (${models.length} models, ${latency}ms) — chat: ${chatModel}, completion: ${completionModel}`,
            );
          }
        },
      );
    }),

    // Open VS Code settings filtered to OpenCob
    vscode.commands.registerCommand('OpenCob.openSettings', () => {
      vscode.commands.executeCommand('workbench.action.openSettings', 'OpenCob');
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
          editor.revealRange(
            new vscode.Range(line, 0, line, 0),
            vscode.TextEditorRevealType.InCenter,
          );
        }),

        // Toggle findings view mode
        vscode.commands.registerCommand('OpenCob.toggleFindingsMode', async () => {
          const result = await vscode.window.showQuickPick(
            [
              {
                label: 'Group by File',
                description: 'Organize findings by source file',
                mode: 'file',
              },
              {
                label: 'Group by Severity',
                description: 'Organize findings by severity level',
                mode: 'severity',
              },
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
          const findings: Finding[] = allFindings.map((f) => ({
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
      setTimeout(() => {
        indexStatusBar.hide();
      }, 5000);
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
        vscode.window.showInformationMessage(
          'OpenCob: No literate coding blocks found (use // @OpenCob: <instruction>)',
        );
        return;
      }

      vscode.window.showInformationMessage(
        `OpenCob: Found ${blocks.length} literate block(s) — generating code...`,
      );
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
        await vscode.workspace
          .getConfiguration('OpenCob')
          .update('enterprise.serverUrl', serverUrl, vscode.ConfigurationTarget.Global);
        await vscode.workspace
          .getConfiguration('OpenCob')
          .update(
            'enterprise.token',
            state.user ? eeClient['token'] : '',
            vscode.ConfigurationTarget.Global,
          );

        const caps = state.capabilities?.capabilities;
        const capList = caps
          ? Object.entries(caps)
              .map(([k, v]) => `${k}: ${(v as string[]).join(', ')}`)
              .join('\n')
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
      await vscode.workspace
        .getConfiguration('OpenCob')
        .update('enterprise.token', '', vscode.ConfigurationTarget.Global);
      vscode.window.showInformationMessage('OpenCob: Disconnected from Enterprise server');
    }),
  );

  const statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
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
