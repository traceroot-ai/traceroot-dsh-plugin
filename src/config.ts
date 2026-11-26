import type { PluginConfig } from './types.js';

export const DEFAULT_HOST_URL = 'https://app.traceroot.ai';
export const DEFAULT_SERVICE_NAME = 'deepseek-harness';

export interface ResolvedConfig {
  enabled: boolean;
  apiKey: string;
  hostUrl: string;
  otlpEndpoint: string;
  environment: string | undefined;
  serviceName: string;
}

function nonEmpty(value: string | undefined): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

export function normalizeHostUrl(raw: string): string {
  return raw.replace(/\/+$/, '');
}

export function resolveConfig(
  config: PluginConfig = {},
  env: Record<string, string | undefined> = process.env,
): ResolvedConfig {
  const apiKey = nonEmpty(config.apiKey) ?? nonEmpty(env.TRACEROOT_API_KEY) ?? '';
  const rawHost = nonEmpty(config.hostUrl) ?? nonEmpty(env.TRACEROOT_HOST_URL) ?? DEFAULT_HOST_URL;
  const hostUrl = normalizeHostUrl(rawHost);
  const environment = nonEmpty(config.environment) ?? nonEmpty(env.TRACEROOT_ENVIRONMENT);
  const serviceName = nonEmpty(config.serviceName) ?? DEFAULT_SERVICE_NAME;
  const enabled = config.enabled !== false && apiKey.length > 0;

  return {
    enabled,
    apiKey,
    hostUrl,
    otlpEndpoint: `${hostUrl}/api/v1/public/traces`,
    environment,
    serviceName,
  };
}
