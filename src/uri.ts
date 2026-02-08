import * as vscode from 'vscode';

let cachedWorkspaceRoot: string | undefined;

export async function getWorkspaceRoot() {
  if (cachedWorkspaceRoot) {
    return cachedWorkspaceRoot;
  }

  const folders = vscode.workspace.workspaceFolders;
  let mainWorkspace;

  if (folders) {
    if (folders.length > 1) {
      // if there are multiple workspaces, ask the user to select one
      mainWorkspace = await vscode.window.showWorkspaceFolderPick();
    }
    else if (folders.length === 1) {
      [ mainWorkspace ] = folders;
    }
  }

  if (!mainWorkspace) {
    throw new Error(
      'No workspace found.',
    );
  }

  cachedWorkspaceRoot = mainWorkspace.uri.fsPath;

  return cachedWorkspaceRoot;
}

/** Converts file path relative to workspace root to a vscode.Uri */
export async function toUri(
  file: string,
  lineNo?: number,
) {
  const workspaceRoot = await getWorkspaceRoot();
  const uri = vscode.Uri.joinPath(vscode.Uri.file(workspaceRoot), file);

  if (lineNo) {
    // 1-based line number
    return uri.with({ fragment: `L${lineNo}` });
  }

  return uri;
}
