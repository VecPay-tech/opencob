import * as vscode from 'vscode';
import { generateDiagramFromContent, getSectionsFromContent } from '@opencob/core';

interface DiagramState {
  content: string;
  ext: string;
  filePath: string;
  currentType: string;
  currentSectionId: number | undefined;
  currentDirection: string;
  currentZoom: number;
  availableTypes: string[];
  sections: Array<{ id: number; name: string; type: string; startLine: number }>;
}

export class DiagramPanel {
  private static instance: DiagramPanel | undefined;
  private panel: vscode.WebviewPanel;
  private state: DiagramState;
  private extensionUri: vscode.Uri;
  private disposables: vscode.Disposable[] = [];

  private constructor(
    panel: vscode.WebviewPanel,
    state: DiagramState,
    extensionUri: vscode.Uri,
  ) {
    this.panel = panel;
    this.state = state;
    this.extensionUri = extensionUri;

    this.panel.webview.onDidReceiveMessage(
      (msg) => this.handleMessage(msg),
      null,
      this.disposables,
    );

    this.panel.onDidDispose(() => this.dispose(), null, this.disposables);

    this.render();
  }

  static create(context: vscode.ExtensionContext, state: DiagramState): DiagramPanel {
    if (DiagramPanel.instance) {
      DiagramPanel.instance.state = state;
      DiagramPanel.instance.render();
      DiagramPanel.instance.panel.reveal(vscode.ViewColumn.Two);
      return DiagramPanel.instance;
    }

    const panel = vscode.window.createWebviewPanel(
      'opencobDiagram',
      `Diagram: ${state.filePath.split(/[\\/]/).pop()}`,
      { viewColumn: vscode.ViewColumn.Two, preserveFocus: true },
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'resources')],
      },
    );

    DiagramPanel.instance = new DiagramPanel(panel, state, context.extensionUri);
    return DiagramPanel.instance;
  }

  private async handleMessage(msg: { command: string; [key: string]: any }) {
    switch (msg.command) {
      case 'switchType':
        this.state.currentType = msg.type;
        this.state.currentSectionId = undefined;
        this.state.sections = getSectionsFromContent(this.state.content, this.state.ext);
        this.render();
        break;

      case 'switchSection':
        this.state.currentSectionId = msg.sectionId === -1 ? undefined : msg.sectionId;
        this.render();
        break;

      case 'switchDirection':
        this.state.currentDirection = msg.direction;
        this.render();
        break;

      case 'switchZoom':
        this.state.currentZoom = msg.zoom;
        // Zoom only changes CSS, no re-render needed — handled in webview JS
        break;

      case 'navigateToLine': {
        const line = msg.line as number;
        if (!line || line < 1) return;
        const uri = vscode.Uri.file(this.state.filePath);
        const doc = await vscode.workspace.openTextDocument(uri);
        const editor = await vscode.window.showTextDocument(doc, {
          viewColumn: vscode.ViewColumn.One,
          preserveFocus: false,
        });
        const pos = new vscode.Position(line - 1, 0);
        editor.selection = new vscode.Selection(pos, pos);
        editor.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenter);
        break;
      }

      case 'navigateToFile': {
        const programName = (msg.programName as string)?.toLowerCase();
        if (!programName) return;
        // Search workspace for matching source files
        const patterns = [`**/${programName}.*`, `**/${programName.toUpperCase()}.*`];
        let found: vscode.Uri | undefined;
        for (const pattern of patterns) {
          const files = await vscode.workspace.findFiles(pattern, '**/node_modules/**', 5);
          // Prefer source files over compiled/object files
          const sourceExts = [
            '.cbl',
            '.cob',
            '.clp',
            '.clle',
            '.rpgle',
            '.sqlrpgle',
            '.rpg',
            '.pli',
            '.dds',
            '.pf',
            '.lf',
            '.dspf',
            '.prtf',
          ];
          const match = files.find((f) =>
            sourceExts.some((e) => f.fsPath.toLowerCase().endsWith(e)),
          );
          if (match) {
            found = match;
            break;
          }
          if (files.length > 0 && !found) found = files[0];
        }
        if (found) {
          const doc = await vscode.workspace.openTextDocument(found);
          await vscode.window.showTextDocument(doc, {
            viewColumn: vscode.ViewColumn.One,
            preserveFocus: false,
            preview: false,
          });
        } else {
          vscode.window.showInformationMessage(
            `Source file not found for program: ${programName.toUpperCase()}`,
          );
        }
        break;
      }

      case 'exportSvg': {
        const saveUri = await vscode.window.showSaveDialog({
          filters: { 'SVG Files': ['svg'], 'All Files': ['*'] },
          defaultUri: vscode.Uri.file(this.state.filePath.replace(/\.\w+$/, '.svg')),
        });
        if (saveUri && msg.svgContent) {
          const fs = await import('fs');
          fs.writeFileSync(saveUri.fsPath, msg.svgContent, 'utf-8');
          vscode.window.showInformationMessage(`Diagram exported to ${saveUri.fsPath}`);
        }
        break;
      }
    }
  }

  private render() {
    const { content, ext, currentType, currentSectionId, currentDirection } = this.state;
    const direction = currentDirection === 'TD' ? undefined : currentDirection;
    const result = generateDiagramFromContent(
      content,
      ext,
      currentType as any,
      currentSectionId,
      direction,
    );

    // Screen layout: render as interactive SVG terminal emulator
    if (
      result.success &&
      result.metadata?.format === 'ascii' &&
      result.metadata?.screenFields &&
      result.metadata?.screen
    ) {
      this.panel.webview.html = this.getScreenLayoutHtml(
        result.metadata.screen,
        result.metadata.screenFields,
      );
      return;
    }

    const mermaidCode = result.success
      ? this.extractMermaid(result.content)
      : `graph TD\n  ERR["${result.content.replace(/"/g, "'").slice(0, 80)}"]`;

    // Use nodeLines from metadata (built from DiagramNode.startLine)
    const nodeLineMap: Record<string, number> =
      (result.metadata?.nodeLines as Record<string, number>) ?? {};
    // Use nodeFiles from metadata (external program references)
    const nodeFileMap: Record<string, string> =
      (result.metadata?.nodeFiles as Record<string, string>) ?? {};

    this.panel.webview.html = this.getHtml(mermaidCode, nodeLineMap, nodeFileMap);
  }

  private extractMermaid(markdown: string): string {
    const match = markdown.match(/```mermaid\s*\n([\s\S]*?)```/);
    if (match) return match[1].trim();
    if (
      markdown.includes('graph ') ||
      markdown.includes('flowchart ') ||
      markdown.includes('classDiagram')
    ) {
      return markdown;
    }
    return `graph TD\n  OUT["Output rendered as text"]`;
  }

  private getHtml(
    mermaidCode: string,
    nodeLineMap: Record<string, number>,
    nodeFileMap: Record<string, string>,
  ): string {
    const {
      availableTypes,
      currentType,
      sections,
      currentSectionId,
      currentDirection,
      currentZoom,
    } = this.state;

    const nodeLineMapJson = JSON.stringify(nodeLineMap);
    const nodeFileMapJson = JSON.stringify(nodeFileMap);
    const cspSource = this.panel.webview.cspSource;
    const mermaidUri = this.panel.webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, 'resources', 'mermaid.min.js'),
    );

    const typeOptions = availableTypes
      .map(
        (t) =>
          `<option value="${t}"${t === currentType ? ' selected' : ''}>${t.replace(/_/g, ' ')}</option>`,
      )
      .join('');

    // Section dropdown: only useful for procedure_flow/control_flow on COBOL
    const showSections =
      ['control_flow', 'procedure_flow'].includes(currentType) && sections.length > 0;
    const sectionOptions = [
      `<option value="-1"${currentSectionId === undefined ? ' selected' : ''}>All Sections</option>`,
      ...sections.map(
        (s) =>
          `<option value="${s.id}"${s.id === currentSectionId ? ' selected' : ''}>${s.name} (L${s.startLine})</option>`,
      ),
    ].join('');

    const directions = ['TD', 'LR', 'BT', 'RL'];
    const dirOptions = directions
      .map(
        (d) =>
          `<option value="${d}"${d === currentDirection ? ' selected' : ''}>${d === 'TD' ? '↓ Top-Down' : d === 'LR' ? '→ Left-Right' : d === 'BT' ? '↑ Bottom-Up' : '← Right-Left'}</option>`,
      )
      .join('');

    const zoomLevels = [50, 75, 100, 125, 150, 200];
    const zoomOptions = zoomLevels
      .map((z) => `<option value="${z}"${z === currentZoom ? ' selected' : ''}>${z}%</option>`)
      .join('');

    const sectionHtml = showSections
      ? `<div class="group"><label>Section</label><select id="section-select">${sectionOptions}</select></div>`
      : '';

    return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${cspSource} data: blob:; style-src ${cspSource} 'unsafe-inline'; script-src ${cspSource} 'unsafe-inline' 'unsafe-eval'; font-src ${cspSource} data:;">
  <title>OpenCob Diagram</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: var(--vscode-font-family, 'Segoe UI', sans-serif);
      background: var(--vscode-editor-background, #1e1e1e);
      color: var(--vscode-editor-foreground, #ccc);
      height: 100vh;
      display: flex;
      flex-direction: column;
      overflow: hidden;
    }
    .toolbar {
      display: flex;
      gap: 10px;
      padding: 6px 12px;
      background: var(--vscode-titleBar-activeBackground, #2d2d2d);
      border-bottom: 1px solid var(--vscode-panel-border, #444);
      flex-shrink: 0;
      align-items: center;
      flex-wrap: wrap;
    }
    .toolbar label {
      font-size: 11px;
      color: var(--vscode-descriptionForeground, #999);
      text-transform: uppercase;
      letter-spacing: 0.5px;
    }
    .toolbar select, .toolbar button {
      background: var(--vscode-dropdown-background, #3c3c3c);
      color: var(--vscode-dropdown-foreground, #ccc);
      border: 1px solid var(--vscode-dropdown-border, #555);
      border-radius: 3px;
      padding: 3px 6px;
      font-size: 12px;
      cursor: pointer;
    }
    .toolbar select:hover, .toolbar button:hover {
      border-color: var(--vscode-focusBorder, #007acc);
    }
    .toolbar button {
      padding: 3px 10px;
      font-weight: 500;
    }
    .toolbar .group {
      display: flex;
      align-items: center;
      gap: 4px;
    }
    .toolbar .separator {
      width: 1px;
      height: 20px;
      background: var(--vscode-panel-border, #444);
      margin: 0 4px;
    }
    .diagram-container {
      flex: 1;
      overflow: hidden;
      padding: 0;
      position: relative;
      cursor: grab;
    }
    .diagram-container.dragging { cursor: grabbing; }
    #diagram-svg {
      transform-origin: 0 0;
      position: absolute;
      top: 0;
      left: 0;
    }
    /* Make diagram nodes clickable */
    .node { cursor: pointer; }
    .node:hover rect, .node:hover polygon, .node:hover circle, .node:hover .label-container {
      filter: brightness(1.2);
      stroke: var(--vscode-focusBorder, #007acc) !important;
      stroke-width: 2.5px !important;
    }
    .status-bar {
      display: flex;
      justify-content: space-between;
      padding: 4px 12px;
      background: var(--vscode-statusBar-background, #007acc);
      color: var(--vscode-statusBar-foreground, #fff);
      font-size: 11px;
      flex-shrink: 0;
    }
    .legend {
      display: flex;
      flex-wrap: wrap;
      gap: 8px 16px;
      padding: 6px 12px;
      background: var(--vscode-editorWidget-background, #252526);
      border-bottom: 1px solid var(--vscode-panel-border, #333);
      font-size: 11px;
    }
    .legend.hidden { display: none; }
    .legend-item { display: flex; align-items: center; gap: 4px; }
    .dot { width: 12px; height: 12px; border-radius: 3px; border: 1.5px solid #666; }
  </style>
</head>
<body>
  <div class="toolbar">
    <div class="group">
      <label>Type</label>
      <select id="type-select">${typeOptions}</select>
    </div>
    ${sectionHtml}
    <div class="separator"></div>
    <div class="group">
      <label>Direction</label>
      <select id="dir-select">${dirOptions}</select>
    </div>
    <div class="group">
      <label>Zoom</label>
      <select id="zoom-select">${zoomOptions}</select>
    </div>
    <div class="separator"></div>
    <button id="btn-export" title="Export as SVG">⬇ Export</button>
    <button id="btn-fit" title="Fit to view">⊡ Fit</button>
    <button id="btn-legend" title="Toggle Legend">🎨 Legend</button>
  </div>
  <div id="legend" class="legend hidden">
    <span class="legend-item"><span class="dot" style="background:#0078d4"></span>Program/Source</span>
    <span class="legend-item"><span class="dot" style="background:#2d1f54;border-color:#9b59b6"></span>Section</span>
    <span class="legend-item"><span class="dot" style="background:#1e3040;border-color:#569cd6"></span>Paragraph</span>
    <span class="legend-item"><span class="dot" style="background:#1e3a2e;border-color:#6a9955"></span>Call/Copybook</span>
    <span class="legend-item"><span class="dot" style="background:#4d3d15;border-color:#ce9178"></span>Decision</span>
    <span class="legend-item"><span class="dot" style="background:#3d2a1e;border-color:#d7956a"></span>I/O / File</span>
    <span class="legend-item"><span class="dot" style="background:#1e3a3a;border-color:#3fb5a0"></span>Loop</span>
    <span class="legend-item"><span class="dot" style="background:#4a1e1e;border-color:#f14c4c"></span>GO TO</span>
  </div>
  <div class="diagram-container">
    <div id="diagram-svg"></div>
  </div>
  <div class="status-bar">
    <span id="status-left">Click a node to navigate to source</span>
    <span id="status-right">${this.state.filePath.split(/[\\/]/).pop()} • ${currentType.replace(/_/g, ' ')}</span>
  </div>

  <script src="${mermaidUri}"></script>
  <script>
    const vscode = acquireVsCodeApi();
    const nodeLineMap = ${nodeLineMapJson};
    const nodeFileMap = ${nodeFileMapJson};

    // Detect VS Code theme
    const isDark = document.body.classList.contains('vscode-dark') || document.body.classList.contains('vscode-high-contrast');
    const isLight = document.body.classList.contains('vscode-light');
    const mermaidTheme = isLight ? 'default' : 'dark';

    // Theme-aware node colors
    const themeVars = isDark ? {
      primaryColor: '#2d2d2d',
      primaryTextColor: '#e0e0e0',
      primaryBorderColor: '#555555',
      secondaryColor: '#37373d',
      secondaryTextColor: '#cccccc',
      secondaryBorderColor: '#569cd6',
      tertiaryColor: '#4d3d15',
      tertiaryTextColor: '#dcdcaa',
      tertiaryBorderColor: '#ce9178',
      lineColor: '#6a9955',
      noteTextColor: '#d4d4d4',
      noteBkgColor: '#2d2d2d',
    } : {
      primaryColor: '#f8fafc',
      primaryTextColor: '#1e293b',
      primaryBorderColor: '#cbd5e1',
      secondaryColor: '#f1f5f9',
      secondaryTextColor: '#334155',
      secondaryBorderColor: '#64748b',
      tertiaryColor: '#fef3c7',
      tertiaryTextColor: '#92400e',
      tertiaryBorderColor: '#f59e0b',
      lineColor: '#16a34a',
      noteTextColor: '#1e293b',
      noteBkgColor: '#f8fafc',
    };

    if (typeof mermaid === 'undefined') {
      document.getElementById('diagram-svg').innerHTML =
        '<pre style="color:#f88;padding:20px;white-space:pre-wrap;">OpenCob: mermaid.js failed to load from the extension resources.</pre>';
    } else {
    mermaid.initialize({
      startOnLoad: false,
      theme: 'base',
      themeVariables: themeVars,
      securityLevel: 'loose',
      flowchart: { htmlLabels: true, curve: 'basis', padding: 12 },
    });
    }

    let currentZoom = ${currentZoom};
    let panX = 20, panY = 20;
    let isDragging = false, dragStartX = 0, dragStartY = 0, startPanX = 0, startPanY = 0;
    const svgContainer = document.getElementById('diagram-svg');
    const container = document.querySelector('.diagram-container');

    function applyTransform() {
      svgContainer.style.transform = 'translate(' + panX + 'px, ' + panY + 'px) scale(' + (currentZoom / 100) + ')';
    }

    function fitToView() {
      const svg = svgContainer.querySelector('svg');
      if (!svg) return;
      const box = svg.getBBox ? svg.getBBox() : { width: svg.scrollWidth, height: svg.scrollHeight };
      const cW = container.clientWidth - 40;
      const cH = container.clientHeight - 40;
      const fitZoom = Math.min(cW / (box.width || 800), cH / (box.height || 600), 2) * 100;
      currentZoom = Math.max(20, Math.round(fitZoom / 5) * 5);
      panX = 20;
      panY = 20;
      applyTransform();
      const sel = document.getElementById('zoom-select');
      if (sel) sel.value = String(currentZoom);
    }

    // Mouse wheel zoom
    container.addEventListener('wheel', (e) => {
      e.preventDefault();
      const rect = container.getBoundingClientRect();
      const mouseX = e.clientX - rect.left;
      const mouseY = e.clientY - rect.top;

      const oldZoom = currentZoom;
      const delta = e.deltaY > 0 ? -10 : 10;
      currentZoom = Math.max(20, Math.min(400, currentZoom + delta));

      // Zoom toward mouse position
      const scale = currentZoom / oldZoom;
      panX = mouseX - scale * (mouseX - panX);
      panY = mouseY - scale * (mouseY - panY);

      applyTransform();
      // Update zoom dropdown to closest value
      const sel = document.getElementById('zoom-select');
      const closest = [...sel.options].reduce((prev, opt) =>
        Math.abs(parseInt(opt.value) - currentZoom) < Math.abs(parseInt(prev.value) - currentZoom) ? opt : prev
      );
      sel.value = closest.value;
    }, { passive: false });

    // Mouse drag to pan
    container.addEventListener('mousedown', (e) => {
      if (e.target.closest('.node')) return; // Don't pan when clicking nodes
      isDragging = true;
      dragStartX = e.clientX;
      dragStartY = e.clientY;
      startPanX = panX;
      startPanY = panY;
      container.classList.add('dragging');
    });
    document.addEventListener('mousemove', (e) => {
      if (!isDragging) return;
      panX = startPanX + (e.clientX - dragStartX);
      panY = startPanY + (e.clientY - dragStartY);
      applyTransform();
    });
    document.addEventListener('mouseup', () => {
      isDragging = false;
      container.classList.remove('dragging');
    });

    async function renderDiagram() {
      const code = ${JSON.stringify(mermaidCode)};
      try {
        const { svg } = await mermaid.render('diagramSvg', code);
        svgContainer.innerHTML = svg;
        applyTransform();

        // Attach click handlers to ALL .node groups
        svgContainer.querySelectorAll('.node').forEach(node => {
          node.style.cursor = 'pointer';
          node.addEventListener('click', (e) => {
            e.stopPropagation();
            let nodeId = '';

            // Walk up to find the g.node with an id attribute
            let el = node;
            const idAttr = el.id || '';
            // Mermaid v11: nodes have id like "flowchart-cl5-123" or "flowchart-p0-456"
            const idMatch = idAttr.match(/flowchart-(\\w+)-\\d+/);
            if (idMatch) {
              nodeId = idMatch[1];
            } else if (idAttr.match(/^[a-z]+\\d+$/)) {
              nodeId = idAttr;
            }

            // Also check data-id attribute (some Mermaid versions)
            if (!nodeId) {
              const dataId = el.getAttribute('data-id');
              if (dataId) nodeId = dataId;
            }

            const label = el.querySelector('.nodeLabel')?.textContent?.trim()
              || el.querySelector('span')?.textContent?.trim()
              || el.querySelector('foreignObject')?.textContent?.trim()
              || '';

            // Priority 1: cross-file navigation (external program references)
            const fileProg = nodeFileMap[nodeId];
            if (fileProg) {
              document.getElementById('status-left').textContent = '⟶ Opening ' + fileProg + '...';
              vscode.postMessage({ command: 'navigateToFile', programName: fileProg });
              return;
            }

            // Priority 2: line navigation within current file
            let line = nodeLineMap[nodeId] || 0;

            if (line > 0) {
              document.getElementById('status-left').textContent = '→ Line ' + line + ': ' + label.slice(0, 50);
              vscode.postMessage({ command: 'navigateToLine', line: line });
            } else {
              document.getElementById('status-left').textContent = 'No mapping: ' + (nodeId || label).slice(0, 40);
            }
          });
        });

        // Auto-fit to the viewport on first render so the diagram is visible
        // immediately without needing to click "Fit".
        requestAnimationFrame(function() { fitToView(); });
      } catch (e) {
        svgContainer.innerHTML = '<pre style="color:#f88;padding:20px;">Render error: ' + e.message + '</pre>';
      }
    }

    renderDiagram();

    // Toolbar handlers
    document.getElementById('type-select').addEventListener('change', (e) => {
      vscode.postMessage({ command: 'switchType', type: e.target.value });
    });
    const secSelect = document.getElementById('section-select');
    if (secSelect) {
      secSelect.addEventListener('change', (e) => {
        vscode.postMessage({ command: 'switchSection', sectionId: parseInt(e.target.value) });
      });
    }
    document.getElementById('dir-select').addEventListener('change', (e) => {
      vscode.postMessage({ command: 'switchDirection', direction: e.target.value });
    });
    document.getElementById('zoom-select').addEventListener('change', (e) => {
      currentZoom = parseInt(e.target.value);
      applyTransform();
      vscode.postMessage({ command: 'switchZoom', zoom: currentZoom });
    });
    document.getElementById('btn-fit').addEventListener('click', () => {
      fitToView();
    });
    document.getElementById('btn-export').addEventListener('click', () => {
      const svg = svgContainer.querySelector('svg');
      if (svg) {
        vscode.postMessage({ command: 'exportSvg', svgContent: svg.outerHTML });
      }
    });
    document.getElementById('btn-legend').addEventListener('click', () => {
      document.getElementById('legend').classList.toggle('hidden');
    });
  </script>
</body>
</html>`;
  }

  /**
   * Render 5250/3270 screen layout as interactive SVG terminal emulator.
   * Ported from DriverX DiagramPanel.tsx screen renderer.
   */
  private getScreenLayoutHtml(
    screen: {
      rows?: number;
      cols?: number;
      title?: string;
      platform?: string;
      funcKeys?: string[];
    },
    fields: Array<{
      id: string;
      label?: string;
      displayLabel?: string;
      type?: string;
      row?: number;
      col?: number;
      length?: number;
      usage?: string;
      alias?: string;
      initial?: string;
      startLine?: number;
    }>,
  ): string {
    const { availableTypes, currentType, currentZoom } = this.state;

    const typeOptions = availableTypes
      .map(
        (t) =>
          `<option value="${t}"${t === currentType ? ' selected' : ''}>${t.replace(/_/g, ' ')}</option>`,
      )
      .join('');

    const screenJson = JSON.stringify(screen);
    const fieldsJson = JSON.stringify(fields);

    return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>OpenCob Screen Layout</title>
  <style>
    @import url('https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500;600&display=swap');
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: 'IBM Plex Mono', 'Courier New', monospace;
      background: var(--vscode-editor-background, #1e1e1e);
      color: var(--vscode-editor-foreground, #ccc);
      height: 100vh;
      display: flex;
      flex-direction: column;
      overflow: hidden;
    }
    .toolbar {
      display: flex;
      gap: 10px;
      padding: 6px 12px;
      background: var(--vscode-titleBar-activeBackground, #1a1a2e);
      border-bottom: 1px solid var(--vscode-panel-border, #333);
      flex-shrink: 0;
      align-items: center;
      flex-wrap: wrap;
    }
    .toolbar label {
      font-size: 11px;
      color: var(--vscode-descriptionForeground, #888);
      text-transform: uppercase;
      letter-spacing: 0.5px;
    }
    .toolbar select, .toolbar button {
      background: var(--vscode-dropdown-background, #2d2d3d);
      color: var(--vscode-dropdown-foreground, #ccc);
      border: 1px solid var(--vscode-dropdown-border, #444);
      border-radius: 3px;
      padding: 3px 6px;
      font-size: 12px;
      cursor: pointer;
      font-family: inherit;
    }
    .toolbar select:hover, .toolbar button:hover {
      border-color: var(--vscode-focusBorder, #4ade80);
    }
    .toolbar button { padding: 3px 10px; font-weight: 500; }
    .toolbar .group { display: flex; align-items: center; gap: 4px; }
    .toolbar .separator { width: 1px; height: 20px; background: #333; margin: 0 4px; }
    .toolbar .badge {
      background: #1e3a5f;
      color: #38bdf8;
      font-size: 10px;
      padding: 2px 6px;
      border-radius: 3px;
      border: 1px solid #0ea5e9;
    }
    .toolbar .info {
      font-size: 11px;
      color: #6b7280;
    }
    .canvas-wrap {
      flex: 1;
      overflow: hidden;
      position: relative;
      cursor: grab;
      background: #050510;
    }
    .canvas-wrap.dragging { cursor: grabbing; }
    #screen-svg {
      position: absolute;
      top: 0;
      left: 0;
      transform-origin: 0 0;
    }
    .status-bar {
      display: flex;
      justify-content: space-between;
      padding: 4px 12px;
      background: #0c1222;
      border-top: 1px solid #1e3a5f;
      color: #4ade80;
      font-size: 11px;
      flex-shrink: 0;
    }
    .tooltip {
      position: absolute;
      background: #1a1a2e;
      border: 1px solid #334155;
      border-radius: 4px;
      padding: 8px 10px;
      font-size: 11px;
      color: #e2e8f0;
      pointer-events: none;
      z-index: 100;
      white-space: pre;
      box-shadow: 0 4px 12px rgba(0,0,0,0.5);
      max-width: 300px;
    }
    .tooltip .tt-type { color: #6b7280; font-size: 10px; text-transform: uppercase; }
    .tooltip .tt-name { color: #4ade80; font-weight: 600; }
    .tooltip .tt-detail { color: #94a3b8; }
  </style>
</head>
<body>
  <div class="toolbar">
    <div class="group">
      <label>Type</label>
      <select id="type-select">${typeOptions}</select>
    </div>
    <div class="separator"></div>
    <span class="badge">${screen.platform ?? '5250'}</span>
    <span class="info">${screen.rows ?? 24}×${screen.cols ?? 80}</span>
    <span class="info">·</span>
    <span class="info">${fields.filter((f) => f.type !== 'constant').length} fields</span>
    <span class="info">·</span>
    <span class="info">${fields.filter((f) => f.type === 'constant').length} labels</span>
    <div class="separator"></div>
    <button id="btn-fit" title="Fit to view">⊡ Fit</button>
    <button id="btn-reset" title="Reset zoom">1:1</button>
    <button id="btn-export" title="Export SVG">⬇ Export</button>
  </div>

  <div class="canvas-wrap" id="canvas">
    <svg id="screen-svg"></svg>
  </div>

  <div class="tooltip" id="tooltip" style="display:none"></div>

  <div class="status-bar">
    <span id="status-left">Hover a field to inspect · Click to jump to source line</span>
    <span id="status-right">${this.state.filePath.split(/[\\/]/).pop()} · ${screen.title ?? ''}</span>
  </div>

  <script>
    const vscode = acquireVsCodeApi();
    const screen = ${screenJson};
    const fields = ${fieldsJson};

    const CELL_W = 9.6;
    const CELL_H = 20;
    const PAD = 28;
    const TITLE_H = 32;
    const FKEY_H = 24;

    const ROWS = screen.rows || 24;
    const COLS = screen.cols || 80;
    const svgW = COLS * CELL_W + PAD * 2;
    const svgH = ROWS * CELL_H + PAD * 2 + TITLE_H + FKEY_H;

    const svg = document.getElementById('screen-svg');
    const canvas = document.getElementById('canvas');
    const tooltip = document.getElementById('tooltip');

    let zoom = ${currentZoom / 100};
    let panX = 0, panY = 0;
    let isDragging = false, dragStartX = 0, dragStartY = 0, startPanX = 0, startPanY = 0;
    let didDrag = false;

    function applyTransform() {
      svg.style.transform = 'translate(' + panX + 'px,' + panY + 'px) scale(' + zoom + ')';
    }

    function buildSvg() {
      let s = '';
      // Namespace and viewBox
      svg.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
      svg.setAttribute('width', String(svgW * zoom));
      svg.setAttribute('height', String(svgH * zoom));
      svg.setAttribute('viewBox', '0 0 ' + svgW + ' ' + svgH);

      // Terminal background
      s += '<rect width="' + svgW + '" height="' + svgH + '" rx="8" fill="#0a0a0a"/>';

      // Title bar
      s += '<rect x="0" y="0" width="' + svgW + '" height="28" rx="8" fill="#1a1a2e"/>';
      s += '<rect x="0" y="22" width="' + svgW + '" height="6" fill="#1a1a2e"/>';
      // Window dots
      s += '<circle cx="14" cy="14" r="5" fill="#ef4444" opacity="0.8"/>';
      s += '<circle cx="30" cy="14" r="5" fill="#eab308" opacity="0.8"/>';
      s += '<circle cx="46" cy="14" r="5" fill="#22c55e" opacity="0.8"/>';
      // Title text
      const titleText = (screen.title || 'SCREEN').toUpperCase() + ' \\u2014 ' + (screen.platform || '5250') + ' Display';
      s += '<text x="' + (svgW/2) + '" y="18" text-anchor="middle" font-size="12" font-weight="700" fill="#4ade80" font-family="\\'IBM Plex Mono\\', \\'Courier New\\', monospace">' + escXml(titleText) + '</text>';

      // Screen area background
      const areaX = PAD - 4;
      const areaY = PAD + TITLE_H - 8;
      const areaW = COLS * CELL_W + 8;
      const areaH = ROWS * CELL_H + 8;
      s += '<rect x="' + areaX + '" y="' + areaY + '" width="' + areaW + '" height="' + areaH + '" rx="2" fill="#0c1222" stroke="#1e3a5f" stroke-width="1"/>';

      // Row numbers
      for (let r = 0; r < ROWS; r++) {
        const y = PAD + TITLE_H + r * CELL_H + CELL_H / 2 + 4;
        s += '<text x="' + (PAD - 8) + '" y="' + y + '" text-anchor="end" font-size="7" fill="#334155" font-family="\\'IBM Plex Mono\\', \\'Courier New\\', monospace">' + (r+1) + '</text>';
      }

      // Column ruler every 10
      for (let c = 0; c < Math.floor(COLS/10); c++) {
        const x = PAD + (c+1) * 10 * CELL_W;
        s += '<text x="' + x + '" y="' + (PAD + TITLE_H - 12) + '" text-anchor="middle" font-size="7" fill="#334155" font-family="\\'IBM Plex Mono\\', \\'Courier New\\', monospace">' + ((c+1)*10) + '</text>';
      }

      // Grid lines (subtle)
      for (let r = 0; r <= ROWS; r++) {
        const y = PAD + TITLE_H + r * CELL_H;
        s += '<line x1="' + PAD + '" y1="' + y + '" x2="' + (PAD + COLS * CELL_W) + '" y2="' + y + '" stroke="#1a2332" stroke-width="0.3"/>';
      }

      // Render fields by type (constants first, then output, then input on top)
      const constants = fields.filter(f => f.type === 'constant');
      const outputs = fields.filter(f => f.type === 'output');
      const inputs = fields.filter(f => f.type === 'input');

      // Constants — green labels
      for (const f of constants) {
        if (!f.row || !f.col) continue;
        const fx = PAD + (f.col - 1) * CELL_W;
        const fy = PAD + TITLE_H + (f.row - 1) * CELL_H;
        const fw = (f.length || 1) * CELL_W;
        const text = (f.displayLabel || f.initial || f.label || '').slice(0, f.length || 10);
        s += '<g class="field" data-id="' + f.id + '" data-type="constant" data-label="' + escAttr(f.label || '') + '" data-row="' + f.row + '" data-col="' + f.col + '" data-length="' + (f.length||1) + '" data-line="' + (f.startLine||0) + '" data-display="' + escAttr(text) + '">';
        s += '<rect x="' + fx + '" y="' + (fy+2) + '" width="' + fw + '" height="' + (CELL_H-4) + '" rx="2" fill="#111827" stroke="#1e293b" stroke-width="0.5" class="field-bg"/>';
        s += '<text x="' + (fx+2) + '" y="' + (fy + CELL_H/2 + 4) + '" font-size="10" fill="#22c55e" font-weight="500" font-family="\\'IBM Plex Mono\\', \\'Courier New\\', monospace">' + escXml(text) + '</text>';
        s += '</g>';
      }

      // Output fields — bright green
      for (const f of outputs) {
        if (!f.row || !f.col) continue;
        const fx = PAD + (f.col - 1) * CELL_W;
        const fy = PAD + TITLE_H + (f.row - 1) * CELL_H;
        const fw = (f.length || 1) * CELL_W;
        const primary = f.displayLabel || f.alias || f.label || '';
        const text = primary.length > (f.length || 10) ? primary.slice(0, (f.length||10)-1) + '\\u2026' : primary;
        s += '<g class="field" data-id="' + f.id + '" data-type="output" data-label="' + escAttr(f.label || '') + '" data-alias="' + escAttr(f.alias || '') + '" data-row="' + f.row + '" data-col="' + f.col + '" data-length="' + (f.length||1) + '" data-line="' + (f.startLine||0) + '" data-display="' + escAttr(text) + '">';
        s += '<rect x="' + fx + '" y="' + (fy+1) + '" width="' + fw + '" height="' + (CELL_H-2) + '" rx="2" fill="#0c1222" stroke="#166534" stroke-width="0.6" class="field-bg"/>';
        s += '<text x="' + (fx+2) + '" y="' + (fy + CELL_H/2 + 4) + '" font-size="11" fill="#4ade80" font-weight="500" font-family="\\'IBM Plex Mono\\', \\'Courier New\\', monospace">' + escXml(text) + '</text>';
        // DDS field name above
        if (f.alias) {
          s += '<text x="' + (fx+2) + '" y="' + (fy-1) + '" font-size="7" fill="#475569" font-family="\\'IBM Plex Mono\\', \\'Courier New\\', monospace">' + escXml(f.label || '') + '</text>';
        }
        s += '</g>';
      }

      // Input fields — cyan with underscores
      for (const f of inputs) {
        if (!f.row || !f.col) continue;
        const fx = PAD + (f.col - 1) * CELL_W;
        const fy = PAD + TITLE_H + (f.row - 1) * CELL_H;
        const fw = (f.length || 1) * CELL_W;
        const underscores = '_'.repeat(Math.min(f.length || 1, 20));
        const fieldLabel = f.displayLabel || f.alias || f.label || '';
        s += '<g class="field" data-id="' + f.id + '" data-type="input" data-label="' + escAttr(f.label || '') + '" data-alias="' + escAttr(f.alias || '') + '" data-row="' + f.row + '" data-col="' + f.col + '" data-length="' + (f.length||1) + '" data-usage="' + (f.usage||'') + '" data-line="' + (f.startLine||0) + '" data-display="' + escAttr(fieldLabel) + '">';
        s += '<rect x="' + fx + '" y="' + (fy+1) + '" width="' + fw + '" height="' + (CELL_H-2) + '" rx="2" fill="#0f172a" stroke="#0ea5e9" stroke-width="1" class="field-bg"/>';
        // Underscore pattern
        s += '<text x="' + (fx+1) + '" y="' + (fy + CELL_H/2 + 4) + '" font-size="10" fill="#0ea5e9" opacity="0.3" font-family="\\'IBM Plex Mono\\', \\'Courier New\\', monospace">' + underscores + '</text>';
        // Field label above
        s += '<text x="' + (fx+2) + '" y="' + (fy-1) + '" font-size="8" fill="#38bdf8" font-weight="600" font-family="\\'IBM Plex Mono\\', \\'Courier New\\', monospace">' + escXml(fieldLabel) + '</text>';
        // DDS name inside if alias differs
        if (f.alias && f.alias !== f.label) {
          s += '<text x="' + (fx+2) + '" y="' + (fy + CELL_H/2 + 4) + '" font-size="9" fill="#64748b" font-family="\\'IBM Plex Mono\\', \\'Courier New\\', monospace">' + escXml(f.label || '') + '</text>';
        }
        s += '</g>';
      }

      // Function key bar
      const funcKeys = screen.funcKeys || [];
      if (funcKeys.length > 0) {
        const fkY = PAD + TITLE_H + ROWS * CELL_H + 12;
        s += '<rect x="' + areaX + '" y="' + fkY + '" width="' + areaW + '" height="18" rx="2" fill="#111827" stroke="#1e293b" stroke-width="0.5"/>';
        s += '<text x="' + PAD + '" y="' + (fkY + 13) + '" font-size="9" fill="#6b7280" font-family="\\'IBM Plex Mono\\', \\'Courier New\\', monospace">' + escXml(funcKeys.join('  ')) + '</text>';
      }

      svg.innerHTML = s;
    }

    function escXml(str) { return str.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
    function escAttr(str) { return str.replace(/&/g,'&amp;').replace(/"/g,'&quot;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }

    buildSvg();
    applyTransform();

    // Fit to view on load
    setTimeout(() => {
      const rect = canvas.getBoundingClientRect();
      const scaleX = rect.width / svgW;
      const scaleY = rect.height / svgH;
      zoom = Math.min(scaleX, scaleY, 2) * 0.92;
      panX = (rect.width - svgW * zoom) / 2;
      panY = (rect.height - svgH * zoom) / 2;
      applyTransform();
    }, 50);

    // Mouse wheel zoom
    canvas.addEventListener('wheel', (e) => {
      e.preventDefault();
      const rect = canvas.getBoundingClientRect();
      const mx = e.clientX - rect.left;
      const my = e.clientY - rect.top;
      const oldZoom = zoom;
      const delta = e.deltaY > 0 ? 0.92 : 1.08;
      zoom = Math.max(0.2, Math.min(4, zoom * delta));
      // Zoom toward mouse
      panX = mx - (zoom / oldZoom) * (mx - panX);
      panY = my - (zoom / oldZoom) * (my - panY);
      applyTransform();
    }, { passive: false });

    // Pan via drag
    canvas.addEventListener('mousedown', (e) => {
      if (e.target.closest('.field')) return;
      isDragging = true;
      didDrag = false;
      dragStartX = e.clientX;
      dragStartY = e.clientY;
      startPanX = panX;
      startPanY = panY;
      canvas.classList.add('dragging');
    });
    document.addEventListener('mousemove', (e) => {
      if (!isDragging) return;
      const dx = e.clientX - dragStartX;
      const dy = e.clientY - dragStartY;
      if (Math.abs(dx) > 3 || Math.abs(dy) > 3) didDrag = true;
      if (didDrag) {
        panX = startPanX + dx;
        panY = startPanY + dy;
        applyTransform();
      }
    });
    document.addEventListener('mouseup', () => {
      isDragging = false;
      canvas.classList.remove('dragging');
    });

    // Field hover — tooltip
    svg.addEventListener('mouseover', (e) => {
      const field = e.target.closest('.field');
      if (!field) return;
      const bg = field.querySelector('.field-bg');
      if (bg) {
        bg.setAttribute('data-orig-stroke', bg.getAttribute('stroke'));
        bg.setAttribute('stroke', '#4ade80');
        bg.setAttribute('stroke-width', '1.5');
      }
      const type = field.dataset.type;
      const label = field.dataset.label;
      const alias = field.dataset.alias;
      const row = field.dataset.row;
      const col = field.dataset.col;
      const len = field.dataset.length;
      const line = field.dataset.line;
      const display = field.dataset.display;
      const usage = field.dataset.usage;

      let html = '<div class="tt-type">' + (type || '').toUpperCase() + '</div>';
      html += '<div class="tt-name">' + escXml(label || '') + '</div>';
      if (alias) html += '<div class="tt-detail">Alias: ' + escXml(alias) + '</div>';
      if (display && display !== label) html += '<div class="tt-detail">Display: ' + escXml(display) + '</div>';
      html += '<div class="tt-detail">Row ' + row + ', Col ' + col + ', Len ' + len + '</div>';
      if (usage) html += '<div class="tt-detail">Usage: ' + usage + '</div>';
      if (line && line !== '0') html += '<div class="tt-detail" style="color:#4ade80">Line ' + line + ' — click to jump</div>';
      tooltip.innerHTML = html;
      tooltip.style.display = 'block';

      const rect = canvas.getBoundingClientRect();
      tooltip.style.left = (e.clientX - rect.left + 14) + 'px';
      tooltip.style.top = (e.clientY - rect.top + 14) + 'px';
    });

    svg.addEventListener('mousemove', (e) => {
      if (tooltip.style.display === 'block') {
        const rect = canvas.getBoundingClientRect();
        tooltip.style.left = (e.clientX - rect.left + 14) + 'px';
        tooltip.style.top = (e.clientY - rect.top + 14) + 'px';
      }
    });

    svg.addEventListener('mouseout', (e) => {
      const field = e.target.closest('.field');
      if (!field) return;
      const bg = field.querySelector('.field-bg');
      if (bg) {
        bg.setAttribute('stroke', bg.getAttribute('data-orig-stroke') || '#333');
        const type = field.dataset.type;
        bg.setAttribute('stroke-width', type === 'input' ? '1' : '0.6');
      }
      tooltip.style.display = 'none';
    });

    // Field click — navigate to source line
    svg.addEventListener('click', (e) => {
      if (didDrag) return;
      const field = e.target.closest('.field');
      if (!field) return;
      const line = parseInt(field.dataset.line || '0');
      if (line > 0) {
        document.getElementById('status-left').textContent = '\\u2192 Jumping to line ' + line + '...';
        vscode.postMessage({ command: 'navigateToLine', line: line });
      }
    });

    // Toolbar
    document.getElementById('type-select').addEventListener('change', (e) => {
      vscode.postMessage({ command: 'switchType', type: e.target.value });
    });
    document.getElementById('btn-fit').addEventListener('click', () => {
      const rect = canvas.getBoundingClientRect();
      const scaleX = rect.width / svgW;
      const scaleY = rect.height / svgH;
      zoom = Math.min(scaleX, scaleY, 2) * 0.92;
      panX = (rect.width - svgW * zoom) / 2;
      panY = (rect.height - svgH * zoom) / 2;
      applyTransform();
    });
    document.getElementById('btn-reset').addEventListener('click', () => {
      zoom = 1; panX = 0; panY = 0;
      applyTransform();
    });
    document.getElementById('btn-export').addEventListener('click', () => {
      vscode.postMessage({ command: 'exportSvg', svgContent: svg.outerHTML });
    });
  </script>
</body>
</html>`;
  }

  private dispose() {
    DiagramPanel.instance = undefined;
    for (const d of this.disposables) d.dispose();
    this.disposables = [];
  }
}
