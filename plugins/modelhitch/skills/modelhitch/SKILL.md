---
name: modelhitch
description: Build, integrate, configure, operate, or troubleshoot ModelHitch, the TypeScript BYOK multi-provider AI layer and local agent bridge. Use for ModelHitch npm or React integrations, provider-neutral chat and streaming, tool loops, custom providers, bridge setup for Codex/Claude/Gemini/OpenAI-compatible clients, model routing, auto-mode failover, and usage tracking.
---

# ModelHitch

Use ModelHitch as either an application library or a local compatibility bridge. Preserve the user's existing architecture and choose the smallest surface that solves the request.

## Choose a workflow

- Use the root `modelhitch` package for TypeScript/JavaScript chat, streaming, tools, BYOK storage, providers, failover, or an embedded server.
- Use `modelhitch/react` for React chat state backed by a ModelHitch bridge.
- Use the CLI bridge when an agent, IDE, or other client needs an OpenAI Responses, OpenAI chat, Anthropic Messages, or Gemini-compatible endpoint.
- Use `createOpenAICompatibleProvider` for a new OpenAI-compatible gateway. Implement `Provider` only for a different wire protocol.

Read [api-and-operations.md](references/api-and-operations.md) when exact imports, provider IDs, endpoints, environment variables, or troubleshooting steps are needed.

## Integrate the library

1. Inspect the project's runtime, package manager, framework, and existing AI abstraction.
2. Require Node.js 18 or later for the library. Confirm the target browser or edge bundler supports the selected imports before claiming compatibility.
3. Install with the project's package manager, for example `npm install modelhitch`.
4. Create one `ModelHitch` instance at the appropriate application boundary.
5. Select a provider and model deliberately. Use `listModels(providerId)` when the live catalog matters.
6. Resolve credentials in this order: per-request credentials, configured keystore, then provider environment variable.
7. Keep browser-owned keys in `LocalStorageKeyStore`; use `MemoryKeyStore` or environment variables server-side. Never print, commit, or place secret values in client bundles unintentionally.
8. Use `chat()` for a complete result, `stream()` for normalized chunks, and `runToolLoop()` only when the app must execute model tool calls.
9. Handle `ModelHitchError` by its stable `code`; do not parse provider error strings.
10. Verify with the deterministic `mock` provider before requiring a live credential.

## Operate the bridge

1. Check `node --version`. Require Node.js 22.5 or later for the packaged CLI bridge because it enables SQLite usage persistence.
2. Set the needed provider key in the process environment without echoing it.
3. Start with `npx modelhitch bridge` for foreground diagnosis or `npx modelhitch bridge --background` for normal local operation.
4. Verify `npx modelhitch status`, `GET /healthz`, and `GET /v1/models` before changing a client.
5. Smoke-test `mock/mock-model` first to separate bridge configuration from provider credentials.
6. Route explicit models as `providerId/modelId`; bare model IDs use the configured default provider.
7. Configure the client for its native wire and correct base URL. Ask before changing user-level agent or IDE configuration; merge with existing config instead of replacing it.
8. Inspect `/usage` or `/v1/usage` for requests, cost estimates, latency, and failovers.
9. Use `status`, the reported bridge log, and provider-safe error codes for diagnosis. Enable `MODELHITCH_DEBUG=1` only with the user's awareness because full request or upstream bodies may contain sensitive content.
10. Stop a background bridge with `npx modelhitch stop`; use `front` to move it into the current terminal.

## Apply failover safely

- Enable `autoMode` for 429, 5xx provider, and network recovery.
- Put same-provider fallback models before cross-provider lanes when data routing matters.
- Expect credentials to resolve independently for fallback lanes; never copy a per-call key across providers.
- Preserve mid-stream failures after content has been emitted. Retrying would duplicate output.
- Treat cost output as an estimate and free or unknown prices as zero, not proof of no billing.

## Verify changes

- Run the repository's typecheck and focused tests after code edits.
- Exercise both success and failure paths when changing credentials, provider selection, tools, or failover.
- For bridge changes, verify the relevant wire endpoint and health check.
- For React changes, verify cancellation, pending state, streamed deltas, and reset behavior.
- Report which checks used `mock` and which contacted a live provider.
