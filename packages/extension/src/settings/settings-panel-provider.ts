import * as vscode from 'vscode';

export interface LLMAdapterLike {
  isAvailable(): Promise<boolean>;
  listModels(): Promise<string[]>;
  getChatModel(): string;
  getCompletionModel(): string;
  setChatModel(model: string): void;
  setCompletionModel(model: string): void;
}

/**
 * Settings webview panel — connection test + model selection dropdowns.
 * User picks default chat & completion models here after verifying connectivity.
 */
export class SettingsPanelProvider implements vscode.WebviewViewProvider {
  private view?: vscode.WebviewView;
  private cachedModels: string[] = [];
  private onModelsLoaded?: (models: string[]) => void;

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly llmAdapter: LLMAdapterLike,
    private readonly provider: string,
    private readonly globalState: vscode.Memento,
  ) {}

  /** Register a callback that fires when models are loaded after connection test */
  setOnModelsLoaded(cb: (models: string[]) => void): void {
    this.onModelsLoaded = cb;
  }

  getCachedModels(): string[] {
    return this.cachedModels;
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
        case 'testConnection':
          await this.handleTestConnection();
          break;
        case 'setChatModel':
          await this.handleSetChatModel(message.model);
          break;
        case 'setCompletionModel':
          await this.handleSetCompletionModel(message.model);
          break;
        case 'openProviderSettings':
          vscode.commands.executeCommand('workbench.action.openSettings', 'OpenCob.model.provider');
          break;
      }
    });
  }

  private async handleTestConnection(): Promise<void> {
    this.view?.webview.postMessage({ type: 'testingConnection' });

    try {
      const start = Date.now();
      const reachable = await this.llmAdapter.isAvailable();
      const latency = Date.now() - start;

      if (!reachable) {
        this.view?.webview.postMessage({
          type: 'connectionResult',
          connected: false,
          provider: this.provider,
          latency,
          models: [],
          error: `Cannot reach ${this.provider}. Check that the server is running and URL is correct.`,
        });
        return;
      }

      const models = await this.llmAdapter.listModels();
      this.cachedModels = models;

      // Persist discovered models so Chat panel can load them on next startup
      await this.globalState.update('cachedModels', models);

      this.view?.webview.postMessage({
        type: 'connectionResult',
        connected: true,
        provider: this.provider,
        latency,
        models,
        currentChat: this.llmAdapter.getChatModel(),
        currentCompletion: this.llmAdapter.getCompletionModel(),
      });

      // Notify listeners (e.g. chat panel) that models are available
      this.onModelsLoaded?.(models);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.view?.webview.postMessage({
        type: 'connectionResult',
        connected: false,
        provider: this.provider,
        latency: 0,
        models: [],
        error: msg,
      });
    }
  }

  private async handleSetChatModel(model: string): Promise<void> {
    this.llmAdapter.setChatModel(model);
    await vscode.workspace
      .getConfiguration('OpenCob')
      .update('model.chat', model, vscode.ConfigurationTarget.Global);
    vscode.window.showInformationMessage(`OpenCob: Default chat model → ${model}`);
    // Notify chat panel
    this.onModelsLoaded?.(this.cachedModels);
  }

  private async handleSetCompletionModel(model: string): Promise<void> {
    this.llmAdapter.setCompletionModel(model);
    await vscode.workspace
      .getConfiguration('OpenCob')
      .update('model.completion', model, vscode.ConfigurationTarget.Global);
    vscode.window.showInformationMessage(`OpenCob: Default completion model → ${model}`);
  }

  private getHtml(): string {
    return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>OpenCob Settings</title>
  <style>
    * { box-sizing: border-box; }
    body { font-family: var(--vscode-font-family); font-size: var(--vscode-font-size); padding: 12px; margin: 0; color: var(--vscode-foreground); background: var(--vscode-sideBar-background); }
    h2 { font-size: 1.1em; margin: 0 0 12px; font-weight: 600; }
    .section { margin-bottom: 16px; padding: 10px; border-radius: 6px; background: var(--vscode-editor-background); border: 1px solid var(--vscode-panel-border); }
    .section h3 { font-size: 0.95em; margin: 0 0 8px; font-weight: 500; color: var(--vscode-descriptionForeground); }
    .provider-info { display: flex; align-items: center; gap: 8px; margin-bottom: 10px; font-size: 0.9em; }
    .provider-badge { background: var(--vscode-badge-background); color: var(--vscode-badge-foreground); padding: 2px 8px; border-radius: 10px; font-size: 0.85em; font-weight: 500; }
    .change-link { color: var(--vscode-textLink-foreground); cursor: pointer; font-size: 0.85em; text-decoration: none; }
    .change-link:hover { text-decoration: underline; }

    .btn { padding: 3px 10px; border: none; border-radius: 3px; cursor: pointer; font-size: 0.85em; font-family: inherit; display: inline-flex; align-items: center; gap: 4px; }
    .btn-primary { background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
    .btn-primary:hover { background: var(--vscode-button-hoverBackground); }
    .btn-primary:disabled { opacity: 0.5; cursor: not-allowed; }

    .status { margin-top: 8px; padding: 8px; border-radius: 4px; font-size: 0.9em; display: none; }
    .status.visible { display: block; }
    .status.success { background: rgba(74, 222, 128, 0.1); border: 1px solid var(--vscode-charts-green); color: var(--vscode-charts-green); }
    .status.error { background: rgba(248, 113, 113, 0.1); border: 1px solid var(--vscode-errorForeground); color: var(--vscode-errorForeground); }
    .status.testing { background: rgba(96, 165, 250, 0.1); border: 1px solid var(--vscode-textLink-foreground); color: var(--vscode-textLink-foreground); }

    .model-section { display: none; margin-top: 12px; }
    .model-section.visible { display: block; }
    .model-group { margin-bottom: 12px; }
    .model-group label { display: block; font-size: 0.85em; color: var(--vscode-descriptionForeground); margin-bottom: 4px; font-weight: 500; }
    select { width: 100%; padding: 6px 8px; border: 1px solid var(--vscode-input-border); background: var(--vscode-input-background); color: var(--vscode-input-foreground); border-radius: 4px; font-family: inherit; font-size: inherit; }
    select:focus { outline: 1px solid var(--vscode-focusBorder); }

    .model-count { font-size: 0.8em; color: var(--vscode-descriptionForeground); margin-top: 4px; }
    .latency { font-size: 0.8em; color: var(--vscode-descriptionForeground); }
  </style>
</head>
<body>
  <h2>Settings</h2>

  <div class="section">
    <h3>Provider Connection</h3>
    <div class="provider-info">
      <span>Provider:</span>
      <span class="provider-badge" id="provider-name">${this.provider}</span>
      <a class="change-link" id="change-provider">Change</a>
    </div>
    <button class="btn btn-primary" id="test-btn">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7Z"/><circle cx="12" cy="12" r="3"/></svg>
      Test Connection
    </button>
    <div class="status" id="conn-status"></div>
  </div>

  <div class="section model-section" id="model-section">
    <h3>Default Models</h3>
    <p class="model-count" id="model-count"></p>

    <div class="model-group">
      <label for="chat-model">Chat Model (agentic coding, Q&A)</label>
      <select id="chat-model"><option value="">— test connection first —</option></select>
    </div>

    <div class="model-group">
      <label for="completion-model">Completion Model (inline / ghost text)</label>
      <select id="completion-model"><option value="">— test connection first —</option></select>
    </div>
  </div>

  <script>
    const vscode = acquireVsCodeApi();
    const testBtn = document.getElementById('test-btn');
    const statusEl = document.getElementById('conn-status');
    const modelSection = document.getElementById('model-section');
    const chatModelSelect = document.getElementById('chat-model');
    const completionModelSelect = document.getElementById('completion-model');
    const modelCountEl = document.getElementById('model-count');
    const changeProviderLink = document.getElementById('change-provider');

    changeProviderLink.addEventListener('click', () => {
      vscode.postMessage({ type: 'openProviderSettings' });
    });

    testBtn.addEventListener('click', () => {
      vscode.postMessage({ type: 'testConnection' });
    });

    chatModelSelect.addEventListener('change', () => {
      const model = chatModelSelect.value;
      if (model) {
        vscode.postMessage({ type: 'setChatModel', model });
      }
    });

    completionModelSelect.addEventListener('change', () => {
      const model = completionModelSelect.value;
      if (model) {
        vscode.postMessage({ type: 'setCompletionModel', model });
      }
    });

    window.addEventListener('message', (e) => {
      const msg = e.data;

      switch (msg.type) {
        case 'testingConnection':
          testBtn.disabled = true;
          testBtn.textContent = 'Testing...';
          statusEl.className = 'status visible testing';
          statusEl.textContent = 'Connecting to provider...';
          modelSection.classList.remove('visible');
          break;

        case 'connectionResult':
          testBtn.disabled = false;
          testBtn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7Z"/><circle cx="12" cy="12" r="3"/></svg> Test Connection';

          if (msg.connected) {
            statusEl.className = 'status visible success';
            statusEl.innerHTML = '✅ Connected to <strong>' + msg.provider + '</strong> <span class="latency">(' + msg.latency + 'ms)</span>';

            // Populate model dropdowns
            populateModels(msg.models, msg.currentChat, msg.currentCompletion);
            modelSection.classList.add('visible');
            modelCountEl.textContent = msg.models.length + ' models available';
          } else {
            statusEl.className = 'status visible error';
            statusEl.textContent = '❌ ' + (msg.error || 'Connection failed');
            modelSection.classList.remove('visible');
          }
          break;
      }
    });

    function populateModels(models, currentChat, currentCompletion) {
      chatModelSelect.innerHTML = '';
      completionModelSelect.innerHTML = '';

      models.forEach(m => {
        const opt1 = document.createElement('option');
        opt1.value = m;
        opt1.textContent = m;
        if (m === currentChat) opt1.selected = true;
        chatModelSelect.appendChild(opt1);

        const opt2 = document.createElement('option');
        opt2.value = m;
        opt2.textContent = m;
        if (m === currentCompletion) opt2.selected = true;
        completionModelSelect.appendChild(opt2);
      });
    }
  </script>
</body>
</html>`;
  }
}
