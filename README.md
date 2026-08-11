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

> Note: Zen routes some families to native protocols (GPT models → `/responses`, Claude/Qwen/MiniMax →
> `/messages`, Gemini → native). The OpenAI-compatible path covers all models listed on those endpoints;
> dedicated native adapters for those families are planned.

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

## Development

```bash
npm install
npm run typecheck   # tsc --noEmit
npm test            # vitest run
npm run build       # tsup → dist (ESM + CJS + types)
npm run example     # runs with the mock provider; set OPENCODE_ZEN_API_KEY or
                    # OPENCODE_GO_API_KEY to hit the real gateways
```

## Roadmap

* Native Zen adapters for `/responses` (GPT family) and `/messages` (Claude family) routing
* Streaming tool-call chaining helper
* Usage/cost tracking hooks
* React hooks (`useChat`, `useStream`) for the BYOK UI
* More local providers (vLLM, llama.cpp, KoboldCpp)

## License

MIT
