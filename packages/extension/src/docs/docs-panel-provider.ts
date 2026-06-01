import * as vscode from 'vscode';
import * as path from 'node:path';
import * as fs from 'node:fs';
import MarkdownIt from 'markdown-it';

/**
 * Documentation panel that opens in the main editor area.
 * Renders MDX docs as styled HTML with navigation sidebar.
 */
export class DocsPanelProvider {
  private static panel: vscode.WebviewPanel | undefined;
  private docsRoot: string;
  private markdownRenderer: MarkdownIt;

  constructor(
    private readonly extensionUri: vscode.Uri,
    workspaceRoot: string,
  ) {
    this.docsRoot = path.join(workspaceRoot, 'docs', 'pages');
    this.markdownRenderer = new MarkdownIt({
      html: false,
      linkify: true,
      typographer: false,
    });
  }

  /** Open or reveal the docs panel */
  open(page?: string): void {
    if (DocsPanelProvider.panel) {
      DocsPanelProvider.panel.reveal(vscode.ViewColumn.One);
      if (page) {
        DocsPanelProvider.panel.webview.postMessage({ type: 'navigate', page });
      }
      return;
    }

    DocsPanelProvider.panel = vscode.window.createWebviewPanel(
      'opencob.docs',
      'OpenCob Docs',
      vscode.ViewColumn.One,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [this.extensionUri],
      },
    );

    DocsPanelProvider.panel.iconPath = new vscode.ThemeIcon('book');
    DocsPanelProvider.panel.webview.html = this.getHtml(page);

    DocsPanelProvider.panel.webview.onDidReceiveMessage((msg) => {
      if (msg.type === 'loadPage') {
        const content = this.loadPage(msg.page);
        DocsPanelProvider.panel?.webview.postMessage({
          type: 'pageContent',
          page: msg.page,
          content,
        });
      }
    });

    DocsPanelProvider.panel.onDidDispose(() => {
      DocsPanelProvider.panel = undefined;
    });
  }

  /** Load a page's MDX content and convert to simple HTML */
  private loadPage(pageName: string): string {
    const filePath = path.join(this.docsRoot, `${pageName}.mdx`);
    if (!fs.existsSync(filePath)) {
      return '<p>Page not found.</p>';
    }

    const raw = fs.readFileSync(filePath, 'utf-8');
    // Strip YAML frontmatter (supports both LF and CRLF files)
    const content = raw.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, '');
    // Convert Markdown to HTML via markdown-it for robust fenced code/table rendering
    return this.markdownToHtml(content);
  }

  /** Markdown → HTML converter with internal docs link rewriting */
  private markdownToHtml(md: string): string {
    const rendered = this.markdownRenderer.render(md);

    // Rewrite internal docs links (/installation, /customization, etc.) to in-panel navigation.
    return rendered.replace(/<a\s+href="\/(.*?)"/g, (_match: string, target: string) => {
      const page = (target || 'index').replace(/\/+$/, '') || 'index';
      const escapedPage = page.replace(/"/g, '&quot;');
      return `<a href="#" class="nav-link" data-page="${escapedPage}"`;
    });
  }

  /** Build the navigation menu from _meta.json */
  private getNavItems(): Array<{ id: string; title: string }> {
    const metaPath = path.join(this.docsRoot, '_meta.json');
    if (fs.existsSync(metaPath)) {
      try {
        const meta = JSON.parse(fs.readFileSync(metaPath, 'utf-8'));
        return Object.entries(meta).map(([id, title]) => ({ id, title: title as string }));
      } catch {
        /* fallback */
      }
    }
    // Fallback: list .mdx files
    try {
      return fs
        .readdirSync(this.docsRoot)
        .filter((f) => f.endsWith('.mdx'))
        .map((f) => ({ id: f.replace('.mdx', ''), title: f.replace('.mdx', '') }));
    } catch {
      return [{ id: 'index', title: 'Home' }];
    }
  }

  private getHtml(initialPage?: string): string {
    const nav = this.getNavItems();
    const page = initialPage || 'index';
    const initialContent = this.loadPage(page);
    const navHtml = nav
      .map(
        (n) =>
          `<button class="nav-item${n.id === page ? ' active' : ''}" data-page="${n.id}">${n.title}</button>`,
      )
      .join('\n          ');

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>OpenCob Documentation</title>
  <style>
    :root {
      --bg: var(--vscode-editor-background);
      --fg: var(--vscode-editor-foreground);
      --sidebar-bg: var(--vscode-sideBar-background);
      --border: var(--vscode-panel-border, #333);
      --link: var(--vscode-textLink-foreground);
      --active-bg: var(--vscode-list-activeSelectionBackground);
      --active-fg: var(--vscode-list-activeSelectionForeground);
      --hover-bg: var(--vscode-list-hoverBackground);
      --code-bg: var(--vscode-textCodeBlock-background, #1e1e1e);
      --table-border: var(--vscode-panel-border, #444);
    }

    * { margin: 0; padding: 0; box-sizing: border-box; }

    body {
      font-family: var(--vscode-font-family, -apple-system, BlinkMacSystemFont, sans-serif);
      font-size: 14px;
      line-height: 1.7;
      color: var(--fg);
      background: var(--bg);
      display: flex;
      height: 100vh;
      overflow: hidden;
    }

    /* Sidebar Navigation */
    .sidebar {
      width: 220px;
      min-width: 220px;
      background: var(--sidebar-bg);
      border-right: 1px solid var(--border);
      padding: 16px 0;
      overflow-y: auto;
      display: flex;
      flex-direction: column;
    }

    .sidebar-header {
      padding: 0 16px 12px;
      font-size: 13px;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.5px;
      opacity: 0.7;
      border-bottom: 1px solid var(--border);
      margin-bottom: 8px;
    }

    .nav-item {
      display: block;
      width: 100%;
      padding: 6px 16px;
      border: none;
      background: none;
      color: var(--fg);
      font-size: 13px;
      text-align: left;
      cursor: pointer;
      border-radius: 0;
      transition: background 0.1s;
    }

    .nav-item:hover {
      background: var(--hover-bg);
    }

    .nav-item.active {
      background: var(--active-bg);
      color: var(--active-fg);
      font-weight: 500;
    }

    /* Content Area */
    .content {
      flex: 1;
      overflow-y: auto;
      padding: 32px 48px;
      max-width: 800px;
    }

    .content h1 {
      font-size: 28px;
      font-weight: 700;
      margin-bottom: 16px;
      padding-bottom: 8px;
      border-bottom: 1px solid var(--border);
    }

    .content h2 {
      font-size: 20px;
      font-weight: 600;
      margin-top: 32px;
      margin-bottom: 12px;
    }

    .content h3 {
      font-size: 16px;
      font-weight: 600;
      margin-top: 24px;
      margin-bottom: 8px;
    }

    .content h4 {
      font-size: 14px;
      font-weight: 600;
      margin-top: 16px;
      margin-bottom: 6px;
    }

    .content p {
      margin-bottom: 12px;
    }

    .content a {
      color: var(--link);
      text-decoration: none;
    }

    .content a:hover {
      text-decoration: underline;
    }

    .content ul, .content ol {
      margin: 8px 0 12px 24px;
    }

    .content li {
      margin-bottom: 4px;
    }

    .content blockquote {
      border-left: 3px solid var(--link);
      padding: 8px 16px;
      margin: 12px 0;
      opacity: 0.85;
      background: var(--code-bg);
      border-radius: 4px;
    }

    .content hr {
      border: none;
      border-top: 1px solid var(--border);
      margin: 24px 0;
    }

    /* Code */
    .content code {
      font-family: var(--vscode-editor-font-family, Consolas, monospace);
      font-size: 12px;
    }

    .content :not(pre) > code {
      background: var(--code-bg);
      padding: 2px 5px;
      border-radius: 3px;
    }

    .content pre {
      background: var(--code-bg);
      border: 1px solid var(--border);
      border-radius: 6px;
      padding: 14px 16px;
      margin: 12px 0;
      overflow-x: auto;
      line-height: 1.5;
      tab-size: 2;
      -moz-tab-size: 2;
    }

    .content pre code {
      background: none;
      padding: 0;
      display: block;
      min-width: max-content;
      white-space: pre;
    }

    .content pre code.language-json::before {
      content: 'JSON';
      display: inline-block;
      margin-bottom: 8px;
      padding: 2px 6px;
      border: 1px solid var(--border);
      border-radius: 999px;
      font-size: 10px;
      font-weight: 600;
      letter-spacing: 0.04em;
      opacity: 0.8;
    }

    /* Tables */
    table {
      width: 100%;
      border-collapse: collapse;
      margin: 12px 0;
      font-size: 13px;
    }

    th, td {
      border: 1px solid var(--table-border);
      padding: 8px 12px;
      text-align: left;
    }

    th {
      background: var(--code-bg);
      font-weight: 600;
    }

    tr:hover td {
      background: var(--hover-bg);
    }

    /* Responsive */
    @media (max-width: 600px) {
      .sidebar { width: 180px; min-width: 180px; }
      .content { padding: 20px 24px; }
    }
  </style>
</head>
<body>
  <nav class="sidebar">
    <div class="sidebar-header">Documentation</div>
    ${navHtml}
  </nav>
  <main class="content" id="content">
    ${initialContent}
  </main>

  <script>
    const vscode = acquireVsCodeApi();
    const content = document.getElementById('content');

    // Navigation click handlers
    document.querySelectorAll('.nav-item').forEach(btn => {
      btn.addEventListener('click', () => {
        const page = btn.dataset.page;
        navigateTo(page);
      });
    });

    // Handle internal links in content
    content.addEventListener('click', (e) => {
      const link = e.target.closest('a.nav-link[data-page]');
      if (link) {
        e.preventDefault();
        navigateTo(link.dataset.page);
      }
    });

    function navigateTo(page) {
      // Update active nav item
      document.querySelectorAll('.nav-item').forEach(b => b.classList.remove('active'));
      const active = document.querySelector('.nav-item[data-page="' + page + '"]');
      if (active) active.classList.add('active');

      // Request page content
      vscode.postMessage({ type: 'loadPage', page });
    }

    // Receive page content from extension
    window.addEventListener('message', (event) => {
      const msg = event.data;
      if (msg.type === 'pageContent') {
        content.innerHTML = msg.content;
        content.scrollTop = 0;
      }
      if (msg.type === 'navigate') {
        navigateTo(msg.page);
      }
    });
  </script>
</body>
</html>`;
  }
}
