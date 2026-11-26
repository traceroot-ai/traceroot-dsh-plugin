import {
  context,
  SpanStatusCode,
  trace,
  type Context as OtelContext,
  type Span,
} from '@opentelemetry/api';
import type { OtelRuntime } from './otlp.js';
import type { ContentBlock, DshSession, DshSessionEvent, TokenUsage } from './types.js';

interface PendingToolCall {
  callId: string;
  name: string;
  arguments: string;
  startTimeMs: number;
  turn: number;
  step: number;
}

interface TurnState {
  turn: number;
  rootSpan: Span;
  rootContext: OtelContext;
  hasInput: boolean;
  lastUserText?: string;
  lastAssistantText?: string;
  model?: string;
  provider?: string;
  stepStartTimes: Map<number, number>;
  pendingToolCalls: Map<string, PendingToolCall>;
}

const MAX_ATTR_CHARS = 20_000;

function truncate(value: string): string {
  if (value.length <= MAX_ATTR_CHARS) return value;
  return `${value.slice(0, MAX_ATTR_CHARS)}...[truncated]`;
}

function extractMessageText(message: unknown): string | undefined {
  if (!message || typeof message !== 'object') return undefined;
  const content = (message as { content?: unknown }).content;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return undefined;

  const parts: string[] = [];
  for (const block of content as ContentBlock[]) {
    if (!block || typeof block !== 'object') continue;
    if ((block.type === 'text' || block.type === 'reasoning') && typeof block.text === 'string') {
      parts.push(block.text);
    }
  }
  return parts.length > 0 ? parts.join('\n') : undefined;
}

function isTokenUsage(value: unknown): value is TokenUsage {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return typeof v.inputTokens === 'number' && typeof v.outputTokens === 'number';
}

function sessionKey(sessionId: string, turn: number): string {
  return `${sessionId}:${turn}`;
}

export class DshTraceBridge {
  private readonly runtime: OtelRuntime;
  private readonly turns = new Map<string, TurnState>();
  private readonly sessionModels = new Map<string, { model?: string; provider?: string }>();

  constructor(runtime: OtelRuntime) {
    this.runtime = runtime;
  }

  onSessionEvent(session: DshSession, event: DshSessionEvent): void {
    const inheritedCount = session.inheritedEventCount ?? 0;
    if (event.seq < inheritedCount) return;

    const data = event.data ?? {};
    switch (event.type) {
      case 'turn/start':
        this.handleTurnStart(session.id, event.time, data);
        break;
      case 'user/message':
        this.handleUserMessage(session.id, data);
        break;
      case 'request/header':
        this.handleRequestHeader(session.id, data);
        break;
      case 'step/start':
        this.handleStepStart(session.id, event.time, data);
        break;
      case 'assistant/message':
        this.handleAssistantMessage(session.id, event.time, data);
        break;
      case 'tool/call':
        this.handleToolCall(session.id, event.time, data);
        break;
      case 'tool/result':
        this.handleToolResult(session.id, event.time, data);
        break;
      case 'turn/end':
        this.handleTurnEnd(session.id, event.time, data);
        break;
      default:
        break;
    }
  }

  onSessionDisposed(session: DshSession): void {
    const prefix = `${session.id}:`;
    const now = Date.now();
    for (const [key, state] of this.turns.entries()) {
      if (key.startsWith(prefix)) {
        state.rootSpan.end(now);
        this.turns.delete(key);
      }
    }
    this.sessionModels.delete(session.id);
  }

  async shutdown(): Promise<void> {
    const now = Date.now();
    for (const state of this.turns.values()) {
      state.rootSpan.end(now);
    }
    this.turns.clear();
    this.sessionModels.clear();
    await this.runtime.shutdown();
  }

  private getLatestTurn(sessionId: string, turnNum?: unknown): TurnState | undefined {
    if (typeof turnNum === 'number') {
      return this.turns.get(sessionKey(sessionId, turnNum));
    }
    const prefix = `${sessionId}:`;
    let latest: TurnState | undefined;
    for (const [key, state] of this.turns.entries()) {
      if (key.startsWith(prefix)) latest = state;
    }
    return latest;
  }

  private handleTurnStart(sessionId: string, timeMs: number, data: Record<string, unknown>): void {
    const turn = typeof data.turn === 'number' ? data.turn : 0;
    const key = sessionKey(sessionId, turn);
    const existing = this.turns.get(key);
    if (existing) {
      existing.rootSpan.end(timeMs);
      this.turns.delete(key);
    }

    const rootSpan = this.runtime.tracer.startSpan('dsh.turn', {
      startTime: timeMs,
      attributes: {
        'traceroot.span.type': 'AGENT',
        'traceroot.trace.session_id': sessionId,
        'dsh.turn': turn,
      },
    });
    const rootContext = trace.setSpan(context.active(), rootSpan);
    const cachedModel = this.sessionModels.get(sessionId);

    this.turns.set(key, {
      turn,
      rootSpan,
      rootContext,
      hasInput: false,
      model: cachedModel?.model,
      provider: cachedModel?.provider,
      stepStartTimes: new Map(),
      pendingToolCalls: new Map(),
    });
  }

  private handleUserMessage(sessionId: string, data: Record<string, unknown>): void {
    const state = this.getLatestTurn(sessionId, data.turn);
    if (!state) return;
    const text = extractMessageText(data);
    if (text === undefined) return;
    state.lastUserText = text;
    if (!state.hasInput) {
      state.rootSpan.setAttribute('traceroot.span.input', truncate(text));
      state.hasInput = true;
    }
  }

  private handleRequestHeader(sessionId: string, data: Record<string, unknown>): void {
    const header = data.header as { config?: { model?: unknown; provider?: unknown } } | undefined;
    const model = typeof header?.config?.model === 'string' ? header.config.model : undefined;
    const provider = typeof header?.config?.provider === 'string' ? header.config.provider : undefined;
    if (!model && !provider) return;

    this.sessionModels.set(sessionId, { model, provider });
    const state = this.getLatestTurn(sessionId);
    if (state) {
      if (model) state.model = model;
      if (provider) state.provider = provider;
    }
  }

  private handleStepStart(sessionId: string, timeMs: number, data: Record<string, unknown>): void {
    const state = this.getLatestTurn(sessionId, data.turn);
    if (!state || typeof data.step !== 'number') return;
    state.stepStartTimes.set(data.step, timeMs);
  }

  private handleAssistantMessage(
    sessionId: string,
    timeMs: number,
    data: Record<string, unknown>,
  ): void {
    const state = this.getLatestTurn(sessionId, data.turn);
    if (!state) return;

    const step = typeof data.step === 'number' ? data.step : 0;
    const startTimeMs = state.stepStartTimes.get(step) ?? timeMs;
    const outputText = extractMessageText(data.message);
    if (outputText !== undefined) {
      state.lastAssistantText = outputText;
    }

    const attrs: Record<string, string | number> = {
      'traceroot.span.type': 'LLM',
      'traceroot.trace.session_id': sessionId,
      'dsh.turn': state.turn,
      'dsh.step': step,
    };
    if (state.model) attrs['gen_ai.request.model'] = state.model;
    if (state.provider) attrs['gen_ai.system'] = state.provider;
    if (state.lastUserText !== undefined) attrs['traceroot.span.input'] = truncate(state.lastUserText);
    if (outputText !== undefined) attrs['traceroot.span.output'] = truncate(outputText);

    if (isTokenUsage(data.usage)) {
      attrs['gen_ai.usage.input_tokens'] = data.usage.inputTokens;
      attrs['gen_ai.usage.output_tokens'] = data.usage.outputTokens;
      if (typeof data.usage.cacheReadTokens === 'number') {
        attrs['gen_ai.usage.cache_read.input_tokens'] = data.usage.cacheReadTokens;
      }
      if (typeof data.usage.cacheWriteTokens === 'number') {
        attrs['gen_ai.usage.cache_creation.input_tokens'] = data.usage.cacheWriteTokens;
      }
    }

    const spanName = state.model ? `llm.${state.model}` : 'dsh.llm';
    const llmSpan = this.runtime.tracer.startSpan(
      spanName,
      { startTime: startTimeMs, attributes: attrs },
      state.rootContext,
    );
    llmSpan.end(Math.max(timeMs, startTimeMs));
  }

  private handleToolCall(sessionId: string, timeMs: number, data: Record<string, unknown>): void {
    const state = this.getLatestTurn(sessionId, data.turn);
    if (!state) return;
    const callId = typeof data.callId === 'string' ? data.callId : undefined;
    const name = typeof data.name === 'string' ? data.name : 'unknown_tool';
    if (!callId) return;

    state.pendingToolCalls.set(callId, {
      callId,
      name,
      arguments: typeof data.arguments === 'string' ? data.arguments : JSON.stringify(data.arguments ?? {}),
      startTimeMs: timeMs,
      turn: state.turn,
      step: typeof data.step === 'number' ? data.step : 0,
    });
  }

  private handleToolResult(sessionId: string, timeMs: number, data: Record<string, unknown>): void {
    const state = this.getLatestTurn(sessionId, data.turn);
    if (!state) return;

    const msg = data.message as { toolCallId?: unknown; isError?: unknown } | undefined;
    const callId = typeof msg?.toolCallId === 'string' ? msg.toolCallId : undefined;
    const pending = callId ? state.pendingToolCalls.get(callId) : undefined;
    if (callId) state.pendingToolCalls.delete(callId);

    const toolName = pending?.name ?? 'dsh.tool';
    const startTimeMs = pending?.startTimeMs ?? timeMs;
    const resultText = extractMessageText(msg);

    const attrs: Record<string, string | number> = {
      'traceroot.span.type': 'TOOL',
      'traceroot.trace.session_id': sessionId,
      'gen_ai.tool.name': toolName,
      'dsh.turn': state.turn,
    };
    if (pending) {
      attrs['gen_ai.tool.call.arguments'] = truncate(pending.arguments);
      attrs['dsh.step'] = pending.step;
    }
    if (resultText !== undefined) {
      attrs['gen_ai.tool.call.result'] = truncate(resultText);
    }

    const toolSpan = this.runtime.tracer.startSpan(
      toolName,
      { startTime: startTimeMs, attributes: attrs },
      state.rootContext,
    );

    const err = data.error as { message?: string; reason?: string } | undefined;
    if (msg?.isError === true || err !== undefined) {
      toolSpan.setStatus({
        code: SpanStatusCode.ERROR,
        message: typeof err?.reason === 'string' ? err.reason : 'Tool execution failed',
      });
    }
    toolSpan.end(Math.max(timeMs, startTimeMs));
  }

  private handleTurnEnd(sessionId: string, timeMs: number, data: Record<string, unknown>): void {
    const state = this.getLatestTurn(sessionId, data.turn);
    if (!state) return;

    if (state.lastAssistantText !== undefined) {
      state.rootSpan.setAttribute('traceroot.span.output', truncate(state.lastAssistantText));
    }

    const reason = data.reason as { kind?: unknown; error?: { message?: unknown } } | undefined;
    if (reason?.kind === 'error' || reason?.kind === 'blocked') {
      state.rootSpan.setStatus({
        code: SpanStatusCode.ERROR,
        message:
          typeof reason.error?.message === 'string'
            ? reason.error.message
            : `Turn ended with ${String(reason.kind)}`,
      });
    }

    state.rootSpan.end(timeMs);
    this.turns.delete(sessionKey(sessionId, state.turn));
    void this.runtime.forceFlush().catch(() => {});
  }
}
