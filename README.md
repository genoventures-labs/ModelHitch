# ModelHitch

**Tagline:** Hitch any model to your app.

ModelHitch is a plug-and-play **BYOK** (bring-your-own-key) integration layer for applications.
It lets developers add support for user-supplied AI providers, models, or API keys without
tightly coupling their product to a single AI vendor.

Integrate once — then let each end user connect the AI provider or model they already use.

> ModelHitch is not an AI model. It is the attachment point between an application and the
> model the user chooses to bring.

## What it does

* **One normalized interface** — `chat()` and `stream()` that speak the same types for every provider.
* **Provider adapters** — OpenAI-compatible, Anthropic, Ollama, and the OpenCode gateways out of the box.
* **BYOK credential handling** — user keys stay client-side; never touch your backend.
* **Streaming normalization** — every provider's stream becomes the same `StreamChunk` events.
* **Capability detection** — ask a provider what it can do (`streaming`, `toolCalling`, `vision`, …).
* **Error normalization** — one `ModelHitchError` with stable codes (`invalid-api-key`, `rate-limited`, …).
* **Easy embedding** — one package, works in Node ≥18, browsers, and edge runtimes.

## Quickstart

```ts
import { ModelHitch } from 'modelhitch';

const mh = new ModelHitch();

// Non-streaming
const result = await mh.chat({
  provider: 'opencode-zen',        // switch providers without changing your code
  model: 'big-pickle',             // free model on Zen — zero cost to try
  messages: [{ role: 'user', content: 'Hello!' }],
});
console.log(result.message.content);

// Streaming — normalized events across every provider
const stream = await mh.stream({
  provider: 'opencode-go',
  model: 'deepseek-v4-flash',
  messages: [{ role: 'user', content: 'Write a haiku about hitches.' }],
});
for await (const chunk of stream) {
  if (chunk.type === 'text-delta') process.stdout.write(chunk.text);
}
```

## Providers

| Provider | id | Base URL | API key |
| --- | --- | --- | --- |
| **OpenCode Zen** | `opencode-zen` | `https://opencode.ai/zen/v1` | `OPENCODE_ZEN_API_KEY` |
| **OpenCode Go** | `opencode-go` | `https://opencode.ai/zen/go/v1` | `OPENCODE_GO_API_KEY` |
| OpenAI | `openai` | `https://api.openai.com/v1` | `OPENAI_API_KEY` |
| Anthropic | `anthropic` | `https://api.anthropic.com/v1` | `ANTHROPIC_API_KEY` |
| Groq | `groq` | `https://api.groq.com/openai/v1` | `GROQ_API_KEY` |
| OpenRouter | `openrouter` | `https://openrouter.ai/api/v1` | `OPENROUTER_API_KEY` |
| Together AI | `together` | `https://api.together.xyz/v1` | `TOGETHER_API_KEY` |
| LM Studio (local) | `lmstudio` | `http://localhost:1234/v1` | — |
| Ollama (local) | `ollama` | `http://localhost:11434` | — |
| Mock (deterministic) | `mock` | — | — |

Both `opencode-zen` and `opencode-go` also accept `OPENCODE_API_KEY` as a fallback env var.

### OpenCode Zen & Go

[Zen](https://opencode.ai/docs/zen) is OpenCode's curated gateway to premium models (pay-as-you-go);
[Go](https://opencode.ai/docs/go) is the low-cost subscription ($5 first month, then $10/mo) for tested
open coding models. Both authenticate with an API key from [opencode.ai/auth](https://opencode.ai/auth)
and expose an OpenAI-compatible API, so ModelHitch serves them through the shared OpenAI-compatible adapter —
a preconfigured instance is all it takes to add a whole new gateway.

**Zen models** — free ones are great for testing:

```
big-pickle            (free)          deepseek-v4-flash-free   (free)
gpt-5.6-luna          gpt-5.5         gpt-5.4-mini             gpt-5.4-nano
claude-haiku-4-5      claude-sonnet-4-5
gemini-3.5-flash-lite gemini-3-flash
grok-4.5              deepseek-v4-pro deepseek-v4-flash
kimi-k3               kimi-k2.6       glm-5.2                  glm-5.1
qwen3.7-plus          minimax-m3      minimax-m2.7
```

**Go models**:

```
deepseek-v4-flash     deepseek-v4-pro grok-4.5    gpt-5.6-luna
glm-5.2               glm-5.1         kimi-k3     kimi-k2.7-code
kimi-k2.6             mimo-v2.5       mimo-v2.5-pro
minimax-m3            minimax-m2.7    qwen3.8-max qwen3.7-max
qwen3.7-plus          qwen3.6-plus    hy3
```

Both expose live discovery: `mh.listModels('opencode-zen')` hits `GET https://opencode.ai/zen/v1/models`
(and `…/zen/go/v1/models` for Go) to return the up-to-date list.

### Native Zen protocol routing

Zen doesn't serve every family through the same wire protocol — `opencode-zen` automatically picks the
right one per model family, so one provider id, one key, and every model just works:

| Model family | Zen endpoint | Protocol |
| --- | --- | --- |
| `gpt-*`, `grok-*` | `/zen/v1/responses` | OpenAI Responses API |
| `claude-*`, `qwen*` | `/zen/v1/messages` | Anthropic Messages API |
| `gemini-*` | `/zen/v1/models/{id}:generateContent` | Google native GenerateContent |
| everything else | `/zen/v1/chat/completions` | OpenAI-compatible |

The routing is exposed as `zenProtocolForModel(model)` and the per-protocol adapters are also available
standalone for advanced use:

```ts
import {
  createZenResponsesProvider,
  createZenMessagesProvider,
  createZenGeminiProvider,
} from 'modelhitch';

// GPT/Grok family — OpenAI Responses API (input items, output_text/function_call)
const zenResponses = createZenResponsesProvider();

// Claude/Qwen family — Anthropic Messages API
const zenMessages = createZenMessagesProvider();

// Gemini family — Google native GenerateContent (functionCall/functionResponse)
const zenGemini = createZenGeminiProvider();
```

All three accept an `OPENCODE_ZEN_API_KEY` (falling back to `OPENCODE_API_KEY`). Gemini goes to
`https://opencode.ai/zen/v1/models/{model}:generateContent` (streaming: `:streamGenerateContent?alt=sse`)
and authenticates with the `x-goog-api-key` header, exactly like the native Google API.

## BYOK — end-user keys stay on the device

Pass a `KeyStore` to `ModelHitch` and let users store their own keys. In a browser, keys live in
`localStorage` and calls go **directly** from the user's device to the provider — your backend never
sees a key:

```ts
import { ModelHitch, LocalStorageKeyStore } from 'modelhitch';

const mh = new ModelHitch({ keystore: new LocalStorageKeyStore() });

// In your "connect provider" UI:
await mh.keystore!.set('opencode-zen', userPastedKey);
await mh.keystore!.set('anthropic', userPastedKey);

// Later — no key handling in app code:
const result = await mh.chat({
  provider: 'anthropic',
  messages: [{ role: 'user', content: 'Hello!' }],
});
```

Resolution order per call: explicit `apiKey`/`baseUrl` option → `KeyStore` → provider env var
(`OPENCODE_ZEN_API_KEY`, etc.). `MemoryKeyStore` is provided for server-side use.

## Streaming events

Every provider's stream is normalized to the same events:

```ts
type StreamChunk =
  | { type: 'text-delta'; text: string }
  | { type: 'tool-call-start'; id: string; name: string }
  | { type: 'tool-call-args-delta'; id: string; argsDelta: string }
  | { type: 'tool-call-end'; id: string }
  | { type: 'finish'; finishReason: string; usage?: Usage };
```

`aggregateStream()` collapses any stream back into a `ChatResult`:

```ts
import { aggregateStream } from 'modelhitch';

const stream = await mh.stream({ provider: 'ollama', model: 'llama3.2', messages });
const result = await aggregateStream(stream);
```

## Tool calling

Tools are declared once, in a provider-agnostic form, and work across OpenAI-compatible,
Anthropic, and Ollama:

```ts
const result = await mh.chat({
  provider: 'opencode-go',
  messages: [{ role: 'user', content: 'What is the weather in Tokyo?' }],
  tools: [{
    name: 'get_weather',
    description: 'Get current weather for a city',
    parameters: {
      type: 'object',
      properties: { city: { type: 'string' } },
      required: ['city'],
    },
  }],
});

if (result.finishReason === 'tool-calls') {
  for (const call of result.message.toolCalls!) {
    console.log(call.name, call.arguments);
  }
}
```

## Error handling

```ts
import { ModelHitchError } from 'modelhitch';

try {
  await mh.chat({ provider: 'opencode-zen', messages });
} catch (err) {
  if (err instanceof ModelHitchError) {
    switch (err.code) {
      case 'invalid-api-key': /* show "key looks wrong" UI */ break;
      case 'rate-limited':    /* back off, retry */ break;
      case 'missing-api-key': /* prompt user to connect a provider */ break;
    }
  }
}
```

Codes: `missing-api-key`, `invalid-api-key`, `rate-limited`, `model-not-found`,
`provider-not-found`, `provider-error`, `network-error`, `bad-request`.

## Custom providers

Any provider with an OpenAI-compatible API is a one-liner — that's the whole point:

```ts
import { createOpenAICompatibleProvider } from 'modelhitch';

export const myGateway = createOpenAICompatibleProvider({
  id: 'my-gateway',
  name: 'My Gateway',
  baseUrl: 'https://gateway.example.com/v1',
  defaultModel: 'my-model',
  apiKeyEnvVar: 'MY_GATEWAY_API_KEY',
});
```

Implement the full `Provider` interface (`chat`, `stream`, `capabilities`, optional `listModels`)
for anything else.

## Agentic IDE bridge (Android Studio, JetBrains, ...)

ModelHitch can serve as a **local OpenAI-compatible endpoint**, so agentic IDEs that accept a
"custom model endpoint" can drive every registered provider — tools, multi-turn roles, and SSE
streaming included. This is how you run Android Studio's Agent Mode against OpenCode Zen/Go,
Anthropic, Ollama, or any other harness provider.

```bash
npx tsx examples/studio-bridge.ts   # or: npm run bridge
```

```
=== ModelHitch bridge listening on http://127.0.0.1:3939 ===

Point Android Studio's custom model endpoint at:
  Base URL:   http://127.0.0.1:3939/v1
  API key:    any value (keys are resolved locally, never sent out)
```

Then, in Android Studio: **Settings → Gemini → model endpoint (or your IDE's custom endpoint
setting)** → paste `http://127.0.0.1:3939/v1`. Model ids from `GET /v1/models` show up in the
picker; keys are resolved per provider on your machine (`apiKeys` map → `KeyStore` → env var),
never sent anywhere.

**Model routing** — prefix a model id with a provider to target it explicitly; bare ids go to the
default provider:

| Request model | Routes to |
| --- | --- |
| `opencode-zen/big-pickle` | OpenCode Zen, model `big-pickle` |
| `opencode-go/deepseek-v4-flash` | OpenCode Go, model `deepseek-v4-flash` |
| `anthropic/claude-sonnet-4-5` | Anthropic, model `claude-sonnet-4-5` |
| `ollama/llama3.2` | local Ollama |
| `big-pickle` (no prefix) | default provider's `big-pickle` |

```ts
import { createModelHitchServer, OPENCODE_GO_MODELS, OPENCODE_ZEN_MODELS } from 'modelhitch';

const server = createModelHitchServer({
  defaultProviderId: 'opencode-zen',
  staticModels: {           // advertise curated lists in GET /v1/models
    'opencode-zen': [...OPENCODE_ZEN_MODELS],
    'opencode-go': [...OPENCODE_GO_MODELS],
  },
  logger: console.log,      // one line per request
});
const { url } = await server.listen(3939, '127.0.0.1');
```

Endpoints: `POST /v1/chat/completions` (stream + non-stream), `POST /v1/responses` (stream +
non-stream — Codex CLI / Responses-API clients), `POST /v1/messages` (stream + non-stream —
Claude Code / Anthropic-format gateways, plus `POST /v1/messages/count_tokens`), `GET
/v1/models[/:id]`, `GET /healthz`. Errors come back in the request's own envelope —
OpenAI-style (`{ error: { message, type, code } }`) on `/chat/completions` and `/responses`,
Anthropic-style (`{ type: "error", error: { type, message } }`) on `/v1/messages` — with
mapped statuses (401 missing/invalid key, 429 rate limit, 404 model not found, 502 upstream).

`tool_choice` and `response_format` are passed through to the underlying provider: OpenAI-style
values (`auto`/`none`/`required`/`{type:"function",...}`, `json_object`, `json_schema`) are
normalized and mapped per provider — Anthropic gets `tool_choice: {type: "tool"|"any"|...}` plus a
JSON system hint, Ollama gets `tool_choice` + `format`, and the mock honors `none`.

> The bridge makes the agent *loop* possible, but tool-call *quality* is the model's job —
> models without function-calling training will still emit prose instead of JSON tool calls.
> Google-specific extras (native AGENTS.md scanning, Gemini Interactions caching, AppFunctions)
> remain on Studio's first-party path; the bridge covers the BYOK endpoint route.

### Codex CLI as a client

Codex's custom model providers (`model_providers.<id>` in `~/.codex/config.toml`) speak **only**
the OpenAI *Responses API* (`wire_api = "responses"` is the only supported value), so the bridge
exposes the same protocol at `POST /v1/responses` — same family routing, tools, multi-turn
function_call / function_call_output items, and SSE streaming.

1. Start the bridge: `npm run bridge`
2. Add this to your **user-level** `~/.codex/config.toml` (project-scoped `.codex/config.toml`
   cannot set `model_providers`):

```toml
model_provider = "modelhitch"
model = "opencode-zen/gpt-5.6-luna"   # any id from GET /v1/models

[model_providers.modelhitch]
name = "ModelHitch (OpenCode Zen via local bridge)"
base_url = "http://127.0.0.1:3939/v1"   # Codex appends /responses and /models
```

3. Run `codex`. Model ids from `GET /v1/models` work as-is (`opencode-zen/...`, `opencode-go/...`,
   bare ids for the default provider); each request is routed by family
   (`gpt-*/grok-*` → `/responses`, `claude-*/qwen*` → `/messages`, `gemini-*` → Google native,
   everything else → `/chat/completions`).

Notes:

- **Don't set `env_key`** — the bridge resolves keys locally (`apiKeys` → `KeyStore` → env var),
  so Codex sends no key at all. `experimental_bearer_token` is only needed if you want Codex to
  present one (any value is accepted and ignored).
- There's no `wire_api` line above because `responses` is the default; you can write
  `wire_api = "responses"` explicitly for clarity.
- `openai_base_url` is *not* used here — that only redirects the built-in `openai` provider, and
  custom providers are more flexible (no OpenAI auth assumptions).
- To flip back to OpenAI models, wrap the block in a profile:
  `~/.codex/modelhitch.config.toml` + `codex --profile modelhitch`.
- Responses-only knobs (`model_reasoning_effort`, `model_verbosity`, ...) are accepted but
  ignored; unsupported request fields are dropped by the bridge before routing.

See `examples/codex.config.toml` for a copy-paste template.

### Claude Code as a client

Claude Code talks to any LLM **gateway** through the Anthropic *Messages API*: set
`ANTHROPIC_BASE_URL` to a custom base URL and Claude Code treats it as an Anthropic-format
endpoint, passing **any** model id through unchecked (model-name validation only runs against
the real Anthropic API). The bridge exposes that wire at `POST /v1/messages`, so Claude Code
gets the same family routing, tools, multi-turn `tool_use` / `tool_result` blocks, and SSE
streaming as every other client.

1. Start the bridge: `npm run bridge`
2. Export the gateway env vars in your shell (Claude Code reads these):

```bash
export ANTHROPIC_BASE_URL="http://127.0.0.1:3939"     # no /v1 — Claude Code appends /v1/messages
export ANTHROPIC_AUTH_TOKEN="local-bridge"            # any dummy value — the bridge resolves keys itself
export ANTHROPIC_DEFAULT_SONNET_MODEL="deepseek-v4-flash"   # or any id from GET /v1/models
```

3. Run `claude`. Each request is routed by family (`gpt-*/grok-*` → `/responses`,
   `claude-*/qwen*` → `/messages`, `gemini-*` → Google native, everything else →
   `/chat/completions`); `--model`, `ANTHROPIC_MODEL`, and the
   `ANTHROPIC_DEFAULT_{SONNET,OPUS,HAIKU,FABLE}_MODEL` aliases all work as model pins.

Notes:

- **Always stream** — the gateway contract requires inference responses to be streamed as
  Anthropic SSE events (`message_start` → `content_block_*` → `message_delta` → `message_stop`,
  with keep-alive `ping` events while the upstream model thinks). Non-stream works for curl but
  Claude Code always streams.
- **Don't set `ANTHROPIC_API_KEY`** — the bridge resolves keys locally (`apiKeys` → `KeyStore`
  → env var), so `ANTHROPIC_AUTH_TOKEN` just needs to be *present* (any value) to stop Claude
  Code from opening its claude.ai login flow.
- Claude Code's extras are stripped before routing: `thinking` (it sends
  `{type: "adaptive"}` for unknown gateway model names — upstream non-Anthropic models 400 on
  it), `context_management`, `output_config`, `metadata`, and the `anthropic-beta` header are
  all ignored, never rejected.
- `tool_use` blocks carry `input` as a JSON **object** (not a string); the bridge converts to
  the per-provider shape and back.
- **Model discovery is optional** (off by default — needs
  `CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY=1`) and Claude Code only keeps discovery results
  whose id contains `claude`/`anthropic`, so it's simplest to pin models with
  `ANTHROPIC_DEFAULT_*_MODEL` / `--model` as above.
- `POST /v1/messages/count_tokens` is served with a cheap char-count estimate, so Claude Code
  never has to fall back to a counting inference call.

### Gemini CLI as a client

Gemini CLI talks to any **Google Generative Language** endpoint: set
`GOOGLE_GEMINI_BASE_URL` to a custom base URL (HTTPS is required *unless* it points at
localhost — `http://127.0.0.1:3939` is fine) and Gemini CLI treats the bridge as a Google
backend, passing model ids through in the URL path. The bridge exposes that wire at
`POST /v1beta/models/{model}:generateContent` (and `:streamGenerateContent?alt=sse`), so
Gemini CLI gets the same family routing, tools, multi-turn `functionCall` /
`functionResponse` parts, and SSE streaming as every other client.

1. Start the bridge: `npm run bridge`
2. Export the gateway env vars in your shell (Gemini CLI reads these):

```bash
export GOOGLE_GEMINI_BASE_URL="http://127.0.0.1:3939"   # no /v1beta — Gemini CLI appends /v1beta/models/...
export GEMINI_API_KEY="local-bridge"                     # any dummy value — the bridge resolves keys itself
export GEMINI_MODEL="gemini-3.5-flash-lite"              # or any id from GET /v1/models
```

3. Run `gemini`. Requests are routed by family (`gemini-*` → Google native outbound,
   everything else → the matching wire); `GEMINI_MODEL`, `--model`, and per-provider
   `modelConfigs` in `settings.json` all work as model pins.

Notes:

- **Always stream** — Gemini CLI uses `:streamGenerateContent?alt=sse` for inference; the
  bridge emits one partial `GenerateContentResponse` JSON per `data:` line (no `[DONE]`
  sentinel, matching the real API). Non-stream `:generateContent` works for curl.
- **Don't set a real `GEMINI_API_KEY`** — the bridge resolves keys locally (`apiKeys` →
  `KeyStore` → env var); the incoming `x-goog-api-key` header is read for auth presence only
  (any value works).
- **`functionCall.args` is a JSON *object*** on the Google wire (not a string like OpenAI);
  streaming carries partial JSON-string `args` deltas that concatenate into the object. Tool
  results come back as `functionResponse` parts keyed by function **name** — the bridge
  matches them to the previous call id per turn.
- **Thinking models** (`gemini-*` thinking variants) echo a `thoughtSignature` next to each
  `functionCall`; the bridge carries it through turn 2 so multi-turn tool loops don't 400.
- Gemini CLI extras are stripped before routing: `safetySettings`, `cachedContent`,
  `userAgent`, `googleSearch` / `urlContext` tool definitions, and `thinkingConfig` are all
  ignored, never rejected.
- Model ids live in the **URL path** (`/v1beta/models/{model}:generateContent`), so
  `provider/model` prefixes route exactly like every other wire; `v1alpha` / `v1` path
  prefixes are tolerated for clients that pin `GOOGLE_GENAI_API_VERSION`.

### Other agent harnesses

Every harness below has a "custom endpoint" knob that points at one of the four wires the
bridge speaks, so they all get the same family routing, tools, multi-turn, and streaming with
**no bridge changes**. Model ids come from `GET /v1/models` (or just use any bare id for the
default provider).

| Harness | Wire used | Key knob | Base URL to use |
|---|---|---|---|
| Codex CLI | Responses | `base_url` in `~/.codex/config.toml` | `http://127.0.0.1:3939/v1` |
| Claude Code | Anthropic Messages | `ANTHROPIC_BASE_URL` | `http://127.0.0.1:3939` |
| Gemini CLI | Google native | `GOOGLE_GEMINI_BASE_URL` | `http://127.0.0.1:3939` |
| Aider | chat-completions (or Messages) | `--openai-api-base` (or `ANTHROPIC_BASE_URL`) | `http://127.0.0.1:3939/v1` |
| Continue (VS Code) | chat-completions (or Messages) | `apiBase` in `~/.continue/config.yaml` | `http://127.0.0.1:3939/v1` |
| Cline / Roo / Kilo (VS Code) | chat-completions (or Messages) | provider "OpenAI Compatible" | `http://127.0.0.1:3939/v1` |
| Goose (Block) | chat-completions (or Messages) | `GOOSE_PROVIDER__HOST` env | `http://127.0.0.1:3939/v1` |
| OpenCode CLI | chat-completions (or Messages) | provider `@ai-sdk/openai-compatible` | `http://127.0.0.1:3939/v1` |
| Zed | chat-completions | `provider` in `settings.json` | `http://127.0.0.1:3939/v1` |
| Qoder, OpenHands, anything OpenAI-compatible | chat-completions | any "OpenAI API base" field | `http://127.0.0.1:3939/v1` |

> The bridge resolves API keys itself (`apiKeys` → `KeyStore` → env var), so every snippet uses
> a **dummy key** — the harness never needs your real key. `anthropic`-wire variants (Aider,
> Continue, Cline, Goose, OpenCode) use `http://127.0.0.1:3939` (no `/v1`) and a dummy
> `ANTHROPIC_AUTH_TOKEN`-style key; chat-completions variants use `http://127.0.0.1:3939/v1`.
> Exact key names drift between harness versions — when in doubt, point the harness's
> "custom OpenAI base URL" field at the `/v1` URL and pick a model id from `GET /v1/models`.

**Aider**
```bash
aider --openai-api-base http://127.0.0.1:3939/v1 --openai-api-key dummy \
      --model openai/deepseek-v4-flash
# Anthropic wire instead:
#   export ANTHROPIC_BASE_URL=http://127.0.0.1:3939
#   aider --model anthropic/deepseek-v4-flash
```

**Continue** — `~/.continue/config.yaml`
```yaml
models:
  - name: deepseek-v4-flash
    provider: openai
    apiBase: http://127.0.0.1:3939/v1
    apiKey: dummy
```

**Cline / Roo Code / Kilo Code** — add an "OpenAI Compatible" provider in the extension settings:
```
Base URL:  http://127.0.0.1:3939/v1
API key:   dummy            # any value; the bridge ignores it
Model id:  deepseek-v4-flash  # or any id from GET /v1/models
```

**Goose (Block)** — `~/.config/goose/config.yaml` (or env vars)
```yaml
GOOSE_PROVIDER__TYPE: openai
GOOSE_PROVIDER__HOST: http://127.0.0.1:3939/v1
GOOSE_PROVIDER__TOKEN: dummy
GOOSE_MODEL: deepseek-v4-flash
```

**OpenCode CLI** — `opencode.json`
```json
{
  "provider": {
    "modelhitch": {
      "npm": "@ai-sdk/openai-compatible",
      "name": "ModelHitch (OpenCode Zen via local bridge)",
      "options": { "baseURL": "http://127.0.0.1:3939/v1", "apiKey": "dummy" }
    }
  },
  "model": "modelhitch/deepseek-v4-flash"
}
```

**Zed** — `settings.json`
```json
{
  "assistant": {
    "version": "2",
    "provider": {
      "type": "openai",
      "api_url": "http://127.0.0.1:3939/v1",
      "model": { "name": "deepseek-v4-flash" }
    }
  },
  "default_model": { "provider": "modelhitch", "model": "deepseek-v4-flash" }
}
```

## Development

```bash
npm install
npm run typecheck   # tsc --noEmit
npm test            # vitest run
npm run build       # tsup → dist (ESM + CJS + types)
npm run example     # runs with the mock provider; set OPENCODE_ZEN_API_KEY or
                    # OPENCODE_GO_API_KEY to hit the real gateways
npm run bridge      # local OpenAI-compatible endpoint for agentic IDEs
npm run canary      # end-to-end tool-call test through the bridge (needs a Zen key)
```

## Roadmap

* ~~Native Zen adapters for `/responses` (GPT family) and `/messages` (Claude family) routing~~ ✅ done
* ~~`tool_choice` / `response_format` passthrough on the bridge~~ ✅ done
* ~~Gemini native adapter for Zen (`gemini-*` models)~~ ✅ done
* ~~Codex CLI wire protocol (`/v1/responses`) on the bridge~~ ✅ done
* ~~Claude Code gateway wire protocol (`/v1/messages`) on the bridge~~ ✅ done
* ~~Harness compatibility matrix (Aider, Continue, Cline, Goose, OpenCode, Zed, ...)~~ ✅ done
* ~~Gemini CLI wire protocol (`:generateContent`) on the bridge~~ ✅ done
* Streaming tool-call chaining helper
* Usage/cost tracking hooks
* React hooks (`useChat`, `useStream`) for the BYOK UI
* More local providers (vLLM, llama.cpp, KoboldCpp)

## License

MIT
