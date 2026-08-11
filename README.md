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

Endpoints: `POST /v1/chat/completions` (stream + non-stream), `GET /v1/models[/:id]`,
`GET /healthz`. Errors come back in the OpenAI envelope (`{ error: { message, type, code } }`)
with mapped statuses (401 missing/invalid key, 429 rate limit, 404 model not found, 502 upstream).

`tool_choice` and `response_format` are passed through to the underlying provider: OpenAI-style
values (`auto`/`none`/`required`/`{type:"function",...}`, `json_object`, `json_schema`) are
normalized and mapped per provider — Anthropic gets `tool_choice: {type: "tool"|"any"|...}` plus a
JSON system hint, Ollama gets `tool_choice` + `format`, and the mock honors `none`.

> The bridge makes the agent *loop* possible, but tool-call *quality* is the model's job —
> models without function-calling training will still emit prose instead of JSON tool calls.
> Google-specific extras (native AGENTS.md scanning, Gemini Interactions caching, AppFunctions)
> remain on Studio's first-party path; the bridge covers the BYOK endpoint route.

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
* Streaming tool-call chaining helper
* Usage/cost tracking hooks
* React hooks (`useChat`, `useStream`) for the BYOK UI
* More local providers (vLLM, llama.cpp, KoboldCpp)

## License

MIT
