import * as path from 'node:path';
import * as process from 'node:process';
import * as vscode from 'vscode';

export const MCP_PROVIDER_ID = 'custom-vscode.terminal-tools-mcp';

function getExtensionVersion(context: vscode.ExtensionContext): string {
  const packageJson = context.extension.packageJSON as unknown;

  if (
    typeof packageJson === 'object'
    && packageJson !== null
    && 'version' in packageJson
    && typeof packageJson.version === 'string'
  ) {
    return packageJson.version;
  }

  return '0.0.0';
}

export function registerMcpServerProvider(context: vscode.ExtensionContext): void {
  const provider: vscode.McpServerDefinitionProvider<vscode.McpStdioServerDefinition> = {
    provideMcpServerDefinitions(): vscode.ProviderResult<vscode.McpStdioServerDefinition[]> {
      const serverScriptPath = path.join(context.extensionPath, 'dist', 'mcpServer.js');
      const version = getExtensionVersion(context);

      return [
        new vscode.McpStdioServerDefinition(
          'Custom Terminal Tools MCP',
          process.execPath,
          [ serverScriptPath ],
          {},
          version,
        ),
      ];
    },
    resolveMcpServerDefinition(
      server: vscode.McpStdioServerDefinition,
    ): vscode.ProviderResult<vscode.McpStdioServerDefinition> {
      const workspaceFolder = vscode.workspace.workspaceFolders?.[0];

      if (workspaceFolder) {
        server.cwd = workspaceFolder.uri;
      }

      return server;
    },
  };

  context.subscriptions.push(
    vscode.lm.registerMcpServerDefinitionProvider(MCP_PROVIDER_ID, provider),
  );
}
