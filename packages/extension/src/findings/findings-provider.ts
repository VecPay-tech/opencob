import * as vscode from 'vscode';

export interface Finding {
  id: string;
  file: string;
  line: number;
  severity: 'error' | 'warning' | 'info';
  type: string;
  message: string;
  details?: string;
  suggestion?: string;
  timestamp: number;
}

export class FindingNode extends vscode.TreeItem {
  constructor(
    public readonly finding: Finding,
    public readonly collapsibleState?: vscode.TreeItemCollapsibleState,
  ) {
    super(finding.message, collapsibleState);
    this.id = finding.id;
    this.description = `${finding.file}:${finding.line}`;
    this.iconPath = this.getSeverityIcon();
    this.command = {
      command: 'opencob.openFinding',
      title: 'Open Finding',
      arguments: [finding],
    };
  }

  private getSeverityIcon(): vscode.ThemeIcon {
    switch (this.finding.severity) {
      case 'error':
        return new vscode.ThemeIcon('error');
      case 'warning':
        return new vscode.ThemeIcon('warning');
      case 'info':
      default:
        return new vscode.ThemeIcon('info');
    }
  }
}

export class FindingDetailNode extends vscode.TreeItem {
  constructor(label: string, value: string) {
    super(`${label}: ${value}`);
    this.collapsibleState = vscode.TreeItemCollapsibleState.None;
    this.tooltip = value;
  }
}

/**
 * TreeDataProvider for findings discovered by the workspace scanner
 */
export class FindingsProvider implements vscode.TreeDataProvider<vscode.TreeItem> {
  private _onDidChangeTreeData: vscode.EventEmitter<vscode.TreeItem | undefined | null | void> =
    new vscode.EventEmitter<vscode.TreeItem | undefined | null | void>();
  readonly onDidChangeTreeData: vscode.Event<vscode.TreeItem | undefined | null | void> =
    this._onDidChangeTreeData.event;

  private findings: Map<string, Finding> = new Map();
  private groupedByFile: Map<string, Finding[]> = new Map();
  private groupedBySeverity: Map<string, Finding[]> = new Map();
  private viewMode: 'file' | 'severity' = 'file';

  constructor(private context: vscode.ExtensionContext) {}

  /**
   * Add findings and refresh the tree
   */
  addFindings(findings: Finding[]): void {
    for (const finding of findings) {
      this.findings.set(finding.id, finding);
    }
    this.rebuildIndex();
    this._onDidChangeTreeData.fire(null);
  }

  /**
   * Clear all findings
   */
  clear(): void {
    this.findings.clear();
    this.rebuildIndex();
    this._onDidChangeTreeData.fire(null);
  }

  /**
   * Set view mode (file or severity grouping)
   */
  setViewMode(mode: 'file' | 'severity'): void {
    this.viewMode = mode;
    this._onDidChangeTreeData.fire(null);
  }

  /**
   * Get total number of findings
   */
  getCount(): { total: number; errors: number; warnings: number; infos: number } {
    let errors = 0;
    let warnings = 0;
    let infos = 0;

    for (const finding of this.findings.values()) {
      if (finding.severity === 'error') errors++;
      else if (finding.severity === 'warning') warnings++;
      else infos++;
    }

    return {
      total: this.findings.size,
      errors,
      warnings,
      infos,
    };
  }

  getTreeItem(element: vscode.TreeItem): vscode.TreeItem | Thenable<vscode.TreeItem> {
    return element;
  }

  async getChildren(element?: vscode.TreeItem): Promise<vscode.TreeItem[]> {
    if (!element) {
      // Root level: show stats or group headers
      return this.getRootChildren();
    }

    // If this is a finding node, show details
    if (element instanceof FindingNode) {
      return this.getDetailChildren(element.finding);
    }

    // If this is a group node (file or severity), show findings
    if (element instanceof vscode.TreeItem && element.id?.startsWith('group-')) {
      return this.getGroupChildren(element.id);
    }

    return [];
  }

  private getRootChildren(): vscode.TreeItem[] {
    if (this.findings.size === 0) {
      const empty = new vscode.TreeItem('No findings detected');
      empty.collapsibleState = vscode.TreeItemCollapsibleState.None;
      return [empty];
    }

    if (this.viewMode === 'file') {
      return Array.from(this.groupedByFile.entries())
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([file, findings]) => {
          const item = new vscode.TreeItem(file, vscode.TreeItemCollapsibleState.Expanded);
          item.id = `group-file-${file}`;
          item.iconPath = new vscode.ThemeIcon('file');
          item.description = `${findings.length} findings`;
          return item;
        });
    } else {
      // Group by severity
      const severityOrder: Array<'error' | 'warning' | 'info'> = ['error', 'warning', 'info'];
      return severityOrder
        .filter((severity) => this.groupedBySeverity.has(severity))
        .map((severity) => {
          const findings = this.groupedBySeverity.get(severity) || [];
          const item = new vscode.TreeItem(
            `${severity.charAt(0).toUpperCase() + severity.slice(1)}s`,
            vscode.TreeItemCollapsibleState.Expanded,
          );
          item.id = `group-severity-${severity}`;
          item.description = `${findings.length} findings`;
          item.iconPath =
            severity === 'error'
              ? new vscode.ThemeIcon('error')
              : severity === 'warning'
                ? new vscode.ThemeIcon('warning')
                : new vscode.ThemeIcon('info');
          return item;
        });
    }
  }

  private getGroupChildren(groupId: string): vscode.TreeItem[] {
    if (groupId.startsWith('group-file-')) {
      const file = groupId.replace('group-file-', '');
      return (this.groupedByFile.get(file) || []).map(
        (finding) => new FindingNode(finding, vscode.TreeItemCollapsibleState.Collapsed),
      );
    }

    if (groupId.startsWith('group-severity-')) {
      const severity = groupId.replace('group-severity-', '') as 'error' | 'warning' | 'info';
      return (this.groupedBySeverity.get(severity) || []).map(
        (finding) => new FindingNode(finding, vscode.TreeItemCollapsibleState.Collapsed),
      );
    }

    return [];
  }

  private getDetailChildren(finding: Finding): vscode.TreeItem[] {
    const children: vscode.TreeItem[] = [
      new FindingDetailNode('Type', finding.type),
      new FindingDetailNode('Location', `${finding.file}:${finding.line}`),
      new FindingDetailNode('Severity', finding.severity),
      new FindingDetailNode('Detected', new Date(finding.timestamp).toLocaleString()),
    ];

    if (finding.details) {
      children.push(new FindingDetailNode('Details', finding.details));
    }

    if (finding.suggestion) {
      const suggestionNode = new vscode.TreeItem(`Suggestion: ${finding.suggestion}`);
      suggestionNode.collapsibleState = vscode.TreeItemCollapsibleState.None;
      suggestionNode.tooltip = finding.suggestion;
      suggestionNode.iconPath = new vscode.ThemeIcon('lightbulb');
      children.push(suggestionNode);
    }

    return children;
  }

  private rebuildIndex(): void {
    this.groupedByFile.clear();
    this.groupedBySeverity.clear();

    for (const finding of this.findings.values()) {
      // Group by file
      if (!this.groupedByFile.has(finding.file)) {
        this.groupedByFile.set(finding.file, []);
      }
      this.groupedByFile.get(finding.file)!.push(finding);

      // Group by severity
      if (!this.groupedBySeverity.has(finding.severity)) {
        this.groupedBySeverity.set(finding.severity, []);
      }
      this.groupedBySeverity.get(finding.severity)!.push(finding);
    }

    // Sort findings within each group by line number
    for (const findings of this.groupedByFile.values()) {
      findings.sort((a, b) => a.line - b.line);
    }
  }
}
