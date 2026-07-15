import * as vscode from 'vscode';
import * as path from 'path';

export function openSamplesCommand(context: vscode.ExtensionContext): void {
  const samplesPath = path.join(context.extensionUri.fsPath, 'resources', 'samples');
  const samplesUri = vscode.Uri.file(samplesPath);
  const existing = vscode.workspace.workspaceFolders ?? [];
  const alreadyAdded = existing.some((f) => f.uri.fsPath === samplesUri.fsPath);
  if (alreadyAdded) {
    vscode.window.showInformationMessage('OpenCob sample files are already in your workspace.');
    return;
  }
  vscode.workspace.updateWorkspaceFolders(existing.length, 0, {
    uri: samplesUri,
    name: 'OpenCob Samples',
  });
  vscode.window.showInformationMessage(
    'OpenCob sample files added to workspace. Open any file to try diagram generation.',
  );
}
