import { type Tracer } from '@opentelemetry/api';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-proto';
import { Resource } from '@opentelemetry/resources';
import { BatchSpanProcessor, type SpanProcessor } from '@opentelemetry/sdk-trace-base';
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node';
import type { ResolvedConfig } from './config.js';

export interface OtelRuntime {
  tracer: Tracer;
  forceFlush(): Promise<void>;
  shutdown(): Promise<void>;
}

const TRACER_NAME = '@traceroot-ai/deepseek-harness';
const EXPORT_TIMEOUT_MS = 4000;

export function createOtelRuntime(
  config: ResolvedConfig,
  customSpanProcessor?: SpanProcessor,
): OtelRuntime {
  const resourceAttrs: Record<string, string> = {
    'service.name': config.serviceName,
  };
  if (config.environment) {
    resourceAttrs['deployment.environment'] = config.environment;
  }

  const processor =
    customSpanProcessor ??
    new BatchSpanProcessor(
      new OTLPTraceExporter({
        url: config.otlpEndpoint,
        headers: config.apiKey ? { Authorization: `Bearer ${config.apiKey}` } : {},
        timeoutMillis: EXPORT_TIMEOUT_MS,
      }),
      {
        maxQueueSize: 1024,
        maxExportBatchSize: 64,
        exportTimeoutMillis: 5000,
      },
    );

  const provider = new NodeTracerProvider({
    resource: Resource.default().merge(new Resource(resourceAttrs)),
    spanLimits: {
      attributeCountLimit: 256,
    },
  });
  provider.addSpanProcessor(processor);

  return {
    tracer: provider.getTracer(TRACER_NAME),
    forceFlush: () => provider.forceFlush(),
    shutdown: () => provider.shutdown(),
  };
}
