import * as vscode from 'vscode';

/**
 * Edits Panel Provider (§8.4.3 of DESIGN.md)
 *
 * Shows multi-file edit proposals with per-file diffs.
 * Changes are NOT written to disk until explicitly applied.
 */

export interface FileEdit {
  file: string;
  status: 'M' | 'A' | 'D' | 'R';
  diff: string;
  linesAdded: number;
  linesRemoved: number;
  newContent?: string;
  originalContent?: string;
}

export class EditsPanelProvider implements vscode.WebviewViewProvider {
  private view: vscode.WebviewView | null = null;
  private pendingEdits: FileEdit[] = [];
  private workspaceRoot: string;

  constructor(
    private readonly extensionUri: vscode.Uri,
    workspaceRoot: string,
  ) {
    this.workspaceRoot = workspaceRoot;
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
        case 'applyAll':
          await this.applyAllEdits();
          break;
        case 'applyFile':
          await this.applyFileEdit(message.file);
          break;
        case 'discardAll':
          this.discardAll();
          break;
        case 'discardFile':
          this.discardFileEdit(message.file);
          break;
        case 'viewDiff':
          await this.showFileDiff(message.file);
          break;
      }
    });
  }

  /**
   * Set proposed edits from the agent (called by chat panel when in Edit mode).
   */
  setProposedEdits(edits: FileEdit[]): void {
    this.pendingEdits = edits;
    this.updateView();
  }

  /**
   * Add a single proposed edit.
   */
  addProposedEdit(edit: FileEdit): void {
    const existing = this.pendingEdits.findIndex((e) => e.file === edit.file);
    if (existing >= 0) {
      this.pendingEdits[existing] = edit;
    } else {
      this.pendingEdits.push(edit);
    }
    this.updateView();
  }

  /**
   * Get summary stats.
   */
  getSummary(): { filesChanged: number; linesAdded: number; linesRemoved: number } {
    return {
      filesChanged: this.pendingEdits.length,
      linesAdded: this.pendingEdits.reduce((sum, e) => sum + e.linesAdded, 0),
      linesRemoved: this.pendingEdits.reduce((sum, e) => sum + e.linesRemoved, 0),
    };
  }

  /**
   * Clear all pending edits.
   */
  clear(): void {
    this.pendingEdits = [];
    this.updateView();
  }

  private async applyAllEdits(): Promise<void> {
    for (const edit of this.pendingEdits) {
      await this.writeEdit(edit);
    }
    const count = this.pendingEdits.length;
    this.pendingEdits = [];
    this.updateView();
    vscode.window.showInformationMessage(`OpenCob: Applied ${count} file edit(s).`);
  }

  private async applyFileEdit(filePath: string): Promise<void> {
    const edit = this.pendingEdits.find((e) => e.file === filePath);
    if (!edit) return;

    await this.writeEdit(edit);
    this.pendingEdits = this.pendingEdits.filter((e) => e.file !== filePath);
    this.updateView();
  }

  private discardAll(): void {
    const count = this.pendingEdits.length;
    this.pendingEdits = [];
    this.updateView();
    vscode.window.showInformationMessage(`OpenCob: Discarded ${count} proposed edit(s).`);
  }

  private discardFileEdit(filePath: string): void {
    this.pendingEdits = this.pendingEdits.filter((e) => e.file !== filePath);
    this.updateView();
  }

  private async writeEdit(edit: FileEdit): Promise<void> {
    if (!edit.newContent) return;

    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders) return;

    const root = workspaceFolders[0].uri;
    const fileUri = vscode.Uri.joinPath(root, edit.file);

    if (edit.status === 'D') {
      await vscode.workspace.fs.delete(fileUri);
    } else {
      const encoder = new TextEncoder();
      await vscode.workspace.fs.writeFile(fileUri, encoder.encode(edit.newContent));
    }
  }

  private async showFileDiff(filePath: string): Promise<void> {
    const edit = this.pendingEdits.find((e) => e.file === filePath);
    if (!edit) return;

    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders) return;

    const root = workspaceFolders[0].uri;
    const fileUri = vscode.Uri.joinPath(root, filePath);

    // Open the file in editor to show the diff
    try {
      const doc = await vscode.workspace.openTextDocument(fileUri);
      await vscode.window.showTextDocument(doc, { preview: true });
    } catch {
      // File doesn't exist yet (new file)
      if (edit.newContent) {
        const doc = await vscode.workspace.openTextDocument({
          content: edit.newContent,
          language: this.inferLanguage(filePath),
        });
        await vscode.window.showTextDocument(doc, { preview: true });
      }
    }
  }

  private inferLanguage(filePath: string): string {
    const ext = filePath.split('.').pop()?.toLowerCase() ?? '';
    const map: Record<string, string> = {
      ts: 'typescript',
      js: 'javascript',
      py: 'python',
      java: 'java',
      go: 'go',
      rs: 'rust',
      json: 'json',
      md: 'markdown',
      yaml: 'yaml',
      yml: 'yaml',
    };
    return map[ext] || 'plaintext';
  }

  private updateView(): void {
    if (!this.view) return;

    const summary = this.getSummary();
    this.view.webview.postMessage({
      type: 'editsUpdate',
      edits: this.pendingEdits.map((e) => ({
        file: e.file,
        status: e.status,
        linesAdded: e.linesAdded,
        linesRemoved: e.linesRemoved,
      })),
      summary,
    });
  }

  private getHtml(): string {
    return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>OpenCob Edits</title>
  <style>
    body { font-family: var(--vscode-font-family); padding: 8px; color: var(--vscode-foreground); background: var(--vscode-editor-background); }
    .empty { text-align: center; padding: 2em 0; opacity: 0.6; }
    .file-list { list-style: none; padding: 0; margin: 0; }
    .file-item { display: flex; align-items: center; padding: 4px 8px; border-bottom: 1px solid var(--vscode-panel-border); cursor: pointer; }
    .file-item:hover { background: var(--vscode-list-hoverBackground); }
    .status { font-weight: bold; width: 20px; margin-right: 8px; }
    .status-M { color: var(--vscode-gitDecoration-modifiedResourceForeground); }
    .status-A { color: var(--vscode-gitDecoration-addedResourceForeground); }
    .status-D { color: var(--vscode-gitDecoration-deletedResourceForeground); }
    .file-name { flex: 1; overflow: hidden; text-overflow: ellipsis; }
    .stats { font-size: 0.85em; opacity: 0.7; }
    .stats-add { color: var(--vscode-gitDecoration-addedResourceForeground); }
    .stats-remove { color: var(--vscode-gitDecoration-deletedResourceForeground); }
    .actions { display: flex; gap: 4px; padding: 8px 0; }
    .btn { padding: 4px 12px; border: none; border-radius: 3px; cursor: pointer; font-size: 0.85em; }
    .btn-primary { background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
    .btn-secondary { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); }
    .summary { padding: 8px; font-size: 0.9em; border-bottom: 1px solid var(--vscode-panel-border); }
  </style>
</head>
<body>
  <div id="content">
    <div class="empty">No proposed edits</div>
  </div>
  <script>
    const vscode = acquireVsCodeApi();
    const content = document.getElementById('content');

    window.addEventListener('message', (event) => {
      const msg = event.data;
      if (msg.type === 'editsUpdate') {
        renderEdits(msg.edits, msg.summary);
      }
    });

    function renderEdits(edits, summary) {
      if (!edits || edits.length === 0) {
        content.innerHTML = '<div class="empty">No proposed edits</div>';
        return;
      }

      let html = '<div class="summary">' +
        summary.filesChanged + ' file(s) changed ' +
        '<span class="stats-add">+' + summary.linesAdded + '</span> ' +
        '<span class="stats-remove">-' + summary.linesRemoved + '</span>' +
        '</div>';

      html += '<ul class="file-list">';
      for (const edit of edits) {
        html += '<li class="file-item" onclick="viewDiff(\\''+edit.file+'\\')">' +
          '<span class="status status-'+edit.status+'">'+edit.status+'</span>' +
          '<span class="file-name">'+edit.file+'</span>' +
          '<span class="stats"><span class="stats-add">+'+edit.linesAdded+'</span> ' +
          '<span class="stats-remove">-'+edit.linesRemoved+'</span></span>' +
          '</li>';
      }
      html += '</ul>';

      html += '<div class="actions">' +
        '<button class="btn btn-primary" onclick="applyAll()">Apply All</button>' +
        '<button class="btn btn-secondary" onclick="discardAll()">Discard All</button>' +
        '</div>';

      content.innerHTML = html;
    }

    function viewDiff(file) { vscode.postMessage({ type: 'viewDiff', file }); }
    function applyAll() { vscode.postMessage({ type: 'applyAll' }); }
    function discardAll() { vscode.postMessage({ type: 'discardAll' }); }
  </script>
</body>
</html>`;
  }
}
