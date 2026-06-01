import * as vscode from 'vscode';
import {
  generateDiagramFromContent,
  getAvailableDiagramsFromContent,
  getSectionsFromContent,
} from '@opencob/core';

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
  private disposables: vscode.Disposable[] = [];

  private constructor(panel: vscode.WebviewPanel, state: DiagramState) {
    this.panel = panel;
    this.state = state;

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
      },
    );

    DiagramPanel.instance = new DiagramPanel(panel, state);
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

  <script src="https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.min.js"></script>
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

    mermaid.initialize({
      startOnLoad: false,
      theme: 'base',
      themeVariables: themeVars,
      securityLevel: 'loose',
      flowchart: { htmlLabels: true, curve: 'basis', padding: 12 },
    });

    let currentZoom = ${currentZoom};
    let panX = 20, panY = 20;
    let isDragging = false, dragStartX = 0, dragStartY = 0, startPanX = 0, startPanY = 0;
    const svgContainer = document.getElementById('diagram-svg');
    const container = document.querySelector('.diagram-container');

    function applyTransform() {
      svgContainer.style.transform = 'translate(' + panX + 'px, ' + panY + 'px) scale(' + (currentZoom / 100) + ')';
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
      const svg = svgContainer.querySelector('svg');
      if (!svg) return;
      const svgRect = svg.getBBox ? svg.getBBox() : { width: svg.scrollWidth, height: svg.scrollHeight };
      const cW = container.clientWidth - 40;
      const cH = container.clientHeight - 40;
      const fitZoom = Math.min(cW / (svgRect.width || 800), cH / (svgRect.height || 600), 2) * 100;
      currentZoom = Math.round(fitZoom / 5) * 5;
      panX = 20;
      panY = 20;
      applyTransform();
      document.getElementById('zoom-select').value = String(currentZoom);
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

  private dispose() {
    DiagramPanel.instance = undefined;
    for (const d of this.disposables) d.dispose();
    this.disposables = [];
  }
}
