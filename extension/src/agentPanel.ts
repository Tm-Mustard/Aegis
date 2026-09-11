import * as vscode from 'vscode';
import * as crypto from 'crypto';
import { WsClient } from './wsClient';
import {
  HostToWebviewMessage,
  WebviewToHostMessage,
  InboundMessage,
} from './protocol';

const THREAD_ID_KEY = 'agenticCoder.threadId';

export class AgentPanel {
  public static readonly viewType = 'agenticCoder.panel';
  private static current: AgentPanel | undefined;

  private readonly panel: vscode.WebviewPanel;
  private readonly context: vscode.ExtensionContext;
  private wsClient: WsClient | undefined;
  private threadId: string;
  private disposables: vscode.Disposable[] = [];

  public static createOrShow(context: vscode.ExtensionContext) {
    const column = vscode.window.activeTextEditor?.viewColumn;
    if (AgentPanel.current) {
      AgentPanel.current.panel.reveal(column);
      return;
    }
    const panel = vscode.window.createWebviewPanel(
      AgentPanel.viewType,
      'Agentic Coder',
      column ?? vscode.ViewColumn.Beside,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'media')],
      }
    );
    AgentPanel.current = new AgentPanel(panel, context);
  }

  public static revive(panel: vscode.WebviewPanel, context: vscode.ExtensionContext) {
    AgentPanel.current = new AgentPanel(panel, context);
  }

  public static startNewThread(context: vscode.ExtensionContext) {
    const fresh = crypto.randomUUID();
    context.workspaceState.update(THREAD_ID_KEY, fresh);
    if (AgentPanel.current) {
      AgentPanel.current.resetThread(fresh);
    } else {
      AgentPanel.createOrShow(context);
    }
  }

  public static dispose() {
    AgentPanel.current?.disposeInternal();
    AgentPanel.current = undefined;
  }

  private constructor(panel: vscode.WebviewPanel, context: vscode.ExtensionContext) {
    this.panel = panel;
    this.context = context;
    this.threadId =
      context.workspaceState.get<string>(THREAD_ID_KEY) ?? crypto.randomUUID();
    context.workspaceState.update(THREAD_ID_KEY, this.threadId);

    this.panel.webview.html = this.renderHtml();

    this.panel.webview.onDidReceiveMessage(
      (msg: WebviewToHostMessage) => this.handleWebviewMessage(msg),
      null,
      this.disposables
    );

    this.panel.onDidDispose(() => this.disposeInternal(), null, this.disposables);
  }

  private handleWebviewMessage(msg: WebviewToHostMessage) {
    switch (msg.command) {
      case 'ready':
        this.postToWebview({ command: 'threadId', threadId: this.threadId });
        this.ensureConnected();
        break;
      case 'submitPrompt':
        this.ensureConnected();
        this.wsClient?.send({
          type: 'prompt',
          thread_id: this.threadId,
          prompt: msg.prompt,
          workspace_context: this.collectWorkspaceContext(),
        });
        break;
      case 'newThread':
        AgentPanel.startNewThread(this.context);
        break;
    }
  }

  private resetThread(newThreadId: string) {
    this.wsClient?.dispose();
    this.threadId = newThreadId;
    this.postToWebview({ command: 'threadId', threadId: this.threadId });
    this.ensureConnected();
  }

  private ensureConnected() {
    if (this.wsClient) return;
    const config = vscode.workspace.getConfiguration('agenticCoder');
    const url = config.get<string>('gatewayUrl', 'ws://localhost:8000/ws');
    const authToken = config.get<string>('authToken', '');

    this.wsClient = new WsClient({
      url,
      authToken: authToken || undefined,
      threadId: this.threadId,
      onMessage: (payload: InboundMessage) => this.postToWebview({ command: 'inbound', payload }),
      onStateChange: (state) => this.postToWebview({ command: 'connectionState', state }),
    });
    this.wsClient.connect();
  }

  private collectWorkspaceContext(): Record<string, unknown> {
    const editor = vscode.window.activeTextEditor;
    if (!editor) return {};
    return {
      active_file: vscode.workspace.asRelativePath(editor.document.uri),
      language_id: editor.document.languageId,
      selection: editor.document.getText(editor.selection) || undefined,
    };
  }

  private postToWebview(msg: HostToWebviewMessage) {
    this.panel.webview.postMessage(msg);
  }

  private disposeInternal() {
    this.wsClient?.dispose();
    this.wsClient = undefined;
    this.disposables.forEach((d) => d.dispose());
    this.disposables = [];
    if (AgentPanel.current === this) {
      AgentPanel.current = undefined;
    }
  }

  private renderHtml(): string {
    const webview = this.panel.webview;
    const scriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.context.extensionUri, 'media', 'main.js')
    );
    const styleUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.context.extensionUri, 'media', 'main.css')
    );
    const nonce = crypto.randomBytes(16).toString('hex');

    return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy"
    content="default-src 'none'; style-src ${webview.cspSource}; img-src ${webview.cspSource}; script-src 'nonce-${nonce}';" />
  <link href="${styleUri}" rel="stylesheet" />
  <title>Agentic Coder</title>
</head>
<body>
  <div id="app">
    <div id="statusBar">
      <span id="connState" class="pill">connecting…</span>
      <span id="threadLabel" class="pill muted"></span>
      <button id="newThreadBtn" title="Start a new thread">New thread</button>
    </div>

    <div id="trace"></div>

    <pre id="codeStream"><code></code></pre>

    <div id="compressionPanel" class="hidden">
      <div class="panel-title">Context compression</div>
      <div id="compressionRows"></div>
    </div>

    <div id="finalOutput"></div>

    <form id="promptForm">
      <textarea id="promptInput" rows="3" placeholder="Describe a coding task, or ask a question…"></textarea>
      <button type="submit" id="sendBtn">Send</button>
    </form>
  </div>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
  }
}
