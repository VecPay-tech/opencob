import * as vscode from 'vscode';

export const DIAGRAM_SCHEME = 'opencob-diagram';

const store = new Map<string, string>();
let seq = 0;

export const diagramContentProvider: vscode.TextDocumentContentProvider = {
  provideTextDocumentContent(uri: vscode.Uri): string {
    return store.get(uri.path) ?? '';
  },
};

/**
 * Create a read-only virtual URI for diagram Markdown content.
 * Closing the document will NOT prompt to save.
 */
export function createDiagramUri(content: string): vscode.Uri {
  const key = `/diagram-${++seq}.md`;
  store.set(key, content);
  return vscode.Uri.parse(`${DIAGRAM_SCHEME}:${key}`);
}
