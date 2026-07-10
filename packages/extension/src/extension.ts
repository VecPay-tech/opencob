import * as vscode from 'vscode';
import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import { ChatPanelProvider } from './chat/chat-panel-provider.js';
import { InlineCompletionProvider } from './completion/inline-completion-provider.js';
import { FindingsProvider, type Finding } from './findings/findings-provider.js';
import { ActivityPanelProvider } from './activity/activity-panel-provider.js';
import { InlineEditProvider } from './inline-edit/inline-edit-provider.js';
import { QuickChatProvider } from './chat/quick-chat-provider.js';
import { EditsPanelProvider } from './edits/edits-panel-provider.js';
import { SettingsPanelProvider } from './settings/settings-panel-provider.js';
import { registerChatParticipant } from './chat/chat-participant.js';

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
  generateDiagramFromContent,
  classifyExtension,
  getAvailableDiagramTypes,
} from '@opencob/core';

function computeWorkspaceRoot(): string {
  const folders = vscode.workspace.workspaceFolders;
  if (!folders || folders.length === 0) {
    return process.cwd();
  }

  const paths = folders.map((folder) => path.resolve(folder.uri.fsPath));
  const root = path.parse(paths[0]).root;
  if (!paths.every((p) => path.parse(p).root === root)) {
    return paths[0];
  }

  const splitPaths = paths.map((p) => p.slice(root.length).split(path.sep).filter(Boolean));

  let commonLength = splitPaths[0].length;
  for (const parts of splitPaths.slice(1)) {
    let idx = 0;
    while (idx < commonLength && idx < parts.length && parts[idx] === splitPaths[0][idx]) {
      idx++;
    }
    commonLength = idx;
  }

  if (commonLength === 0) {
    return paths[0];
  }

  const commonParts = splitPaths[0].slice(0, commonLength);
  return path.join(root, ...commonParts);
}

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const workspaceRoot = computeWorkspaceRoot();

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
          groups: cm.groups as unknown as Parameters<typeof modeEngine.registerMode>[0]['groups'],
          customInstructions: cm.customInstructions,
        });
      }
    }
  });

  // Initialize core components
  const modeEngine = new ModeEngine();
  let config = vscode.workspace.getConfiguration('OpenCob');
  let provider = config.get<string>('model.provider', 'ollama');

  const providerSectionFor = (prov: string): string =>
    prov === 'openai-compatible' ? 'openaiCompatible' : prov;
  const apiKeySecretIdFor = (prov: string): string | null => {
    const section = providerSectionFor(prov);
    const supportedSections = new Set([
      'litellm',
      'openai',
      'azure',
      'anthropic',
      'gemini',
      'openaiCompatible',
    ]);
    if (!supportedSections.has(section)) return null;
    return `opencob.${section}.apiKey`;
  };

  const migrateLegacySecretSetting = async (
    settingKey: string,
    secretId: string,
  ): Promise<void> => {
    const settingValue = vscode.workspace.getConfiguration('OpenCob').get<string>(settingKey, '');
    const legacyValue = settingValue.trim();
    if (!legacyValue) return;

    const existingSecret = await context.secrets.get(secretId);
    if (!existingSecret) {
      await context.secrets.store(secretId, legacyValue);
    }

    await vscode.workspace
      .getConfiguration('OpenCob')
      .update(settingKey, '', vscode.ConfigurationTarget.Global);
  };

  const migrateLegacySecrets = async (): Promise<void> => {
    const providers = ['litellm', 'openai', 'azure', 'anthropic', 'gemini', 'openai-compatible'];
    for (const prov of providers) {
      const section = providerSectionFor(prov);
      const secretId = apiKeySecretIdFor(prov);
      if (!secretId) continue;
      await migrateLegacySecretSetting(`${section}.apiKey`, secretId);
    }
    await migrateLegacySecretSetting('enterprise.token', 'opencob.enterprise.token');
  };

  const getProviderApiKey = async (prov: string): Promise<string> => {
    const secretId = apiKeySecretIdFor(prov);
    if (!secretId) return '';

    const fromSecret = await context.secrets.get(secretId);
    if (fromSecret && fromSecret.trim().length > 0) return fromSecret;

    const section = providerSectionFor(prov);
    const fromSettings = vscode.workspace
      .getConfiguration('OpenCob')
      .get<string>(`${section}.apiKey`, '')
      .trim();
    if (fromSettings) {
      await context.secrets.store(secretId, fromSettings);
      await vscode.workspace
        .getConfiguration('OpenCob')
        .update(`${section}.apiKey`, '', vscode.ConfigurationTarget.Global);
      return fromSettings;
    }

    return '';
  };

  await migrateLegacySecrets();

  const statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  statusBarItem.text = `$(hubot) ${config.get<string>('model.chat', 'qwen2.5-coder:7b')}`;
  statusBarItem.tooltip = 'OpenCob — Click to switch model';
  statusBarItem.command = 'OpenCob.selectModel';
  statusBarItem.show();
  context.subscriptions.push(statusBarItem);

  // Helper to create the appropriate LLM adapter based on provider setting
  async function createLlmAdapterFromConfig(): Promise<OllamaAdapter | OpenAICompatibleAdapter> {
    const cfg = vscode.workspace.getConfiguration('OpenCob');
    const prov = cfg.get<string>('model.provider', 'ollama');
    if (prov === 'ollama') {
      return new OllamaAdapter({
        baseUrl: cfg.get<string>('ollama.baseUrl', 'http://127.0.0.1:11434'),
        chatModel: cfg.get<string>('model.chat', 'qwen2.5-coder:7b'),
        completionModel: cfg.get<string>('model.completion', 'qwen2.5-coder:1.5b'),
      });
    }
    const presets = PROVIDER_PRESETS[prov] ?? PROVIDER_PRESETS['openai-compatible'];
    const providerSection = prov === 'openai-compatible' ? 'openaiCompatible' : prov;
    const apiKey = await getProviderApiKey(prov);
    return new OpenAICompatibleAdapter({
      baseUrl: cfg.get<string>(`${providerSection}.baseUrl`, presets.baseUrl ?? ''),
      apiKey,
      chatModel: cfg.get<string>('model.chat', presets.chatModel ?? 'gpt-4o'),
      completionModel: cfg.get<string>(
        'model.completion',
        presets.completionModel ?? 'gpt-4o-mini',
      ),
      providerName: prov,
    });
  }

  // Create the appropriate LLM adapter based on provider setting
  let llmAdapter = await createLlmAdapterFromConfig();

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

  // Initialize Findings Provider for TreeView (legacy, kept for scanner)
  const findingsProvider = new FindingsProvider(context);
  context.subscriptions.push(
    vscode.window.registerTreeDataProvider('OpenCob.findings', findingsProvider),
  );

  // Initialize Activity & Insights Panel (modern replacement for Findings tab)
  const activityProvider = new ActivityPanelProvider(context.extensionUri);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider('OpenCob.activity', activityProvider),
  );

  // Initialize Model Router (F9)
  const _modelRouter = new ModelRouter(llmAdapter, {
    chat: config.get<string>('model.chat', 'qwen2.5-coder:7b'),
    completion: config.get<string>('model.completion', 'qwen2.5-coder:1.5b'),
    embedding: config.get<string>('model.embedding', 'nomic-embed-text'),
  });

  // Initialize Literate Coding (F18)
  const literateCoding = new LiterateCodingEngine();

  let requestToolApproval: (
    toolName: string,
    group: string,
    params: unknown,
  ) => Promise<boolean> = async () => true;

  const toolRegistry: ToolRegistry = new ToolRegistry(modeEngine, {
    approvalCallback: async (tool, params): Promise<boolean> => {
      // chatProvider is created later; this indirection avoids circular init inference.
      return requestToolApproval(tool.name, tool.group, params);
    },
    fileFilter: fileFilter.getFilterFn(),
    autoApprove: {
      read: config.get<boolean>('autoApprove.read', true),
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

  // Register VS Code Chat Participant (@opencob in built-in chat)
  context.subscriptions.push(registerChatParticipant(context, agentLoop));

  // Register Inline Completion Provider (F2)
  const inlineCompletionProvider = new InlineCompletionProvider(llmAdapter, redactionEngine);
  let inlineCompletionDisposable = vscode.languages.registerInlineCompletionItemProvider(
    { pattern: '**' },
    inlineCompletionProvider,
  );
  let inlineCompletionEnabled = true;
  context.subscriptions.push(inlineCompletionDisposable, inlineCompletionProvider);

  // Register Inline Edit Provider (§8.4.2)
  const inlineEditProvider = new InlineEditProvider(agentLoop, redactionEngine);
  context.subscriptions.push(inlineEditProvider);

  const chatProvider = new ChatPanelProvider(
    context.extensionUri,
    agentLoop,
    modeEngine,
    conversationManager,
  );
  chatProvider.setToolRegistry(toolRegistry);
  requestToolApproval = (toolName, group, params) =>
    chatProvider.requestToolApproval(toolName, group, params);
  chatProvider.onActivity(
    (entry: { type: string; title: string; detail?: string; file?: string }) => {
      activityProvider.addActivity(entry as any);
    },
  );

  // Register Quick Chat provider (§8.4.5)
  const quickChatProvider = new QuickChatProvider(context.extensionUri, agentLoop, redactionEngine);
  context.subscriptions.push(quickChatProvider);

  // Register Edits Panel provider (§8.4.3)
  const editsPanelProvider = new EditsPanelProvider(context.extensionUri, workspaceRoot);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider('OpenCob.editsPanel', editsPanelProvider),
  );

  // Register Settings panel provider
  const settingsPanelProvider = new SettingsPanelProvider(
    context.extensionUri,
    {
      isAvailable: () => llmAdapter.isAvailable(),
      listModels: () => llmAdapter.listModels(),
      getChatModel: () => llmAdapter.getChatModel(),
      getCompletionModel: () => llmAdapter.getCompletionModel(),
      setChatModel: (model: string) => llmAdapter.setChatModel(model),
      setCompletionModel: (model: string) => llmAdapter.setCompletionModel(model),
    },
    provider,
    context.globalState,
  );
  settingsPanelProvider.setOnModelsLoaded((models) => {
    chatProvider.setAvailableModels(models, llmAdapter.getChatModel());
  });
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider('OpenCob.settingsPanel', settingsPanelProvider),
  );

  function syncFindingsToTree(): void {
    const allFindings = findingsScanner.getAllFindings();
    const findings: Finding[] = allFindings.map((f) => ({
      id: f.id,
      file: f.filePath,
      line: f.line ?? 1,
      severity: f.severity as 'error' | 'warning' | 'info',
      type: f.category,
      message: f.message,
      timestamp: Date.now(),
    }));
    findingsProvider.clear();
    findingsProvider.addFindings(findings);
  }

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
      const raw = await fs.readFile(pkgPath, 'utf-8');
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

      await fs.writeFile(pkgPath, JSON.stringify(pkg, null, 2), 'utf-8');
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
      syncFindingsToTree();
      const counts = findingsScanner.getCounts();
      vscode.window.showInformationMessage(
        `OpenCob Scan: ${counts.error} errors, ${counts.warning} warnings, ${counts.info} info (${counts.total} total)`,
      );
      if (findings.length > 0) {
        vscode.commands.executeCommand('OpenCob.showFindings');
      }
    }),

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

    // Show findings in the findings tree
    vscode.commands.registerCommand('OpenCob.showFindings', () => {
      syncFindingsToTree();
      vscode.commands.executeCommand('OpenCob.findings.focus');
      const counts = findingsProvider.getCount();
      vscode.window.showInformationMessage(
        `OpenCob: ${counts.errors} errors, ${counts.warnings} warnings, ${counts.infos} info (${counts.total} total)`,
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

      // Track edit in activity panel
      activityProvider.addActivity({
        type: 'file_edit',
        title: `File saved: ${relPath}`,
        file: relPath,
      });

      // Update workspace stats with recent edits
      const status = workspaceIndexer.getStatus();
      activityProvider.updateStats({
        totalFiles: status.totalFiles,
        indexedFiles: status.indexedFiles,
        recentEdits: [relPath],
      });

      // Keep findings current on file save
      syncFindingsToTree();
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

    // Feed workspace stats to activity panel
    const idxStatus = workspaceIndexer.getStatus();
    const langMap: Record<string, number> = {};
    for (const chunk of workspaceIndexer.getAllChunks()) {
      const ext = (chunk.filePath || '').split('.').pop() || 'other';
      langMap[ext] = (langMap[ext] || 0) + 1;
    }
    activityProvider.updateStats({
      totalFiles: idxStatus.totalFiles,
      indexedFiles: idxStatus.indexedFiles,
      languages: langMap,
    });

    // Initial background findings scan after indexing (F7 AC-F7.1)
    findingsScanner.scanWorkspace();
    syncFindingsToTree();
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

  // Generate Diagram command (F4.4) — direct invocation from active file
  context.subscriptions.push(
    vscode.commands.registerCommand('OpenCob.generateDiagram', async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) {
        vscode.window.showWarningMessage('OpenCob: No active editor — open a source file first.');
        return;
      }

      const doc = editor.document;
      const filePath = doc.uri.fsPath;
      const ext = path.extname(filePath).slice(1).toLowerCase();
      const info = classifyExtension(ext);

      if (!info) {
        vscode.window.showWarningMessage(
          `OpenCob: Unsupported file type ".${ext}" for diagram generation.`,
        );
        return;
      }

      const available = getAvailableDiagramTypes(ext);
      if (available.length === 0) {
        vscode.window.showWarningMessage(
          `OpenCob: No diagram types available for ".${ext}" files.`,
        );
        return;
      }

      const items = available.map((t) => ({
        label: t,
        description: getDiagramDescription(t),
      }));

      const selected = await vscode.window.showQuickPick(items, {
        placeHolder: `Select diagram type for ${path.basename(filePath)} (${info.category})`,
      });
      if (!selected) return;

      const content = doc.getText();
      const result = generateDiagramFromContent(content, ext, selected.label as any);

      if (!result.success) {
        vscode.window.showErrorMessage(`OpenCob Diagram: ${result.content}`);
        return;
      }

      // Show the diagram output in a new editor tab
      const outputDoc = await vscode.workspace.openTextDocument({
        content: result.content,
        language: result.metadata?.format === 'ascii' ? 'text' : 'markdown',
      });
      await vscode.window.showTextDocument(outputDoc, {
        viewColumn: vscode.ViewColumn.Beside,
        preview: true,
      });
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
  const eeToken =
    (await context.secrets.get('opencob.enterprise.token')) ||
    config.get<string>('enterprise.token', '');
  if (config.get<string>('enterprise.token', '').trim()) {
    await vscode.workspace
      .getConfiguration('OpenCob')
      .update('enterprise.token', '', vscode.ConfigurationTarget.Global);
  }
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
        const token = state.user ? (eeClient.getToken() ?? '') : '';
        if (token) {
          await context.secrets.store('opencob.enterprise.token', token);
        }
        await vscode.workspace
          .getConfiguration('OpenCob')
          .update('enterprise.token', '', vscode.ConfigurationTarget.Global);

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
      await context.secrets.delete('opencob.enterprise.token');
      await vscode.workspace
        .getConfiguration('OpenCob')
        .update('enterprise.token', '', vscode.ConfigurationTarget.Global);
      vscode.window.showInformationMessage('OpenCob: Disconnected from Enterprise server');
    }),
  );

  // Listen for provider/connection settings changes and hot-swap the adapter
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      const settingsTouched =
        e.affectsConfiguration('OpenCob.model.provider') ||
        e.affectsConfiguration('OpenCob.ollama') ||
        e.affectsConfiguration('OpenCob.litellm') ||
        e.affectsConfiguration('OpenCob.openai') ||
        e.affectsConfiguration('OpenCob.azure') ||
        e.affectsConfiguration('OpenCob.anthropic') ||
        e.affectsConfiguration('OpenCob.gemini') ||
        e.affectsConfiguration('OpenCob.openaiCompatible');

      if (!settingsTouched) {
        return;
      }

      void (async () => {
        await migrateLegacySecrets();
        config = vscode.workspace.getConfiguration('OpenCob');
        provider = config.get<string>('model.provider', 'ollama');
        llmAdapter = await createLlmAdapterFromConfig();
        agentLoop.setLlmAdapter(llmAdapter);
        statusBarItem.text = `$(hubot) ${llmAdapter.getChatModel()}`;
        chatProvider.setModel(llmAdapter.getChatModel());
        chatProvider.setConnectionStatus(false, provider, 0);
        vscode.window.showInformationMessage(
          `OpenCob: Switched to ${provider}. Testing connection...`,
        );
        // Auto-test the new provider
        vscode.commands.executeCommand('OpenCob.testConnection');
      })();
    }),
  );

  // Mode indicator in status bar
  const modeStatusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 99);
  const activeMode = modeEngine.getActive();
  modeStatusBar.text = `$(symbol-event) ${activeMode.name}`;
  modeStatusBar.tooltip = 'OpenCob Mode — Click to cycle (Ctrl+.)';
  modeStatusBar.command = 'OpenCob.cycleMode';
  modeStatusBar.show();
  context.subscriptions.push(modeStatusBar);

  // Command: Cycle Mode
  context.subscriptions.push(
    vscode.commands.registerCommand('OpenCob.cycleMode', () => {
      const modes = modeEngine.listModes();
      const current = modeEngine.getActive();
      const idx = modes.findIndex((m) => m.slug === current.slug);
      const next = modes[(idx + 1) % modes.length];
      modeEngine.setActive(next.slug);
      modeStatusBar.text = `$(symbol-event) ${next.name}`;
      chatProvider.setMode(next.slug);
    }),
  );

  // Command: Toggle Inline Completion (§7)
  context.subscriptions.push(
    vscode.commands.registerCommand('OpenCob.toggleInlineCompletion', () => {
      if (inlineCompletionEnabled) {
        inlineCompletionDisposable.dispose();
        inlineCompletionEnabled = false;
        vscode.window.showInformationMessage('OpenCob: Inline completion disabled.');
      } else {
        inlineCompletionDisposable = vscode.languages.registerInlineCompletionItemProvider(
          { pattern: '**' },
          inlineCompletionProvider,
        );
        context.subscriptions.push(inlineCompletionDisposable);
        inlineCompletionEnabled = true;
        vscode.window.showInformationMessage('OpenCob: Inline completion enabled.');
      }
    }),
  );

  // Command: Inline Edit — Cmd+I (§8.4.2)
  context.subscriptions.push(
    vscode.commands.registerCommand('OpenCob.inlineEdit', () => {
      inlineEditProvider.triggerInlineEdit();
    }),
    vscode.commands.registerCommand('OpenCob.inlineEditAccept', () => {
      inlineEditProvider.acceptEdit();
    }),
    vscode.commands.registerCommand('OpenCob.inlineEditDiscard', () => {
      inlineEditProvider.discardEdit();
    }),
  );

  // Command: Quick Chat — Cmd+Shift+I (§8.4.5)
  context.subscriptions.push(
    vscode.commands.registerCommand('OpenCob.quickChat', () => {
      quickChatProvider.show();
    }),
  );

  // Command: Toggle Panel — Ctrl+Alt+I (§8.4.7)
  context.subscriptions.push(
    vscode.commands.registerCommand('OpenCob.togglePanel', () => {
      vscode.commands.executeCommand('OpenCob.chatPanel.focus');
    }),
  );

  // Disconnect MCP servers on deactivation
  context.subscriptions.push({
    dispose: () => mcpClient.disconnectAll(),
  });

  console.log('OpenCob CE activated');
}

/** Map diagram type slugs to human-readable descriptions for the QuickPick UI. */
function getDiagramDescription(type: string): string {
  const descriptions: Record<string, string> = {
    call_graph: 'External CALL/LINK/XCTL targets',
    dependency_map: 'COPY/INCLUDE/file references',
    structure_chart: 'Program structure (divisions/sections/paragraphs)',
    procedure_flow: 'Paragraph/procedure execution sequence',
    control_flow: 'IF/ELSE/EVALUATE/PERFORM flow graph',
    field_hierarchy: 'Data item hierarchy (level numbers)',
    file_io: 'File SELECT/ASSIGN/OPEN/CLOSE mapping',
    copybook_tree: 'Copybook dependency tree',
    record_layout: 'Record formats with field types',
    screen_layout: 'Terminal screen rendering (ASCII art)',
    'call-graph': 'Function call graph',
    dependency: 'Import/require graph',
    structure: 'File/folder structure',
    class: 'Class hierarchy (extends/implements)',
  };
  return descriptions[type] ?? '';
}

export function deactivate(): void {
  // cleanup
}
