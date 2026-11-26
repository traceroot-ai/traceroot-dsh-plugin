# @traceroot-ai/deepseek-harness

TraceRoot observability plugin (Cordis) for [DeepSeek Harness (`dsh`)](https://github.com/deepseek-ai/deepseek-harness).

Captures every `dsh` turn as a TraceRoot trace grouped by session ID, with child `LLM` spans (model, token usage, input/output) and `TOOL` spans (tool name, arguments, result, error status).

## Install

```bash
dsh plugin --profile <profile> add @traceroot-ai/deepseek-harness
```

The package declares `"dsh": { "bundle": { "patch": "./cordis.patch.yml" } }`, so `dsh` activates it automatically via `cordis.patch.yml`.

## Configure

Set `TRACEROOT_API_KEY` (and `TRACEROOT_HOST_URL` for self-hosted deployments):

```bash
export TRACEROOT_API_KEY="your-traceroot-api-key"
# export TRACEROOT_HOST_URL="https://your-traceroot.example.com"
```

Or configure the `traceroot` plugin entry in your profile's `cordis.patch.yml`:

```yaml
- id: traceroot
  config:
    apiKey: !!js process.env.TRACEROOT_API_KEY
    hostUrl: https://app.traceroot.ai
```

If `TRACEROOT_API_KEY` is unset, the plugin logs a warning and leaves `dsh` unaffected.

## Development

```bash
pnpm install
pnpm run typecheck
pnpm test
```
