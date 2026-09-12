import WebSocket from 'ws';
import { InboundMessage, OutboundMessage } from './protocol';

type ConnState = 'connecting' | 'open' | 'closed' | 'reconnecting';

export interface WsClientOptions {
  url: string;
  /** Called fresh on every connect/reconnect so a refreshed Supabase token is always used. */
  getAuthToken: () => Promise<string | undefined>;
  threadId: string;
  onMessage: (msg: InboundMessage) => void;
  onStateChange: (state: ConnState) => void;
  /** Fired if getAuthToken() returns undefined — caller should prompt sign-in, not retry blindly. */
  onAuthRequired: () => void;
  maxBackoffMs?: number;
}

// Reconnect-and-resume per §9: same thread_id resumes from the last
// LangGraph checkpoint rather than restarting the task.
export class WsClient {
  private socket: WebSocket | undefined;
  private closedByUser = false;
  private backoffMs = 500;
  private readonly maxBackoffMs: number;
  private queue: OutboundMessage[] = [];

  constructor(private opts: WsClientOptions) {
    this.maxBackoffMs = opts.maxBackoffMs ?? 10_000;
  }

  async connect(): Promise<void> {
    this.closedByUser = false;
    this.opts.onStateChange('connecting');

    const token = await this.opts.getAuthToken();
    if (!token) {
      this.opts.onStateChange('closed');
      this.opts.onAuthRequired();
      return;
    }

    const headers: Record<string, string> = { Authorization: `Bearer ${token}` };
    this.socket = new WebSocket(this.opts.url, { headers });

    this.socket.on('open', () => {
      this.backoffMs = 500;
      this.opts.onStateChange('open');
      // Always announce/resume the thread first so the gateway can
      // load existing checkpoint state before anything else is sent.
      this.sendRaw({ type: 'resume', thread_id: this.opts.threadId });
      this.flushQueue();
    });

    this.socket.on('message', (data) => {
      try {
        const parsed = JSON.parse(data.toString()) as InboundMessage;
        this.opts.onMessage(parsed);
      } catch (err) {
        this.opts.onMessage({ type: 'error', message: `Malformed message from gateway: ${String(err)}` });
      }
    });

    this.socket.on('close', () => {
      if (this.closedByUser) {
        this.opts.onStateChange('closed');
        return;
      }
      this.opts.onStateChange('reconnecting');
      this.scheduleReconnect();
    });

    this.socket.on('error', () => {
      // 'close' fires after 'error' for ws; reconnect logic lives there.
    });
  }

  private scheduleReconnect(): void {
    setTimeout(() => {
      if (!this.closedByUser) {
        void this.connect();
      }
    }, this.backoffMs);
    this.backoffMs = Math.min(this.backoffMs * 2, this.maxBackoffMs);
  }

  send(msg: OutboundMessage): void {
    if (this.socket && this.socket.readyState === WebSocket.OPEN) {
      this.sendRaw(msg);
    } else {
      // Queue until reconnected; flushed in order on 'open'.
      this.queue.push(msg);
    }
  }

  private sendRaw(msg: OutboundMessage): void {
    this.socket?.send(JSON.stringify(msg));
  }

  private flushQueue(): void {
    const pending = this.queue;
    this.queue = [];
    for (const msg of pending) {
      this.sendRaw(msg);
    }
  }

  dispose(): void {
    this.closedByUser = true;
    this.socket?.close();
    this.socket = undefined;
  }
}
