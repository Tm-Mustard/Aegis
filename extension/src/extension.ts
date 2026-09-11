import * as vscode from 'vscode';
import { AgentPanel } from './agentPanel';

export function activate(context: vscode.ExtensionContext) {
  context.subscriptions.push(
    vscode.commands.registerCommand('agenticCoder.openPanel', () => {
      AgentPanel.createOrShow(context);
    }),
    vscode.commands.registerCommand('agenticCoder.newThread', () => {
      AgentPanel.startNewThread(context);
    })
  );

  // Restore panel across window reloads if one was open.
  if (vscode.window.registerWebviewPanelSerializer) {
    vscode.window.registerWebviewPanelSerializer(AgentPanel.viewType, {
      async deserializeWebviewPanel(panel: vscode.WebviewPanel) {
        AgentPanel.revive(panel, context);
      },
    });
  }
}

export function deactivate() {
  AgentPanel.dispose();
}
