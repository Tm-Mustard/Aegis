import * as vscode from 'vscode';
import { AgentPanel } from './agentPanel';
import { SupabaseAuth } from './auth';

export function activate(context: vscode.ExtensionContext) {
  const auth = new SupabaseAuth(context);

  // Routes vscode://<publisher>.<name>/auth-callback?... back into SupabaseAuth.
  context.subscriptions.push(vscode.window.registerUriHandler(auth));

  context.subscriptions.push(
    auth.onDidChangeSession(() => AgentPanel.notifyAuthChanged())
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('aegis.openPanel', () => {
      AgentPanel.createOrShow(context, auth);
    }),
    vscode.commands.registerCommand('aegis.newThread', () => {
      AgentPanel.startNewThread(context, auth);
    }),
    vscode.commands.registerCommand('aegis.signIn', () => auth.signIn()),
    vscode.commands.registerCommand('aegis.signOut', () => auth.signOut())
  );

  if (vscode.window.registerWebviewPanelSerializer) {
    vscode.window.registerWebviewPanelSerializer(AgentPanel.viewType, {
      async deserializeWebviewPanel(panel: vscode.WebviewPanel) {
        AgentPanel.revive(panel, context, auth);
      },
    });
  }
}

export function deactivate() {
  AgentPanel.dispose();
}
