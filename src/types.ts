/** Minimal structural types matching DeepSeek Harness (dsh) Cordis events & config. */

export interface PluginConfig {
  /** TraceRoot API key; falls back to TRACEROOT_API_KEY env var. */
  apiKey?: string;
  /** TraceRoot base URL; falls back to TRACEROOT_HOST_URL or https://app.traceroot.ai. */
  hostUrl?: string;
  /** Deployment environment tag; falls back to TRACEROOT_ENVIRONMENT. */
  environment?: string;
  /** OTel service.name; defaults to deepseek-harness. */
  serviceName?: string;
  /** Disable tracing explicitly when set to false. */
  enabled?: boolean;
}

export interface CordisLogger {
  warn(message: string, ...args: unknown[]): void;
  error?(message: string, ...args: unknown[]): void;
}

export interface CordisContext {
  logger?: CordisLogger;
  on(
    event: 'session/event',
    listener: (session: DshSession, event: DshSessionEvent) => void,
    options?: { global?: boolean },
  ): () => void;
  on(
    event: 'session/disposed',
    listener: (session: DshSession) => void,
    options?: { global?: boolean },
  ): () => void;
  effect(callback: () => void | (() => void | Promise<void>)): () => void;
}

export interface DshSession {
  readonly id: string;
  readonly inheritedEventCount?: number;
}

export interface ContentBlock {
  type: string;
  text?: string;
  [key: string]: unknown;
}

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  reasoningTokens?: number;
}

export interface DshSessionEvent {
  readonly seq: number;
  readonly time: number;
  readonly type: string;
  readonly data: Record<string, unknown>;
}
