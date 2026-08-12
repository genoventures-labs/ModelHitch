<p align="center">
  <img src="https://raw.githubusercontent.com/genoventures-labs/ModelHitch/main/repo_assets/repo_banner.png" alt="ModelHitch - LLM temp agency" width="100%"/>
</p>

<p align="center">
  <strong>Hitch any model to your app.</strong><br/>
  Clock in. Ship code. Do not ask questions.
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/modelhitch"><img alt="npm version" src="https://img.shields.io/npm/v/modelhitch?style=for-the-badge&color=8bd600"/></a>
  <a href="https://www.npmjs.com/package/modelhitch"><img alt="npm downloads" src="https://img.shields.io/npm/dm/modelhitch?style=for-the-badge&color=cc3f88"/></a>
  <a href="./LICENSE"><img alt="MIT license" src="https://img.shields.io/badge/license-MIT-17b8d4?style=for-the-badge"/></a>
  <img alt="Node 18 or later" src="https://img.shields.io/badge/node-%E2%89%A518-8bd600?style=for-the-badge&logo=node.js&logoColor=white"/>
  <img alt="TypeScript" src="https://img.shields.io/badge/TypeScript-ready-3178c6?style=for-the-badge&logo=typescript&logoColor=white"/>
</p>

<p align="center">
  <a href="#agent-plugins--skills"><strong>Agent plugins</strong></a> ·
  <a href="#quickstart">npm quickstart</a> ·
  <a href="#providers">Providers</a> ·
  <a href="#cli">CLI</a> ·
  <a href="#agent-bridge">Agent bridge</a> ·
  <a href="#auto-mode-survive-rate-limits">Auto-mode</a> ·
  <a href="#usage-tokens-and-spend">Usage</a> ·
  <a href="#development">Development</a>
</p>

> Provider harness by day. Temp agency for LLMs by accident.

ModelHitch is a small TypeScript BYOK integration layer. Integrate one interface, let users
bring their own keys, and route requests to the provider or model that fits the job.

## Agent plugins + skills

<p align="center">
  <img src="https://raw.githubusercontent.com/genoventures-labs/ModelHitch/main/repo_assets/All4.png" alt="ModelHitch plugins and skills for Codex, Cursor, VS Code, and Claude" width="100%"/>
</p>

<p align="center">
  <a href="./.agents/plugins/README.md"><img alt="Codex plugin" src="https://img.shields.io/badge/Codex-plugin_+_skill-8757e5?style=for-the-badge"/></a>
  <a href="./.claude/skills/README.md"><img alt="Claude skills" src="https://img.shields.io/badge/Claude-2_skills-f28c28?style=for-the-badge"/></a>
  <a href="./.cursor-plugin/README.md"><img alt="Cursor plugin" src="https://img.shields.io/badge/Cursor-plugin_+_skill-dc8cff?style=for-the-badge"/></a>
  <a href="./.github/plugin/README.md"><img alt="VS Code and Copilot plugin" src="https://img.shields.io/badge/VS_Code_+_Copilot-Agent_Plugin-2296f3?style=for-the-badge"/></a>
</p>

One routing layer, four agent surfaces, one shared source of truth. Pick your agent and clock in:

```bash
npx modelhitch setup codex    # or claude, cursor, vscode, all
```

That installs the bundled skill into the agent's personal skills directory. Add `--project` for
the current repository, `--dry-run` to preview paths, or `--force` to update an existing install.

| Agent | Get it | Install or use |
| --- | --- | --- |
| **Codex** | [Plugin guide](./.agents/plugins/README.md) | `npx modelhitch setup codex` |
| **Claude Code / Claude.ai** | [Skill guide](./.claude/skills/README.md) | `npx modelhitch setup claude` |
| **Cursor** | [Plugin guide](./.cursor-plugin/README.md) | `npx modelhitch setup cursor` |
| **VS Code / GitHub Copilot** | [Plugin guide](./.github/plugin/README.md) | `npx modelhitch setup vscode` |
| Agent | Get it | Install or use |
| --- | --- | --- |
| **Codex** | [Plugin guide](./.agents/plugins/README.md) | `codex plugin marketplace add genoventures-labs/ModelHitch` → `codex plugin add modelhitch@modelhitch` |
| **Claude Code / Claude.ai** | [Skill guide](./.claude/skills/README.md) | Auto-discovered in this repo; copy or upload [`modelhitch-integrate`](./.claude/skills/modelhitch-integrate/SKILL.md) and [`modelhitch-bridge`](./.claude/skills/modelhitch-bridge/SKILL.md) elsewhere |
| **Cursor** | [Plugin guide](./.cursor-plugin/README.md) | Marketplace-ready; locally load [`plugins/modelhitch`](./plugins/modelhitch/README.md) |
| **VS Code / GitHub Copilot** | [Plugin guide](./.github/plugin/README.md) | `copilot plugin marketplace add genoventures-labs/ModelHitch` → `copilot plugin install modelhitch@modelhitch` |

The shared distributable package lives at [`plugins/modelhitch/`](./plugins/modelhitch/README.md).
It contains separate Codex and Cursor presentation manifests plus the portable Agent Plugins 1.0
manifest used by VS Code and GitHub Copilot—all backed by the same source-aware skill.

## The desk

<p align="center">
  <img src="https://raw.githubusercontent.com/genoventures-labs/ModelHitch/main/repo_assets/own_section.png" alt="One interface. BYOK. Any model, any time. No questions. Just results." width="85%"/>
</p>

| What you get | What it means |
| --- | --- |
| One interface | `chat()` and `stream()` share the same types across providers. |
| BYOK | Keys can stay in the user's browser and go directly to the provider. |
| Any model | Use hosted gateways, local runtimes, or your own OpenAI-compatible endpoint. |
| One stream | Provider-specific events become normalized `StreamChunk` events. |
| Tool calling | Declare tools once and use them across supported adapters. |
| No bloat | Node >=18, browsers, and edge runtimes. |

## Quickstart

```bash
npm install modelhitch
```

```ts
import { ModelHitch } from 'modelhitch';

const mh = new ModelHitch();

const result = await mh.chat({
  provider: 'opencode-zen',
  model: 'big-pickle',
  messages: [{ role: 'user', content: 'Hello from the temp agency.' }],
});

console.log(result.message.content);
```

Streaming uses the same request shape and normalized events everywhere:

```ts
const stream = await mh.stream({
  provider: 'opencode-go',
  model: 'deepseek-v4-flash',
  messages: [{ role: 'user', content: 'Write a haiku about hitches.' }],
});

for await (const chunk of stream) {
  if (chunk.type === 'text-delta') process.stdout.write(chunk.text);
}
```

## Codex plugin

<p align="center">
  <img src="https://raw.githubusercontent.com/genoventures-labs/ModelHitch/main/repo_assets/Codex.png" alt="ModelHitch Codex plugin and skills" width="100%"/>
</p>

ModelHitch also ships as a public Codex plugin. Add this repository as a marketplace, then install
the plugin:

```bash
codex plugin marketplace add genoventures-labs/ModelHitch
codex plugin add modelhitch@modelhitch
```

Start a new Codex task after installation. The plugin teaches Codex how to integrate the npm
library, build BYOK and React flows, configure the local agent bridge, add providers, and diagnose
routing, failover, and usage.

The plugin and npm package are complementary: install the plugin for Codex guidance, and install
`modelhitch` in an application when the application needs the runtime library.

## Claude skills

<p align="center">
  <img src="https://raw.githubusercontent.com/genoventures-labs/ModelHitch/main/repo_assets/Claude.png" alt="ModelHitch Claude skills" width="100%"/>
</p>

The repository includes two native Claude Code skills under `.claude/skills/`:

- `/modelhitch-integrate` for TypeScript, React, BYOK, provider, tool, and failover work
- `/modelhitch-bridge` for Claude Code, Codex, Gemini, IDE, and bridge operations

Claude Code discovers them automatically when working in this repository. To use them in another
project, copy either skill directory into that project's `.claude/skills/` directory or into
`~/.claude/skills/` for personal use. Each directory follows the portable Agent Skills format and
can be zipped individually for upload to Claude.ai.

## Cursor plugin

<p align="center">
  <img src="https://raw.githubusercontent.com/genoventures-labs/ModelHitch/main/repo_assets/Cursor.png" alt="ModelHitch Cursor plugin and skills" width="100%"/>
</p>

The same ModelHitch skill is packaged for Cursor under `plugins/modelhitch/`, alongside the Codex
manifest. The repository includes `.cursor-plugin/marketplace.json` and is ready for Cursor
Marketplace submission.

For local testing before the marketplace listing is approved, copy `plugins/modelhitch/` to
`~/.cursor/plugins/local/modelhitch`, then restart Cursor or run **Developer: Reload Window**.
The plugin teaches Cursor to integrate the npm and React APIs, configure the local bridge, add
providers, and diagnose routing, failover, and usage.

## VS Code and GitHub Copilot

<p align="center">
  <img src="https://raw.githubusercontent.com/genoventures-labs/ModelHitch/main/repo_assets/VSCode.png" alt="ModelHitch VS Code and GitHub Copilot plugin and skills" width="100%"/>
</p>

ModelHitch also follows the portable Agent Plugins 1.0 format used by GitHub Copilot in VS Code,
Copilot CLI, and Copilot cloud agent. Register this repository and install the plugin with Copilot
CLI:

```bash
copilot plugin marketplace add genoventures-labs/ModelHitch
copilot plugin install modelhitch@modelhitch
```

VS Code automatically discovers plugins installed by Copilot CLI. You can also add the repository
through the VS Code Agent Customizations editor. When working directly in this repository, VS Code
discovers the project skills under `.claude/skills/` without a separate installation.

## CLI

ModelHitch ships a small CLI — every command greets you with the logo:

```bash
npx modelhitch            # logo, version, and command help
npx modelhitch bridge     # start the local OpenAI-compatible bridge server
npx modelhitch setup all  # install skills for Codex, Claude, Cursor, and VS Code
npx modelhitch --version
npx modelhitch --help
```

`modelhitch bridge` is the same bridge as `npm run bridge` (auto-mode ON,
SQLite usage persistence, usage dashboard) and honors `MODELHITCH_PORT`,
`MODELHITCH_HOST`, and `MODELHITCH_MAX_BODY_BYTES`. The logo also prints when
the example entry points start: `npm run bridge`, `npm run example`, and
`npm run canary`. You can print it anywhere in your own app:

```ts
import { printAsciiLogo } from 'modelhitch';
printAsciiLogo(); // the chain-link mark + "hitch" wordmark
```

### Run the bridge in the background

Don't want the bridge to tie up a terminal? Launch it detached — it keeps
running after the terminal closes:

```bash
modelhitch bridge --background   # launch, then the terminal is free
modelhitch status                # is it running? pid, healthz, log path
modelhitch stop                  # stop the background bridge
modelhitch front                 # stop it and run the bridge in this terminal
```

The background process is tracked per-user in `~/.modelhitch/`
(`bridge.pid` + `bridge.log`, override the directory with `MODELHITCH_HOME`).
Run `modelhitch status` to see whether it's alive and responding, or `front`
to pull it back into a terminal where you can watch logs and hit Ctrl+C.

## Providers

ModelHitch ships with hosted, local, and deterministic providers:

| Provider id | Default endpoint | Key env var |
| --- | --- | --- |
| `opencode-zen` | OpenCode Zen | `OPENCODE_ZEN_API_KEY` |
| `opencode-go` | OpenCode Go | `OPENCODE_GO_API_KEY` |
| `openai` | OpenAI | `OPENAI_API_KEY` |
| `anthropic` | Anthropic | `ANTHROPIC_API_KEY` |
| `groq` | Groq | `GROQ_API_KEY` |
| `openrouter` | OpenRouter | `OPENROUTER_API_KEY` |
| `together` | Together AI | `TOGETHER_API_KEY` |
| `lmstudio` | Local LM Studio | - |
| `ollama` | Local Ollama | - |
| `vllm` | Local vLLM | - |
| `llamacpp` | Local llama.cpp | - |
| `koboldcpp` | Local KoboldCpp | - |
| `mock` | Deterministic test provider | - |

The OpenCode gateways also accept `OPENCODE_API_KEY` as a fallback. Zen automatically selects
the wire protocol by model family:

| Model family | Protocol |
| --- | --- |
| `gpt-*`, `grok-*` | OpenAI Responses |
| `claude-*`, `qwen*` | Anthropic Messages |
| `gemini-*` | Google GenerateContent |
| Everything else | OpenAI-compatible chat completions |

Use live discovery when you need the current gateway catalog:

```ts
const models = await mh.listModels('opencode-zen');
```

## Bring your own key

Keys resolve in this order:

1. Explicit `apiKey` or `baseUrl` on the request
2. The configured `KeyStore`
3. The provider environment variable

For browser applications, `LocalStorageKeyStore` keeps the key on the user's device:

```ts
import { LocalStorageKeyStore, ModelHitch } from 'modelhitch';

const mh = new ModelHitch({ keystore: new LocalStorageKeyStore() });
await mh.keystore!.set('opencode-zen', userPastedKey);

const result = await mh.chat({
  provider: 'opencode-zen',
  model: 'big-pickle',
  messages: [{ role: 'user', content: 'Ship it.' }],
});
```

`MemoryKeyStore` is available for server-side use. Your backend does not need to proxy a
browser user's provider key.

## Tools and agent loops

Declare a provider-agnostic tool once:

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

`runToolLoop` handles streaming, tool execution, and follow-up turns:

```ts
import { runToolLoop } from 'modelhitch';

for await (const event of runToolLoop(
  mh,
  { provider: 'opencode-zen', messages, tools: [weatherTool] },
  async (name, args) => myToolRunner(name, args),
  { maxTurns: 8 },
)) {
  if (event.type === 'chunk' && event.chunk.type === 'text-delta') {
    ui.append(event.chunk.text);
  }
}
```

## React: a BYOK UI in a day

```tsx
import { useChat } from 'modelhitch/react';

function Chat() {
  const { messages, pending, send, reset } = useChat({
    baseUrl: 'http://127.0.0.1:3939/v1',
    model: 'opencode-zen/big-pickle',
    systemPrompt: 'You are a helpful assistant.',
  });

  return /* render messages, pending, send(text), and reset */ null;
}
```

`useStream` is the lower-level hook for one turn. The runnable demo in `examples/byok-ui/`
uses the deterministic mock provider and needs no API key.

## Add your own gateway

OpenAI-compatible APIs are one registration away:

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

For another wire format, implement the `Provider` interface: `chat`, `stream`,
`capabilities`, and optionally `listModels`.

## Agent bridge

The local bridge turns ModelHitch into an OpenAI-compatible endpoint for coding agents and IDEs.
Start it with:

```bash
npm run bridge
```

Then point a client at `http://127.0.0.1:3939/v1`. Keys are resolved on the bridge machine;
clients only need a dummy key when their configuration requires one.

```ts
import { createModelHitchServer, OPENCODE_GO_MODELS, OPENCODE_ZEN_MODELS } from 'modelhitch';

const server = createModelHitchServer({
  defaultProviderId: 'opencode-zen',
  staticModels: {
    'opencode-zen': [...OPENCODE_ZEN_MODELS],
    'opencode-go': [...OPENCODE_GO_MODELS],
  },
  autoMode: true, // fail over on 429/5xx/network errors — see below
  logger: console.log,
});

await server.listen(3939, '127.0.0.1');
```

### Who is my agent?

Prefix a model with its provider. Bare ids use the default provider.

| Request | Route |
| --- | --- |
| `opencode-zen/big-pickle` | OpenCode Zen, `big-pickle` |
| `opencode-go/deepseek-v4-flash` | OpenCode Go, `deepseek-v4-flash` |
| `anthropic/claude-sonnet-4-5` | Anthropic, `claude-sonnet-4-5` |
| `ollama/llama3.2` | Local Ollama |
| `big-pickle` | Default provider's `big-pickle` |

The bridge speaks:

| Endpoint | Client family |
| --- | --- |
| `POST /v1/chat/completions` | OpenAI-compatible clients |
| `POST /v1/responses` | Codex CLI and Responses clients |
| `POST /v1/messages` | Claude Code and Anthropic clients |
| `POST /v1beta/models/{model}:generateContent` | Gemini CLI |
| `GET /v1/models`, `GET /healthz` | Discovery and health checks |
| `GET /v1/usage` | Usage snapshot as JSON |
| `GET /usage` | Live usage dashboard (HTML, auto-refreshing) |
| `POST /v1/usage/reset` | Clear in-memory usage totals |

Supported harnesses include Codex CLI, Claude Code, Gemini CLI, Aider, Continue, Cline, Roo,
Kilo, Goose, OpenCode CLI, Zed, and any client with a custom OpenAI-compatible endpoint.

<details>
<summary>Codex CLI</summary>

Start the bridge, then add this to `~/.codex/config.toml`:

```toml
model_provider = "modelhitch"
model = "opencode-zen/gpt-5.6-luna"

[model_providers.modelhitch]
name = "ModelHitch local bridge"
base_url = "http://127.0.0.1:3939/v1"
```

</details>

<details>
<summary>Claude Code</summary>

```bash
export ANTHROPIC_BASE_URL="http://127.0.0.1:3939"
export ANTHROPIC_AUTH_TOKEN="local-bridge"
export ANTHROPIC_DEFAULT_SONNET_MODEL="deepseek-v4-flash"
claude
```

</details>

<details>
<summary>Gemini CLI</summary>

```bash
export GOOGLE_GEMINI_BASE_URL="http://127.0.0.1:3939"
export GEMINI_API_KEY="local-bridge"
export GEMINI_MODEL="gemini-3.5-flash-lite"
gemini
```

</details>

The bridge accepts request bodies up to 64 MiB by default for inline images. Set
`MODELHITCH_MAX_BODY_BYTES` to tune the CLI bridge. For opaque upstream failures,
`MODELHITCH_DEBUG=1` logs the forwarded body and full upstream error.

## Auto-mode: survive rate limits

When a lane gets rate-limited (`opencode-zen failed: HTTP 429 rate-limited` and friends), a 5xx
provider blip, or a network hiccup, auto-mode transparently retries the request on the next
lane — no agent restart, no failed turn. It works on every wire (chat, responses, messages,
Gemini), streamed and non-streamed.

Turn it on with `autoMode: true` (or a custom lineup):

```ts
import { createModelHitchServer } from 'modelhitch';

const server = createModelHitchServer({
  autoMode: {
    // Same-provider fallback models first, then cross-provider lanes.
    models: ['deepseek-v4-flash-free', 'mimo-v2.5-free'],
    lanes: [{ providerId: 'opencode-go', model: 'deepseek-v4-flash' }],
    retryableCodes: ['rate-limited', 'provider-error', 'network-error'],
    maxAttempts: 5,
  },
  onFailover: (event) => console.log(`${event.from.providerId}/${event.from.model} -> ${event.to.providerId}/${event.to.model}`),
});
```

`autoMode: true` uses the default lineup, tuned to the OpenCode Go usage limits
([docs](https://opencode.ai/docs/go#usage-limits) — $12/5h, $30/wk, $60/mo, then free models):

1. `opencode-go/deepseek-v4-flash` — cheapest Go subscription model, largest included allowance
2. `opencode-zen/big-pickle` — the Zen default
3. `opencode-zen/deepseek-v4-flash-free` — free Zen model
4. `opencode-zen/mimo-v2.5-free` — free Zen model

How it behaves:

- **Detection** — any error whose code is in `retryableCodes` **or** whose HTTP status is 429
  triggers failover (some adapters surface 429s with a different code, so the status check
  always applies). Aborts, cancellations, bad requests, and auth failures never retry.
- **Credential safety** — lanes without a configured key (`missing-api-key`/`invalid-api-key`)
  are skipped silently. Fallback lanes resolve keys from the keystore or the provider's env
  fallback; a per-call `apiKey` stays with the primary lane.
- **Streams fail over pre-content** — a 429 during the first chunk restarts the stream on the
  next lane before HTTP 200 is committed, so the client sees a real retry, never a half-written
  response. Once content has been emitted, mid-stream errors propagate (retrying would
  duplicate output).
- **First error wins** — if every lane fails, the original lane's error is rethrown, because
  that's the actionable one.

The same options work on the client class:

```ts
const mh = new ModelHitch({ autoMode: true, onFailover: console.log });
```

## Usage, tokens, and spend

The bridge tracks every completed request in memory: provider, model, wire, tokens, estimated
cost, latency, plus every failover. Point a browser at `http://127.0.0.1:3939/usage` for the
live dashboard, or read the JSON:

```bash
curl http://127.0.0.1:3939/v1/usage
```

```jsonc
{
  "since": "2026-08-11T10:00:00.000Z",
  "persisted": true,
  "totals": { "requests": 42, "inputTokens": 120000, "outputTokens": 34000, "totalTokens": 154000, "costUsd": 1.83, "latencyMs": 98123 },
  "perProvider": { "opencode-zen": { /* totals scoped to this provider */ } },
  "perModel": { "opencode-zen/big-pickle": { /* totals scoped to this model */ } },
  "perWire": { "chat-completions": { /* totals per wire */ } },
  "recent": [ /* last 50 events, newest first */ ],
  "failovers": { "total": 3, "recent": [ /* last 20 */ ] },
  "windows": {
    "5h":  { /* cost + fraction of the $12 cap */ },
    "7d":  { /* cost + fraction of the $30 cap */ },
    "30d": { /* cost + fraction of the $60 cap */ }
  }
}
```

The windows mirror the OpenCode Go usage limits, so you can see at a glance how close the
bridge is to a paid-limit block. Cost estimates come from built-in list pricing
(see `estimateCost`), are best-effort, and report $0 for free/unknown models.

Track usage programmatically with the `UsageTracker` class:

```ts
import { UsageTracker, SqliteUsageStorage } from 'modelhitch';

const usage = new UsageTracker(new SqliteUsageStorage('./data/usage.db'));
const server = createModelHitchServer({
  usageTracker: usage,
  onUsage: (event) => myMeteringDb.record(event), // every completed request
});

console.log(usage.snapshot().totals.costUsd);
```

### Persistence (SQLite)

Usage history lives in memory by default, which means totals reset on restart. For
spend tracking that survives restarts, hand the bridge a SQLite file — **no native
dependencies**, it's built on Node's `node:sqlite` (requires Node ≥ 22.5):

```ts
const server = createModelHitchServer({
  // true → ./modelhitch-usage.db · string → custom path (dirs are created)
  usagePersistence: true, // or './data/usage.db'
});
```

Every request and failover is mirrored into the database, and on startup the tracker
loads the full history back — totals, per-provider/model/wire breakdowns, and the
5h/7d/30d windows all include pre-restart usage, and `since` reflects the earliest
recorded event. `GET /v1/usage` reports `"persisted": true` and the dashboard shows
a *persisted to SQLite* badge. `POST /v1/usage/reset` clears memory and the file.

The same storage works standalone (`SqliteUsageStorage`, exported from `modelhitch`)
— useful for metering outside the bridge. If `usageTracker` is passed, `usagePersistence`
is ignored; if you enable persistence on Node < 22.5, the server logs a clear error at
startup rather than silently dropping history.

## Errors and usage

```ts
import { ModelHitchError } from 'modelhitch';

try {
  await mh.chat({ provider: 'opencode-zen', messages });
} catch (error) {
  if (error instanceof ModelHitchError) {
    console.log(error.code);
  }
}
```

Stable codes include `missing-api-key`, `invalid-api-key`, `rate-limited`, `model-not-found`,
`provider-not-found`, `provider-error`, `network-error`, and `bad-request`.

Use `onUsage` on the bridge for request metering, or `estimateCost(model, usage, providerId?)`
for best-effort offline estimates. Local providers are free in the estimator.

Enable [`autoMode`](#auto-mode-survive-rate-limits) to have the bridge (or the `ModelHitch`
client) retry 429/5xx/network failures on fallback lanes automatically.

## Contributing

<p align="center">
  <img src="https://raw.githubusercontent.com/genoventures-labs/ModelHitch/main/repo_assets/contrib_image.png" alt="Contribution policy - clone, look, and modify your own version" width="85%"/>
</p>

The rules are simple: clone it, look around, and modify your own version. Public contributions
are currently closed. No benefits. No memory. Just output.

## Development

```bash
npm install
npm run typecheck
npm test
npm run build
npm run example
npm run bridge
npm run canary
```

`npm run example` uses the deterministic mock provider. `npm run canary` needs a Zen key.

## License

MIT

<p align="center">
  <img src="https://raw.githubusercontent.com/genoventures-labs/ModelHitch/main/repo_assets/hitch_meme.png" alt="Mutant ninja temps clock in and ship code" width="90%"/>
</p>

<p align="center">
  <img src="https://raw.githubusercontent.com/genoventures-labs/ModelHitch/main/repo_assets/footer_repo.png" alt="ModelHitch - We route. You build." width="90%"/>
</p>
