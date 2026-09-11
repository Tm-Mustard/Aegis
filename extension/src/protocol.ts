// Wire protocol between the VS Code extension and the FastAPI gateway (§9, §3.3 of PRD).
// Keep this file the single source of truth; the webview's JS mirrors it by hand
// since webview content can't import TS modules directly.

export type GraphNode =
  | 'normalize_request'
  | 'validate_request'
  | 'supervisor_route'
  | 'worker_generate'
  | 'tavily_search'
  | 'execute_sandbox'
  | 'compress_execution_output'
  | 'judge'
  | 'worker_repair'
  | 'escalation_or_failure'
  | 'prepare_final_output'
  | 'prepare_failure_output';

// ---- Outbound (extension -> gateway) ----

export interface PromptMessage {
  type: 'prompt';
  thread_id: string;
  prompt: string;
  workspace_context?: Record<string, unknown>;
}

export interface ResumeMessage {
  type: 'resume';
  thread_id: string;
}

export type OutboundMessage = PromptMessage | ResumeMessage;

// ---- Inbound (gateway -> extension) ----

export interface StatusEvent {
  type: 'status';
  thread_id: string;
  run_id: string;
  node: GraphNode;
}

export interface CodeChunkEvent {
  type: 'code_chunk';
  run_id: string;
  content: string;
  done: boolean;
}

export interface TraceEvent {
  type: 'trace';
  run_id: string;
  routing_decision?: 'simple' | 'code_task';
  repair_attempt?: number;
  worker_retry_count?: number;
  judge_verdict?: 'PASS' | 'FAIL';
}

export interface TokenUsageEvent {
  type: 'token_usage';
  run_id: string;
  node_name: string;
  model: string;
  input_tokens: number;
  output_tokens: number;
  compressed_tokens: number;
  latency_ms: number;
}

export interface FinalEvent {
  type: 'final';
  run_id: string;
  final_output: string;
}

export interface FailureEvent {
  type: 'failure';
  run_id: string;
  failure_output: {
    status: 'failed';
    last_error: string;
    attempts: number;
    partial_code: string | null;
  };
}

export interface ErrorEvent {
  type: 'error';
  message: string;
}

export type InboundMessage =
  | StatusEvent
  | CodeChunkEvent
  | TraceEvent
  | TokenUsageEvent
  | FinalEvent
  | FailureEvent
  | ErrorEvent;

// ---- Extension host <-> webview (internal, not gateway wire format) ----

export type HostToWebviewMessage =
  | { command: 'connectionState'; state: 'connecting' | 'open' | 'closed' | 'reconnecting' }
  | { command: 'inbound'; payload: InboundMessage }
  | { command: 'threadId'; threadId: string };

export type WebviewToHostMessage =
  | { command: 'submitPrompt'; prompt: string }
  | { command: 'newThread' }
  | { command: 'ready' };
