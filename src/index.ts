import { resolveConfig } from './config.js';
import { createOtelRuntime } from './otlp.js';
import { DshTraceBridge } from './tracer.js';
import type { CordisContext, PluginConfig } from './types.js';

export const name = 'traceroot';

export { resolveConfig } from './config.js';
export { createOtelRuntime } from './otlp.js';
export { DshTraceBridge } from './tracer.js';
export type { CordisContext, DshSession, DshSessionEvent, PluginConfig } from './types.js';

export function apply(ctx: CordisContext, config: PluginConfig = {}): void {
  const resolved = resolveConfig(config);
  if (!resolved.enabled) {
    if (config.enabled !== false && !resolved.apiKey) {
      const msg =
        '[traceroot] TRACEROOT_API_KEY is not set; DeepSeek Harness tracing is disabled.';
      if (ctx.logger) {
        ctx.logger.warn(msg);
      } else {
        console.warn(msg);
      }
    }
    return;
  }

  const runtime = createOtelRuntime(resolved);
  const bridge = new DshTraceBridge(runtime);

  ctx.on(
    'session/event',
    (session, event) => {
      bridge.onSessionEvent(session, event);
    },
    { global: true },
  );

  ctx.on(
    'session/disposed',
    (session) => {
      bridge.onSessionDisposed(session);
    },
    { global: true },
  );

  ctx.effect(() => async () => {
    await bridge.shutdown();
  });
}

export default { name, apply };
