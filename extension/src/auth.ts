import * as vscode from 'vscode';
import * as crypto from 'crypto';

// Talks directly to Supabase's GoTrue REST API (no custom backend hop needed
// for login itself). The gateway only needs to *verify* the resulting JWT —
// see SUPABASE_SETUP.md.

const SESSION_KEY = 'aegis.supabaseSession';
const CALLBACK_PATH = '/auth-callback';
const REFRESH_SKEW_MS = 60_000; // refresh if less than 60s of life left

interface StoredSession {
  access_token: string;
  refresh_token: string;
  expires_at: number; // epoch ms
  user_email?: string;
}

interface PendingLogin {
  codeVerifier: string;
  resolve: (session: StoredSession) => void;
  reject: (err: Error) => void;
}

function base64url(input: Buffer): string {
  return input.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function pkcePair(): { verifier: string; challenge: string } {
  const verifier = base64url(crypto.randomBytes(32));
  const challenge = base64url(crypto.createHash('sha256').update(verifier).digest());
  return { verifier, challenge };
}

export class SupabaseAuth implements vscode.UriHandler {
  private pending: PendingLogin | undefined;
  private readonly changeEmitter = new vscode.EventEmitter<void>();
  public readonly onDidChangeSession = this.changeEmitter.event;

  constructor(private context: vscode.ExtensionContext) {}

  private config() {
    const cfg = vscode.workspace.getConfiguration('aegis');
    const url = cfg.get<string>('supabaseUrl', '').replace(/\/+$/, '');
    const anonKey = cfg.get<string>('supabaseAnonKey', '');
    const provider = cfg.get<string>('oauthProvider', 'github');
    if (!url || !anonKey) {
      throw new Error(
        'Set aegis.supabaseUrl and aegis.supabaseAnonKey in Settings before signing in.'
      );
    }
    return { url, anonKey, provider };
  }

  private redirectUri(): string {
    // Must be added verbatim to Supabase → Authentication → URL Configuration
    // → Redirect URLs. Differs between stable and Insiders builds.
    return `${vscode.env.uriScheme}://${this.context.extension.id}${CALLBACK_PATH}`;
  }

  public async getSessionInfo(): Promise<{ signedIn: boolean; email?: string }> {
    const session = await this.readSession();
    return { signedIn: !!session, email: session?.user_email };
  }

  private async readSession(): Promise<StoredSession | undefined> {
    const raw = await this.context.secrets.get(SESSION_KEY);
    return raw ? (JSON.parse(raw) as StoredSession) : undefined;
  }

  private async writeSession(session: StoredSession | undefined): Promise<void> {
    if (session) {
      await this.context.secrets.store(SESSION_KEY, JSON.stringify(session));
    } else {
      await this.context.secrets.delete(SESSION_KEY);
    }
    this.changeEmitter.fire();
  }

  /** Returns a live access token, refreshing first if it's near expiry. Undefined if not signed in or refresh fails. */
  public async getValidAccessToken(): Promise<string | undefined> {
    const session = await this.readSession();
    if (!session) return undefined;

    if (Date.now() < session.expires_at - REFRESH_SKEW_MS) {
      return session.access_token;
    }

    try {
      const { url, anonKey } = this.config();
      const resp = await fetch(`${url}/auth/v1/token?grant_type=refresh_token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', apikey: anonKey },
        body: JSON.stringify({ refresh_token: session.refresh_token }),
      });
      if (!resp.ok) throw new Error(`refresh failed (${resp.status})`);
      const data = (await resp.json()) as {
        access_token: string;
        refresh_token: string;
        expires_in: number;
      };
      const refreshed: StoredSession = {
        access_token: data.access_token,
        refresh_token: data.refresh_token,
        expires_at: Date.now() + data.expires_in * 1000,
        user_email: session.user_email,
      };
      await this.writeSession(refreshed);
      return refreshed.access_token;
    } catch {
      // Refresh token itself expired/revoked — force a real sign-in again.
      await this.writeSession(undefined);
      return undefined;
    }
  }

  public async signOut(): Promise<void> {
    const session = await this.readSession();
    if (session) {
      try {
        const { url, anonKey } = this.config();
        await fetch(`${url}/auth/v1/logout`, {
          method: 'POST',
          headers: { apikey: anonKey, Authorization: `Bearer ${session.access_token}` },
        });
      } catch {
        // Best-effort; clear local state regardless.
      }
    }
    await this.writeSession(undefined);
  }

  public async signIn(): Promise<void> {
    if (this.pending) {
      // Supersede a stuck previous attempt (e.g. user closed the tab last time)
      // instead of showing "already in progress" forever.
      this.pending.reject(new Error('cancelled'));
      this.pending = undefined;
    }

    let url: string, anonKey: string, provider: string;
    try {
      ({ url, anonKey, provider } = this.config());
    } catch (err) {
      vscode.window.showErrorMessage((err as Error).message);
      return;
    }

    const { verifier, challenge } = pkcePair();
    const authorizeUrl = new URL(`${url}/auth/v1/authorize`);
    authorizeUrl.searchParams.set('provider', provider);
    authorizeUrl.searchParams.set('redirect_to', this.redirectUri());
    authorizeUrl.searchParams.set('code_challenge', challenge);
    authorizeUrl.searchParams.set('code_challenge_method', 's256');
    authorizeUrl.searchParams.set('apikey', anonKey);

    const opened = await vscode.env.openExternal(vscode.Uri.parse(authorizeUrl.toString()));
    if (!opened) {
      vscode.window.showErrorMessage('Could not open the browser for sign-in.');
      return;
    }

    const loginPromise = new Promise<StoredSession>((resolve, reject) => {
      this.pending = { codeVerifier: verifier, resolve, reject };
    });

    const timeout = setTimeout(() => {
      if (this.pending) {
        this.pending.reject(new Error('Sign-in timed out after 5 minutes.'));
        this.pending = undefined;
      }
    }, 5 * 60 * 1000);

    try {
      const session = await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: 'Waiting for browser sign-in… (click Cancel if you closed the tab)',
          cancellable: true,
        },
        (_progress, token) => {
          token.onCancellationRequested(() => {
            if (this.pending) {
              this.pending.reject(new Error('cancelled'));
              this.pending = undefined;
            }
          });
          return loginPromise;
        }
      );
      await this.writeSession(session);
      vscode.window.showInformationMessage(
        session.user_email ? `Signed in as ${session.user_email}.` : 'Signed in.'
      );
    } catch (err) {
      const message = (err as Error).message;
      if (message !== 'cancelled') {
        vscode.window.showErrorMessage(`Sign-in failed: ${message}`);
      }
    } finally {
      clearTimeout(timeout);
    }
  }

  // VS Code invokes this when the OS opens vscode://<extension-id>/auth-callback?...
  public async handleUri(uri: vscode.Uri): Promise<void> {
    if (uri.path !== CALLBACK_PATH) return;
    if (!this.pending) {
      vscode.window.showErrorMessage('Received a sign-in callback but none was in progress.');
      return;
    }

    const query = new URLSearchParams(uri.query);
    const code = query.get('code');
    const errorDescription = query.get('error_description') ?? query.get('error');

    if (errorDescription) {
      this.pending.reject(new Error(errorDescription));
      this.pending = undefined;
      return;
    }
    if (!code) {
      this.pending.reject(new Error('No authorization code in callback.'));
      this.pending = undefined;
      return;
    }

    try {
      const { url, anonKey } = this.config();
      const resp = await fetch(`${url}/auth/v1/token?grant_type=pkce`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', apikey: anonKey },
        body: JSON.stringify({ auth_code: code, code_verifier: this.pending.codeVerifier }),
      });
      if (!resp.ok) {
        throw new Error(`Supabase rejected code exchange (${resp.status}): ${await resp.text()}`);
      }
      const data = (await resp.json()) as {
        access_token: string;
        refresh_token: string;
        expires_in: number;
        user?: { email?: string };
      };
      this.pending.resolve({
        access_token: data.access_token,
        refresh_token: data.refresh_token,
        expires_at: Date.now() + data.expires_in * 1000,
        user_email: data.user?.email,
      });
    } catch (err) {
      this.pending.reject(err as Error);
    } finally {
      this.pending = undefined;
    }
  }
}