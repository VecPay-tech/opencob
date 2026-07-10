import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import type { FindingsScanner } from '@opencob/core';

interface ScanFinding {
  id: string;
  file: string;
  line: number;
  severity: 'error' | 'warning' | 'info';
  category: string;
  message: string;
}

export class ScanPanel {
  private static currentPanel: ScanPanel | undefined;
  private readonly panel: vscode.WebviewPanel;
  private findings: ScanFinding[] = [];
  private filePath: string = '';
  private targetLabel: string = '';
  private disposables: vscode.Disposable[] = [];

  public static show(
    extensionUri: vscode.Uri,
    scanner: FindingsScanner,
    _workspaceRoot: string,
  ): ScanPanel {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      vscode.window.showWarningMessage('OpenCob: No active file to scan');
      return ScanPanel.currentPanel!;
    }

    const filePath = editor.document.uri.fsPath;
    return ScanPanel.scanPaths(extensionUri, scanner, [filePath]);
  }

  public static scanPaths(
    extensionUri: vscode.Uri,
    scanner: FindingsScanner,
    files: string[],
    label?: string,
  ): ScanPanel {
    if (ScanPanel.currentPanel) {
      ScanPanel.currentPanel.scanFiles(scanner, files, label);
      ScanPanel.currentPanel.panel.reveal(vscode.ViewColumn.Two, true);
      return ScanPanel.currentPanel;
    }

    const panel = vscode.window.createWebviewPanel(
      'opencobScan',
      'OpenCob Scan',
      { viewColumn: vscode.ViewColumn.Two, preserveFocus: true },
      { enableScripts: true, retainContextWhenHidden: true },
    );

    ScanPanel.currentPanel = new ScanPanel(panel, extensionUri);
    ScanPanel.currentPanel.scanFiles(scanner, files, label);
    return ScanPanel.currentPanel;
  }

  private constructor(
    panel: vscode.WebviewPanel,
    private extensionUri: vscode.Uri,
  ) {
    this.panel = panel;
    this.panel.iconPath = new vscode.ThemeIcon('search-fuzzy');

    this.panel.onDidDispose(
      () => {
        ScanPanel.currentPanel = undefined;
        this.disposables.forEach((d) => d.dispose());
      },
      null,
      this.disposables,
    );

    this.panel.webview.onDidReceiveMessage(
      async (msg) => {
        switch (msg.command) {
          case 'goToLine':
            await this.navigateToFinding(msg.file, msg.line);
            break;
          case 'fixOne':
            await this.fixFinding(msg.findingId);
            break;
          case 'fixAll':
            await this.fixAllFindings();
            break;
        }
      },
      null,
      this.disposables,
    );
  }

  private scanFiles(scanner: FindingsScanner, files: string[], label?: string): void {
    this.findings = [];
    for (const filePath of files) {
      const results = scanner.scanFile(filePath);
      for (const f of results) {
        this.findings.push({
          id: f.id,
          file: f.filePath,
          line: f.line ?? 1,
          severity: f.severity,
          category: f.category,
          message: f.message,
        });
      }
    }
    if (files.length === 1) {
      this.filePath = files[0];
      this.targetLabel = path.basename(files[0]);
    } else {
      this.filePath = '';
      this.targetLabel = label ?? `${files.length} files`;
    }
    this.panel.title = `Scan: ${this.targetLabel}`;
    this.updateWebview();
  }

  private updateWebview(): void {
    this.panel.webview.html = this.getHtml();
  }

  private async navigateToFinding(file: string, line: number): Promise<void> {
    const fileUri = path.isAbsolute(file)
      ? vscode.Uri.file(file)
      : (() => {
          const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
          return workspaceFolder
            ? vscode.Uri.joinPath(workspaceFolder.uri, file)
            : vscode.Uri.file(file);
        })();
    const doc = await vscode.workspace.openTextDocument(fileUri);
    const editor = await vscode.window.showTextDocument(doc, vscode.ViewColumn.One);
    const pos = new vscode.Position(Math.max(0, line - 1), 0);
    editor.selection = new vscode.Selection(pos, pos);
    editor.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenter);
  }

  private async fixFinding(findingId: string): Promise<void> {
    const finding = this.findings.find((f) => f.id === findingId);
    if (!finding) return;

    // Read surrounding context to include in prompt (agent may not have file access)
    let codeContext = '';
    try {
      const content = fs.readFileSync(finding.file, 'utf-8');
      const lines = content.split('\n');
      const start = Math.max(0, finding.line - 10);
      const end = Math.min(lines.length, finding.line + 10);
      const snippet = lines
        .slice(start, end)
        .map((l, i) => `${start + i + 1}: ${l}`)
        .join('\n');
      codeContext = `\n\nCode context (lines ${start + 1}-${end}):\n\`\`\`\n${snippet}\n\`\`\`\n`;
    } catch {
      /* file not readable, agent will try on its own */
    }

    const prompt =
      `Fix the following quality issue in file "${finding.file}" at line ${finding.line}:\n\n` +
      `Issue: [${finding.severity.toUpperCase()}] ${finding.category} — ${finding.message}` +
      codeContext +
      `\n\n` +
      `Apply the appropriate fix. Write the corrected code using write_to_file.`;
    await vscode.commands.executeCommand('opencob.sendToChat', prompt);
  }

  private async fixAllFindings(): Promise<void> {
    if (this.findings.length === 0) return;
    if (this.filePath) {
      // Single file: include full file content so agent doesn't need read access
      let fileContent = '';
      try {
        fileContent = fs.readFileSync(this.filePath, 'utf-8');
      } catch {
        /* fall through */
      }

      const issueList = this.findings
        .map((f, i) => `${i + 1}. Line ${f.line}: [${f.severity}] ${f.category} — ${f.message}`)
        .join('\n');
      const contentBlock = fileContent
        ? `\n\nFull file content:\n\`\`\`\n${fileContent}\n\`\`\`\n`
        : '';
      const prompt =
        `Fix ALL the following quality issues in file "${this.filePath}":\n\n${issueList}` +
        contentBlock +
        `\n\nFix each issue and write the corrected file using write_to_file.`;
      await vscode.commands.executeCommand('opencob.sendToChat', prompt);
    } else {
      // Multi-file: include content per file
      const byFile = new Map<string, ScanFinding[]>();
      for (const f of this.findings) {
        if (!byFile.has(f.file)) byFile.set(f.file, []);
        byFile.get(f.file)!.push(f);
      }
      const issueList = [...byFile.entries()]
        .map(([file, findings]) => {
          const items = findings
            .map((f) => `  - Line ${f.line}: [${f.severity}] ${f.category} — ${f.message}`)
            .join('\n');
          let content = '';
          try {
            content = fs.readFileSync(file, 'utf-8');
          } catch {
            /* skip */
          }
          const contentBlock = content ? `\n  File content:\n\`\`\`\n${content}\n\`\`\`` : '';
          return `File: ${file}\n${items}${contentBlock}`;
        })
        .join('\n\n');
      const prompt =
        `Fix ALL the following quality issues across multiple files:\n\n${issueList}\n\n` +
        `Fix the issues and write the corrected files using write_to_file.`;
      await vscode.commands.executeCommand('opencob.sendToChat', prompt);
    }
  }

  private getHtml(): string {
    const errorCount = this.findings.filter((f) => f.severity === 'error').length;
    const warningCount = this.findings.filter((f) => f.severity === 'warning').length;
    const infoCount = this.findings.filter((f) => f.severity === 'info').length;
    const isMultiFile = !this.filePath;

    const findingsHtml =
      this.findings.length === 0
        ? '<div class="empty">No issues found — all clear!</div>'
        : this.findings
            .map((f) => {
              const locFile = isMultiFile ? path.basename(f.file) : '';
              const locLabel = isMultiFile ? `${locFile}:${f.line}` : `Line ${f.line}`;
              const escapedFile = f.file.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
              return `
        <div class="finding ${f.severity}" data-id="${f.id}">
          <div class="finding-header">
            <span class="severity-icon">${this.severityIcon(f.severity)}</span>
            <span class="category">${f.category}</span>
            <span class="location" onclick="goToLine('${escapedFile}', ${f.line})">${locLabel}</span>
          </div>
          <div class="finding-message">${this.escapeHtml(f.message)}</div>
          <button class="fix-btn" onclick="fixOne('${f.id}')">Fix with OpenCob</button>
        </div>
      `;
            })
            .join('');

    return `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<style>
  :root {
    --bg: var(--vscode-editor-background);
    --fg: var(--vscode-editor-foreground);
    --border: var(--vscode-panel-border);
    --error: #f14c4c;
    --warning: #cca700;
    --info: #3794ff;
    --btn-bg: var(--vscode-button-background);
    --btn-fg: var(--vscode-button-foreground);
    --btn-hover: var(--vscode-button-hoverBackground);
  }
  body { font-family: var(--vscode-font-family); margin: 0; padding: 16px; background: var(--bg); color: var(--fg); }
  .header { display: flex; align-items: center; justify-content: space-between; margin-bottom: 16px; border-bottom: 1px solid var(--border); padding-bottom: 12px; }
  .header h2 { margin: 0; font-size: 14px; font-weight: 600; }
  .stats { display: flex; gap: 12px; font-size: 12px; }
  .stat { display: flex; align-items: center; gap: 4px; }
  .stat.error { color: var(--error); }
  .stat.warning { color: var(--warning); }
  .stat.info { color: var(--info); }
  .actions { margin-bottom: 16px; }
  .fix-all-btn { background: var(--btn-bg); color: var(--btn-fg); border: none; padding: 6px 14px; border-radius: 3px; cursor: pointer; font-size: 12px; }
  .fix-all-btn:hover { background: var(--btn-hover); }
  .fix-all-btn:disabled { opacity: 0.5; cursor: not-allowed; }
  .finding { border: 1px solid var(--border); border-radius: 4px; padding: 10px 12px; margin-bottom: 8px; border-left: 3px solid var(--border); }
  .finding.error { border-left-color: var(--error); }
  .finding.warning { border-left-color: var(--warning); }
  .finding.info { border-left-color: var(--info); }
  .finding-header { display: flex; align-items: center; gap: 8px; margin-bottom: 4px; font-size: 12px; }
  .severity-icon { font-size: 14px; }
  .category { background: var(--vscode-badge-background); color: var(--vscode-badge-foreground); padding: 1px 6px; border-radius: 3px; font-size: 11px; text-transform: uppercase; }
  .location { margin-left: auto; color: var(--info); cursor: pointer; text-decoration: underline; }
  .location:hover { opacity: 0.8; }
  .finding-message { font-size: 13px; line-height: 1.4; margin-bottom: 6px; }
  .fix-btn { background: transparent; border: 1px solid var(--btn-bg); color: var(--btn-bg); padding: 3px 10px; border-radius: 3px; cursor: pointer; font-size: 11px; }
  .fix-btn:hover { background: var(--btn-bg); color: var(--btn-fg); }
  .empty { text-align: center; padding: 40px; color: var(--vscode-descriptionForeground); font-size: 14px; }
  .empty::before { content: '✓'; display: block; font-size: 32px; margin-bottom: 8px; color: #89d185; }
</style>
</head>
<body>
  <div class="header">
    <h2>${this.escapeHtml(this.targetLabel)}</h2>
    <div class="stats">
      <span class="stat error">● ${errorCount} errors</span>
      <span class="stat warning">● ${warningCount} warnings</span>
      <span class="stat info">● ${infoCount} info</span>
    </div>
  </div>
  <div class="actions">
    <button class="fix-all-btn" onclick="fixAll()" ${this.findings.length === 0 ? 'disabled' : ''}>
      ⚡ Fix All with OpenCob (${this.findings.length} issues)
    </button>
  </div>
  <div class="findings">
    ${findingsHtml}
  </div>
  <script>
    const vscode = acquireVsCodeApi();
    function goToLine(file, line) {
      vscode.postMessage({ command: 'goToLine', file, line });
    }
    function fixOne(findingId) {
      vscode.postMessage({ command: 'fixOne', findingId });
    }
    function fixAll() {
      vscode.postMessage({ command: 'fixAll' });
    }
  </script>
</body>
</html>`;
  }

  private severityIcon(severity: string): string {
    switch (severity) {
      case 'error':
        return '🔴';
      case 'warning':
        return '🟡';
      case 'info':
        return '🔵';
      default:
        return '⚪';
    }
  }

  private escapeHtml(text: string): string {
    return text
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }
}
