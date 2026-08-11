/**
 * Android Studio bridge — ModelHitch as an OpenAI-compatible local endpoint.
 *
 * Run this, then point Android Studio's agentic tools (or any IDE that
 * accepts a custom model endpoint) at the printed URL:
 *
 *   npx tsx examples/studio-bridge.ts
 *
 * - Model routing: "providerId/modelId" (e.g. "opencode-zen/big-pickle",
 *   "anthropic/claude-sonnet-4-5", "ollama/llama3.2"); bare ids go to the
 *   default provider (opencode-zen here).
 * - Keys resolve locally: OPENCODE_ZEN_API_KEY / OPENCODE_GO_API_KEY env vars
 *   (or the server `apiKeys` map), then the keystore, then provider env vars.
 * - The /v1/models catalog advertises the curated OpenCode Zen/Go model lists
 *   so they show up in the IDE's model picker without a network round-trip.
 * - auto-mode is ON: if a lane gets rate-limited (429 — including OpenCode
 *   usage-limit blocks), 5xx, or a network blip, the bridge transparently
 *   fails over to the cheap Go model, then free Zen models. See
 *   https://opencode.ai/docs/go#usage-limits.
 * - Usage telemetry: GET /v1/usage (JSON) or open /usage in a browser for a
 *   live dashboard — tokens, estimated spend, and how close you are to the
 *   Go 5h/$12, 7d/$30, 30d/$60 usage limits.
 */
import {
  createModelHitchServer,
  OPENCODE_GO_MODELS,
  OPENCODE_ZEN_MODELS,
  UsageTracker,
} from '../src/index.js';

const PORT = Number(process.env.MODELHITCH_PORT ?? 3939);
const HOST = '127.0.0.1';
const MAX_BODY_BYTES = Number(process.env.MODELHITCH_MAX_BODY_BYTES ?? 64 * 1024 * 1024);

async function main() {
  const usage = new UsageTracker();
  const server = createModelHitchServer({
    defaultProviderId: 'opencode-zen',
    staticModels: {
      'opencode-zen': [...OPENCODE_ZEN_MODELS],
      'opencode-go': [...OPENCODE_GO_MODELS],
    },
    maxBodyBytes: MAX_BODY_BYTES,
    autoMode: true,
    usageTracker: usage,
    logger: (line) => console.log(line),
    onFailover: (event) =>
      console.log(
        `[auto-mode] ${event.from.providerId}/${event.from.model} -> ${event.to.providerId}/${event.to.model} (${event.error.code}${event.error.status ? ` HTTP ${event.error.status}` : ''})`,
      ),
  });

  const { url } = await server.listen(PORT, HOST);
  console.log(`
=== ModelHitch bridge listening on ${url} ===

Point Android Studio's custom model endpoint (or any OpenAI-compatible
client) at:

  Base URL:   ${url}/v1
  API key:    any value (keys are resolved locally, never sent out)

Models: pick from the /v1/models catalog, e.g.
  opencode-zen/big-pickle     (requires OPENCODE_ZEN_API_KEY)
  opencode-go/deepseek-v4-flash (requires OPENCODE_GO_API_KEY)
  mock/mock-model             (no key — deterministic demo)

auto-mode: ON — 429/5xx/network failures fail over to
  opencode-go/deepseek-v4-flash -> opencode-zen/big-pickle ->
  opencode-zen/deepseek-v4-flash-free -> opencode-zen/mimo-v2.5-free

Usage telemetry:
  JSON:       curl ${url}/v1/usage
  Dashboard:  open ${url}/usage in a browser

Quick smoke test (streaming):
  curl -N ${url}/v1/chat/completions ^
    -H "Content-Type: application/json" ^
    -d "{\"model\":\"mock/mock-model\",\"stream\":true,\"messages\":[{\"role\":\"user\",\"content\":\"hello\"}]}"

Press Ctrl+C to stop.
`);
}

main().catch((err) => {
  console.error('Failed to start bridge:', err);
  process.exit(1);
});
