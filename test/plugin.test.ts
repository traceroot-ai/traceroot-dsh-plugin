import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { SpanStatusCode } from '@opentelemetry/api';
import { InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base';
import { apply } from '../src/index.js';
import { resolveConfig } from '../src/config.js';
import { createOtelRuntime } from '../src/otlp.js';
import { DshTraceBridge } from '../src/tracer.js';
import type { CordisContext, DshSession, DshSessionEvent } from '../src/types.js';

function makeBridge() {
  const exporter = new InMemorySpanExporter();
  const runtime = createOtelRuntime(
    resolveConfig({ apiKey: 'test-key', hostUrl: 'https://app.traceroot.ai' }),
    new SimpleSpanProcessor(exporter),
  );
  const bridge = new DshTraceBridge(runtime);
  return { exporter, bridge };
}

test('multi-turn session emits one trace per turn under the same session ID with LLM and TOOL spans', async () => {
  const { exporter, bridge } = makeBridge();
  const session: DshSession = { id: 'sess-dsh-1', inheritedEventCount: 1 };

  const events: DshSessionEvent[] = [
    // Inherited event (seq 0 < inheritedEventCount 1) must be skipped
    { seq: 0, time: 1000, type: 'turn/start', data: { turn: 0 } },
    // Turn 1
    { seq: 1, time: 2000, type: 'turn/start', data: { turn: 1 } },
    {
      seq: 2,
      time: 2005,
      type: 'user/message',
      data: { role: 'user', content: [{ type: 'text', text: 'Check package.json' }] },
    },
    {
      seq: 3,
      time: 2010,
      type: 'request/header',
      data: { header: { config: { provider: 'deepseek', model: 'deepseek-chat' } } },
    },
    { seq: 4, time: 2020, type: 'step/start', data: { turn: 1, step: 1 } },
    {
      seq: 5,
      time: 2300,
      type: 'assistant/message',
      data: {
        turn: 1,
        step: 1,
        message: { role: 'assistant', content: [{ type: 'text', text: 'Reading package.json...' }] },
        usage: { inputTokens: 120, outputTokens: 25, cacheReadTokens: 40 },
      },
    },
    {
      seq: 6,
      time: 2310,
      type: 'tool/call',
      data: {
        turn: 1,
        step: 1,
        callId: 'call-1',
        name: 'read_file',
        arguments: '{"path":"package.json"}',
      },
    },
    {
      seq: 7,
      time: 2360,
      type: 'tool/result',
      data: {
        turn: 1,
        step: 1,
        message: {
          role: 'tool',
          toolCallId: 'call-1',
          content: [{ type: 'text', text: '{"name":"demo"}' }],
        },
      },
    },
    { seq: 8, time: 2400, type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } },
    // Turn 2
    { seq: 9, time: 3000, type: 'turn/start', data: { turn: 2 } },
    {
      seq: 10,
      time: 3010,
      type: 'user/message',
      data: { role: 'user', content: [{ type: 'text', text: 'Run failing command' }] },
    },
    { seq: 11, time: 3020, type: 'step/start', data: { turn: 2, step: 1 } },
    {
      seq: 12,
      time: 3200,
      type: 'tool/call',
      data: { turn: 2, step: 1, callId: 'call-2', name: 'bash', arguments: '{"cmd":"exit 1"}' },
    },
    {
      seq: 13,
      time: 3250,
      type: 'tool/result',
      data: {
        turn: 2,
        step: 1,
        message: {
          role: 'tool',
          toolCallId: 'call-2',
          isError: true,
          content: [{ type: 'text', text: 'Command exited with 1' }],
        },
        error: { name: 'ToolError', code: 'EXIT_1', reason: 'Non-zero exit code' },
      },
    },
    { seq: 14, time: 3300, type: 'turn/end', data: { turn: 2, reason: { kind: 'completed' } } },
  ];

  for (const ev of events) {
    bridge.onSessionEvent(session, ev);
  }

  const spans = exporter.getFinishedSpans();
  assert.equal(spans.length, 5);

  const turnSpans = spans.filter((s) => s.attributes['traceroot.span.type'] === 'AGENT');
  assert.equal(turnSpans.length, 2);
  assert.notEqual(turnSpans[0].spanContext().traceId, turnSpans[1].spanContext().traceId);
  assert.equal(turnSpans[0].attributes['traceroot.trace.session_id'], 'sess-dsh-1');
  assert.equal(turnSpans[1].attributes['traceroot.trace.session_id'], 'sess-dsh-1');
  assert.equal(turnSpans[0].attributes['traceroot.span.input'], 'Check package.json');
  assert.equal(turnSpans[0].attributes['traceroot.span.output'], 'Reading package.json...');

  const llmSpan = spans.find((s) => s.attributes['traceroot.span.type'] === 'LLM');
  assert.ok(llmSpan);
  assert.equal(llmSpan.spanContext().traceId, turnSpans[0].spanContext().traceId);
  assert.equal(llmSpan.attributes['gen_ai.request.model'], 'deepseek-chat');
  assert.equal(llmSpan.attributes['gen_ai.system'], 'deepseek');
  assert.equal(llmSpan.attributes['gen_ai.usage.input_tokens'], 120);
  assert.equal(llmSpan.attributes['gen_ai.usage.output_tokens'], 25);
  assert.equal(llmSpan.attributes['gen_ai.usage.cache_read.input_tokens'], 40);

  const toolSpans = spans.filter((s) => s.attributes['traceroot.span.type'] === 'TOOL');
  assert.equal(toolSpans.length, 2);
  assert.equal(toolSpans[0].attributes['gen_ai.tool.name'], 'read_file');
  assert.equal(toolSpans[0].attributes['gen_ai.tool.call.arguments'], '{"path":"package.json"}');
  assert.equal(toolSpans[0].attributes['gen_ai.tool.call.result'], '{"name":"demo"}');
  assert.equal(toolSpans[0].status.code, SpanStatusCode.UNSET);

  assert.equal(toolSpans[1].attributes['gen_ai.tool.name'], 'bash');
  assert.equal(toolSpans[1].status.code, SpanStatusCode.ERROR);
  assert.equal(toolSpans[1].status.message, 'Non-zero exit code');
});

test('missing API key logs a warning and does not register listeners or throw', () => {
  const prevKey = process.env.TRACEROOT_API_KEY;
  delete process.env.TRACEROOT_API_KEY;
  try {
    const warnings: string[] = [];
    let registered = 0;
    const ctx: CordisContext = {
      logger: {
        warn(msg: string) {
          warnings.push(msg);
        },
      },
      on() {
        registered += 1;
        return () => {};
      },
      effect() {
        return () => {};
      },
    };

    apply(ctx, {});
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /TRACEROOT_API_KEY/);
    assert.equal(registered, 0);
  } finally {
    if (prevKey !== undefined) process.env.TRACEROOT_API_KEY = prevKey;
  }
});

test('resolveConfig prefers explicit config over env and normalizes hostUrl', () => {
  const resolved = resolveConfig(
    { apiKey: 'cfg-key', hostUrl: 'https://self-hosted.example.com/' },
    { TRACEROOT_API_KEY: 'env-key', TRACEROOT_HOST_URL: 'https://ignored.example.com' },
  );
  assert.equal(resolved.enabled, true);
  assert.equal(resolved.apiKey, 'cfg-key');
  assert.equal(resolved.otlpEndpoint, 'https://self-hosted.example.com/api/v1/public/traces');
});

test('package.json and cordis.patch.yml declare valid dsh bundle metadata', () => {
  const root = join(import.meta.dirname, '..', '..');
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as {
    name: string;
    dsh?: { bundle?: { patch?: string } };
  };
  assert.equal(pkg.name, '@traceroot-ai/deepseek-harness');
  assert.equal(pkg.dsh?.bundle?.patch, './cordis.patch.yml');

  const patch = readFileSync(join(root, 'cordis.patch.yml'), 'utf8');
  assert.match(patch, /@traceroot-ai\/deepseek-harness/);
});
