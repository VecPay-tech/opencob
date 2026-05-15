import * as vscode from 'vscode';

export interface ActivityEntry {
  id: string;
  timestamp: number;
  type: 'tool_call' | 'file_edit' | 'file_read' | 'mode_switch' | 'error' | 'insight' | 'scan';
  title: string;
  detail?: string;
  icon?: string;
  file?: string;
  line?: number;
  severity?: 'error' | 'warning' | 'info' | 'success';
}

export interface InsightEntry {
  id: string;
  file: string;
  line: number;
  severity: 'error' | 'warning' | 'info';
  category: string;
  message: string;
  suggestion?: string;
  timestamp: number;
}

export interface WorkspaceStats {
  totalFiles: number;
  indexedFiles: number;
  recentEdits: string[];
  languages: Record<string, number>;
}

const outputChannel = vscode.window.createOutputChannel('OpenCob Activity');

export class ActivityPanelProvider implements vscode.WebviewViewProvider {
  private view?: vscode.WebviewView;
  private activities: ActivityEntry[] = [];
  private insights: InsightEntry[] = [];
  private workspaceStats: WorkspaceStats = {
    totalFiles: 0,
    indexedFiles: 0,
    recentEdits: [],
    languages: {},
  };

  constructor(private readonly extensionUri: vscode.Uri) {}

  resolveWebviewView(
    webviewView: vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken,
  ): void {
    this.view = webviewView;
    webviewView.webview.options = { enableScripts: true, localResourceRoots: [this.extensionUri] };
    webviewView.webview.html = this.getHtml();

    webviewView.webview.onDidReceiveMessage((message) => {
      switch (message.type) {
        case 'openFile':
          if (message.path) {
            const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri;
            if (workspaceRoot) {
              const fileUri = vscode.Uri.joinPath(workspaceRoot, message.path);
              vscode.window.showTextDocument(fileUri, { preview: true }).then((editor) => {
                if (message.line) {
                  const line = Math.max(0, message.line - 1);
                  editor.selection = new vscode.Selection(line, 0, line, 0);
                  editor.revealRange(
                    new vscode.Range(line, 0, line, 0),
                    vscode.TextEditorRevealType.InCenter,
                  );
                }
              });
            }
          }
          break;
        case 'clearActivity':
          this.activities = [];
          this.refresh();
          break;
        case 'clearInsights':
          this.insights = [];
          this.refresh();
          break;
        case 'runScan':
          vscode.commands.executeCommand('OpenCob.scanWorkspace');
          break;
        case 'refresh':
          this.refresh();
          break;
      }
    });
  }

  /** Add an activity entry and refresh the view */
  addActivity(entry: Omit<ActivityEntry, 'id' | 'timestamp'>): void {
    this.activities.unshift({
      ...entry,
      id: `act-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      timestamp: Date.now(),
    });
    // Keep last 200 entries
    if (this.activities.length > 200) this.activities.length = 200;
    this.view?.webview.postMessage({ type: 'activity', entries: this.activities.slice(0, 50) });
  }

  /** Add insight entries (from scanner) */
  addInsights(entries: InsightEntry[]): void {
    for (const entry of entries) {
      const existing = this.insights.findIndex(
        (i) => i.file === entry.file && i.line === entry.line && i.message === entry.message,
      );
      if (existing === -1) this.insights.push(entry);
    }
    this.view?.webview.postMessage({ type: 'insights', entries: this.insights });
  }

  /** Update workspace stats */
  updateStats(stats: Partial<WorkspaceStats>): void {
    Object.assign(this.workspaceStats, stats);
    this.view?.webview.postMessage({ type: 'stats', stats: this.workspaceStats });
  }

  /** Full refresh */
  private refresh(): void {
    this.view?.webview.postMessage({
      type: 'fullRefresh',
      activities: this.activities.slice(0, 50),
      insights: this.insights,
      stats: this.workspaceStats,
    });
  }

  private getHtml(): string {
    return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1.0"/>
<style>
  :root { --radius: 6px; --gap: 8px; }
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body {
    font-family: var(--vscode-font-family);
    font-size: 12px;
    color: var(--vscode-foreground);
    background: var(--vscode-sideBar-background);
    overflow-x: hidden;
  }

  /* ─── Tab Navigation ─── */
  .tab-bar {
    display: flex; gap: 0; border-bottom: 1px solid var(--vscode-panel-border);
    position: sticky; top: 0; z-index: 10;
    background: var(--vscode-sideBar-background);
  }
  .tab-btn {
    flex: 1; padding: 8px 4px; border: none; background: none;
    color: var(--vscode-descriptionForeground); font-size: 11px; font-weight: 500;
    cursor: pointer; border-bottom: 2px solid transparent;
    display: flex; align-items: center; justify-content: center; gap: 4px;
    transition: all 0.15s;
  }
  .tab-btn:hover { color: var(--vscode-foreground); background: var(--vscode-toolbar-hoverBackground); }
  .tab-btn.active {
    color: var(--vscode-foreground);
    border-bottom-color: var(--vscode-focusBorder);
  }
  .tab-badge {
    background: var(--vscode-badge-background); color: var(--vscode-badge-foreground);
    border-radius: 8px; padding: 1px 5px; font-size: 10px; min-width: 16px; text-align: center;
  }

  /* ─── Panels ─── */
  .panel { display: none; padding: var(--gap); }
  .panel.active { display: block; }

  /* ─── Activity Feed ─── */
  .activity-header {
    display: flex; align-items: center; justify-content: space-between;
    padding: 4px 0 8px; border-bottom: 1px solid var(--vscode-panel-border);
    margin-bottom: 8px;
  }
  .activity-header h3 { font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.5px; }
  .clear-btn {
    background: none; border: none; color: var(--vscode-descriptionForeground);
    cursor: pointer; font-size: 11px; padding: 2px 6px; border-radius: 3px;
  }
  .clear-btn:hover { background: var(--vscode-toolbar-hoverBackground); color: var(--vscode-foreground); }

  .activity-list { list-style: none; }
  .activity-item {
    display: flex; align-items: flex-start; gap: 8px; padding: 6px 4px;
    border-radius: var(--radius); transition: background 0.1s;
  }
  .activity-item:hover { background: var(--vscode-list-hoverBackground); }
  .activity-icon {
    width: 20px; height: 20px; border-radius: 50%; display: flex; align-items: center; justify-content: center;
    font-size: 10px; flex-shrink: 0; margin-top: 1px;
  }
  .activity-icon.tool { background: var(--vscode-debugIcon-stepOverForeground, #569cd6)22; color: var(--vscode-debugIcon-stepOverForeground, #569cd6); }
  .activity-icon.edit { background: var(--vscode-terminal-ansiYellow, #e5c07b)22; color: var(--vscode-terminal-ansiYellow, #e5c07b); }
  .activity-icon.read { background: var(--vscode-terminal-ansiGreen, #4ec970)22; color: var(--vscode-terminal-ansiGreen, #4ec970); }
  .activity-icon.mode { background: var(--vscode-terminal-ansiMagenta, #c678dd)22; color: var(--vscode-terminal-ansiMagenta, #c678dd); }
  .activity-icon.error { background: var(--vscode-terminal-ansiRed, #e06c75)22; color: var(--vscode-terminal-ansiRed, #e06c75); }
  .activity-icon.insight { background: var(--vscode-terminal-ansiCyan, #56b6c2)22; color: var(--vscode-terminal-ansiCyan, #56b6c2); }
  .activity-body { flex: 1; min-width: 0; }
  .activity-title { font-size: 12px; font-weight: 500; line-height: 1.4; }
  .activity-detail { font-size: 11px; color: var(--vscode-descriptionForeground); margin-top: 2px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .activity-time { font-size: 10px; color: var(--vscode-descriptionForeground); white-space: nowrap; margin-top: 2px; }
  .activity-empty {
    text-align: center; padding: 24px; color: var(--vscode-descriptionForeground);
  }
  .activity-empty svg { opacity: 0.4; margin-bottom: 8px; }

  /* ─── Insights ─── */
  .insight-group { margin-bottom: 12px; }
  .insight-group-header {
    display: flex; align-items: center; gap: 6px; padding: 4px 0;
    font-size: 11px; font-weight: 600; cursor: pointer;
  }
  .insight-group-header:hover { color: var(--vscode-textLink-foreground); }
  .insight-group-badge {
    font-size: 10px; padding: 1px 5px; border-radius: 8px; font-weight: 500;
  }
  .insight-group-badge.error { background: var(--vscode-inputValidation-errorBackground, #5a1d1d); color: var(--vscode-inputValidation-errorForeground, #f48771); }
  .insight-group-badge.warning { background: var(--vscode-inputValidation-warningBackground, #352a05); color: var(--vscode-inputValidation-warningForeground, #cca700); }
  .insight-group-badge.info { background: var(--vscode-inputValidation-infoBackground, #063b49); color: var(--vscode-inputValidation-infoForeground, #75beff); }

  .insight-item {
    display: flex; align-items: flex-start; gap: 6px; padding: 5px 4px 5px 16px;
    border-radius: var(--radius); cursor: pointer; transition: background 0.1s;
  }
  .insight-item:hover { background: var(--vscode-list-hoverBackground); }
  .insight-severity {
    width: 6px; height: 6px; border-radius: 50%; flex-shrink: 0; margin-top: 5px;
  }
  .insight-severity.error { background: var(--vscode-inputValidation-errorForeground, #f48771); }
  .insight-severity.warning { background: var(--vscode-inputValidation-warningForeground, #cca700); }
  .insight-severity.info { background: var(--vscode-inputValidation-infoForeground, #75beff); }
  .insight-msg { font-size: 12px; flex: 1; line-height: 1.4; }
  .insight-loc { font-size: 10px; color: var(--vscode-descriptionForeground); white-space: nowrap; }
  .insight-empty { text-align: center; padding: 24px; color: var(--vscode-descriptionForeground); }
  .scan-btn {
    margin-top: 8px; padding: 6px 12px; border-radius: var(--radius); border: none;
    background: var(--vscode-button-background); color: var(--vscode-button-foreground);
    font-size: 11px; cursor: pointer; font-weight: 500;
  }
  .scan-btn:hover { background: var(--vscode-button-hoverBackground); }

  /* ─── Workspace Context ─── */
  .stats-grid {
    display: grid; grid-template-columns: 1fr 1fr; gap: 8px; margin-bottom: 12px;
  }
  .stat-card {
    background: var(--vscode-editorWidget-background); border: 1px solid var(--vscode-panel-border);
    border-radius: var(--radius); padding: 10px;
  }
  .stat-value { font-size: 18px; font-weight: 700; color: var(--vscode-foreground); }
  .stat-label { font-size: 10px; color: var(--vscode-descriptionForeground); text-transform: uppercase; letter-spacing: 0.3px; margin-top: 2px; }

  .section-title {
    font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.5px;
    padding: 8px 0 6px; border-bottom: 1px solid var(--vscode-panel-border); margin-bottom: 6px;
  }
  .lang-bar {
    display: flex; align-items: center; gap: 6px; padding: 3px 0;
  }
  .lang-name { font-size: 11px; width: 60px; }
  .lang-track { flex: 1; height: 6px; background: var(--vscode-editorWidget-background); border-radius: 3px; overflow: hidden; }
  .lang-fill { height: 100%; border-radius: 3px; background: var(--vscode-focusBorder); transition: width 0.3s; }
  .lang-count { font-size: 10px; color: var(--vscode-descriptionForeground); width: 24px; text-align: right; }

  .recent-list { list-style: none; }
  .recent-item {
    padding: 4px 6px; border-radius: var(--radius); cursor: pointer;
    font-size: 11px; display: flex; align-items: center; gap: 6px;
    transition: background 0.1s;
  }
  .recent-item:hover { background: var(--vscode-list-hoverBackground); }
  .recent-item svg { opacity: 0.5; flex-shrink: 0; }
</style>
</head>
<body>
  <div class="tab-bar">
    <button class="tab-btn active" data-panel="activity">
      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/></svg>
      Activity <span class="tab-badge" id="activity-badge">0</span>
    </button>
    <button class="tab-btn" data-panel="insights">
      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
      Insights <span class="tab-badge" id="insights-badge">0</span>
    </button>
    <button class="tab-btn" data-panel="workspace">
      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>
      Workspace
    </button>
  </div>

  <!-- Activity Panel -->
  <div class="panel active" id="panel-activity">
    <div class="activity-header">
      <h3>Agent Activity</h3>
      <button class="clear-btn" id="clear-activity">Clear</button>
    </div>
    <ul class="activity-list" id="activity-list"></ul>
    <div class="activity-empty" id="activity-empty">
      <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/></svg>
      <div>No activity yet</div>
      <div style="margin-top:4px;font-size:10px;">Agent actions will appear here as you chat</div>
    </div>
  </div>

  <!-- Insights Panel -->
  <div class="panel" id="panel-insights">
    <div class="activity-header">
      <h3>Code Insights</h3>
      <button class="clear-btn" id="clear-insights">Clear</button>
    </div>
    <div id="insights-list"></div>
    <div class="insight-empty" id="insights-empty">
      <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
      <div>No insights found</div>
      <div style="margin-top:6px;">
        <button class="scan-btn" id="run-scan">Scan Workspace</button>
      </div>
    </div>
  </div>

  <!-- Workspace Panel -->
  <div class="panel" id="panel-workspace">
    <div class="stats-grid">
      <div class="stat-card"><div class="stat-value" id="stat-total">0</div><div class="stat-label">Total Files</div></div>
      <div class="stat-card"><div class="stat-value" id="stat-indexed">0</div><div class="stat-label">Indexed</div></div>
    </div>
    <div class="section-title">Languages</div>
    <div id="lang-bars"></div>
    <div class="section-title" style="margin-top:12px;">Recent Edits</div>
    <ul class="recent-list" id="recent-list"></ul>
  </div>

<script>
  var vscode = acquireVsCodeApi();

  // Tab switching
  var tabs = document.querySelectorAll('.tab-btn');
  var panels = document.querySelectorAll('.panel');
  tabs.forEach(function(tab) {
    tab.addEventListener('click', function() {
      tabs.forEach(function(t) { t.classList.remove('active'); });
      panels.forEach(function(p) { p.classList.remove('active'); });
      tab.classList.add('active');
      document.getElementById('panel-' + tab.dataset.panel).classList.add('active');
    });
  });

  // Activity
  var activityList = document.getElementById('activity-list');
  var activityEmpty = document.getElementById('activity-empty');
  var activityBadge = document.getElementById('activity-badge');

  function renderActivities(entries) {
    activityBadge.textContent = entries.length;
    if (entries.length === 0) {
      activityList.innerHTML = '';
      activityEmpty.style.display = 'block';
      return;
    }
    activityEmpty.style.display = 'none';
    activityList.innerHTML = entries.map(function(e) {
      var iconClass = e.type === 'tool_call' ? 'tool' : e.type === 'file_edit' ? 'edit' : e.type === 'file_read' ? 'read' : e.type === 'mode_switch' ? 'mode' : e.type === 'error' ? 'error' : 'insight';
      var icons = { tool_call: '\\u2699', file_edit: '\\u270E', file_read: '\\u25B6', mode_switch: '\\u21C4', error: '\\u26A0', insight: '\\u2139', scan: '\\u{1F50D}' };
      var icon = icons[e.type] || '\\u2022';
      var time = formatRelativeTime(e.timestamp);
      var detail = e.detail ? '<div class="activity-detail">' + escapeHtml(e.detail) + '</div>' : '';
      var fileAttr = e.file ? ' data-file="' + escapeHtml(e.file) + '"' + (e.line ? ' data-line="' + e.line + '"' : '') : '';
      return '<li class="activity-item"' + fileAttr + '>' +
        '<div class="activity-icon ' + iconClass + '">' + icon + '</div>' +
        '<div class="activity-body"><div class="activity-title">' + escapeHtml(e.title) + '</div>' + detail + '</div>' +
        '<span class="activity-time">' + time + '</span></li>';
    }).join('');

    activityList.querySelectorAll('.activity-item[data-file]').forEach(function(item) {
      item.style.cursor = 'pointer';
      item.addEventListener('click', function() {
        vscode.postMessage({ type: 'openFile', path: item.dataset.file, line: parseInt(item.dataset.line) || 0 });
      });
    });
  }

  // Insights
  var insightsList = document.getElementById('insights-list');
  var insightsEmpty = document.getElementById('insights-empty');
  var insightsBadge = document.getElementById('insights-badge');

  function renderInsights(entries) {
    insightsBadge.textContent = entries.length;
    if (entries.length === 0) {
      insightsList.innerHTML = '';
      insightsEmpty.style.display = 'block';
      return;
    }
    insightsEmpty.style.display = 'none';
    // Group by category
    var groups = {};
    entries.forEach(function(e) {
      if (!groups[e.category]) groups[e.category] = [];
      groups[e.category].push(e);
    });
    var html = '';
    Object.keys(groups).sort().forEach(function(cat) {
      var items = groups[cat];
      var worst = items.some(function(i) { return i.severity === 'error'; }) ? 'error' : items.some(function(i) { return i.severity === 'warning'; }) ? 'warning' : 'info';
      html += '<div class="insight-group"><div class="insight-group-header">' +
        '<span class="insight-group-badge ' + worst + '">' + items.length + '</span> ' +
        escapeHtml(cat.charAt(0).toUpperCase() + cat.slice(1)) + '</div>';
      items.forEach(function(item) {
        html += '<div class="insight-item" data-file="' + escapeHtml(item.file) + '" data-line="' + item.line + '">' +
          '<div class="insight-severity ' + item.severity + '"></div>' +
          '<div class="insight-msg">' + escapeHtml(item.message) + '</div>' +
          '<span class="insight-loc">' + escapeHtml(item.file.split('/').pop() || item.file) + ':' + item.line + '</span></div>';
      });
      html += '</div>';
    });
    insightsList.innerHTML = html;
    insightsList.querySelectorAll('.insight-item').forEach(function(item) {
      item.addEventListener('click', function() {
        vscode.postMessage({ type: 'openFile', path: item.dataset.file, line: parseInt(item.dataset.line) || 0 });
      });
    });
  }

  // Workspace stats
  function renderStats(stats) {
    document.getElementById('stat-total').textContent = stats.totalFiles || 0;
    document.getElementById('stat-indexed').textContent = stats.indexedFiles || 0;

    // Languages
    var langBars = document.getElementById('lang-bars');
    var langs = stats.languages || {};
    var maxCount = Math.max.apply(null, Object.values(langs).concat([1]));
    langBars.innerHTML = Object.keys(langs).sort(function(a, b) { return langs[b] - langs[a]; }).slice(0, 8).map(function(lang) {
      var pct = Math.round((langs[lang] / maxCount) * 100);
      return '<div class="lang-bar"><span class="lang-name">' + escapeHtml(lang) + '</span>' +
        '<div class="lang-track"><div class="lang-fill" style="width:' + pct + '%"></div></div>' +
        '<span class="lang-count">' + langs[lang] + '</span></div>';
    }).join('');

    // Recent edits
    var recentList = document.getElementById('recent-list');
    var recents = stats.recentEdits || [];
    recentList.innerHTML = recents.slice(0, 10).map(function(f) {
      return '<li class="recent-item" data-file="' + escapeHtml(f) + '">' +
        '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>' +
        escapeHtml(f) + '</li>';
    }).join('');
    recentList.querySelectorAll('.recent-item').forEach(function(item) {
      item.addEventListener('click', function() {
        vscode.postMessage({ type: 'openFile', path: item.dataset.file });
      });
    });
  }

  // Utils
  function escapeHtml(str) {
    if (!str) return '';
    return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  function formatRelativeTime(ts) {
    var diff = Date.now() - ts;
    if (diff < 60000) return 'now';
    if (diff < 3600000) return Math.floor(diff / 60000) + 'm';
    if (diff < 86400000) return Math.floor(diff / 3600000) + 'h';
    return Math.floor(diff / 86400000) + 'd';
  }

  // Buttons
  document.getElementById('clear-activity').addEventListener('click', function() {
    vscode.postMessage({ type: 'clearActivity' });
    renderActivities([]);
  });
  document.getElementById('clear-insights').addEventListener('click', function() {
    vscode.postMessage({ type: 'clearInsights' });
    renderInsights([]);
  });
  document.getElementById('run-scan').addEventListener('click', function() {
    vscode.postMessage({ type: 'runScan' });
  });

  // Message handler
  window.addEventListener('message', function(event) {
    var msg = event.data;
    switch (msg.type) {
      case 'activity': renderActivities(msg.entries); break;
      case 'insights': renderInsights(msg.entries); break;
      case 'stats': renderStats(msg.stats); break;
      case 'fullRefresh':
        renderActivities(msg.activities || []);
        renderInsights(msg.insights || []);
        renderStats(msg.stats || {});
        break;
    }
  });
</script>
</body>
</html>`;
  }
}
