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
 */
import { createModelHitchServer, OPENCODE_GO_MODELS, OPENCODE_ZEN_MODELS } from '../src/index.js';

const PORT = Number(process.env.MODELHITCH_PORT ?? 3939);
const HOST = '127.0.0.1';
const MAX_BODY_BYTES = Number(process.env.MODELHITCH_MAX_BODY_BYTES ?? 64 * 1024 * 1024);

async function main() {
  const server = createModelHitchServer({
    defaultProviderId: 'opencode-zen',
    staticModels: {
      'opencode-zen': [...OPENCODE_ZEN_MODELS],
      'opencode-go': [...OPENCODE_GO_MODELS],
    },
    maxBodyBytes: MAX_BODY_BYTES,
    logger: (line) => console.log(line),
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
