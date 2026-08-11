import { randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { ModelHitchError } from '../core/errors.js';
import { estimateCost } from '../core/cost.js';
import type { KeyStore } from '../core/keystore.js';
import type { ChatParams, ProviderCredentials, StreamChunk, Usage } from '../core/types.js';
import { defaultProviders } from '../registry.js';
import type { Provider } from '../providers/types.js';
import { mapFinishReasonOpenAI, mapRequest, routeModel, toChatCompletion, toOpenAIError, toUsageOutput } from './mapping.js';
import {
  estimateAnthropicInputTokens,
  mapAnthropicRequest,
  toAnthropicCompletion,
  toAnthropicError,
  toAnthropicStreamEvents,
  type AnthropicRequest,
} from './anthropic-wire.js';
import {
  estimateGeminiInputTokens,
  mapGeminiRequest,
  toGeminiCompletion,
  toGeminiError,
  toGeminiStreamEvents,
  type GeminiRequest,
} from './gemini-wire.js';
import {
  assistantMessagesFromResult,
  mapResponsesRequest,
  resolveConversation,
  toResponsesCompletion,
  toResponsesStreamEvents,
  toolMessagesFromOutputs,
  toolOutputsFromInput,
  type ResponsesRequest,
} from './responses.js';
import { clearConversations, findConversationWithToolCall, rememberConversation } from './conversation-state.js';
import { normalizeBodyImages } from './local-images.js';
import type { OpenAIChatRequest, OpenAIModelEntry, OpenAIStreamChunk } from './types.js';

export interface ModelHitchServerOptions {
  /** Providers to serve. Defaults to the built-in set. */
  providers?: Provider[];
  /** BYOK store consulted per request (after `apiKeys`). */
  keystore?: KeyStore;
  /** Provider used for bare model ids and when none is specified. */
  defaultProviderId?: string;
  /** Default model when the request omits one. */
  defaultModel?: string;
  /** Per-provider API key overrides, e.g. `{ 'opencode-zen': 'sk-...' }`. */
  apiKeys?: Record<string, string>;
  /** Per-provider base URL overrides. */
  baseUrls?: Record<string, string>;
  /**
   * Extra models to advertise in `GET /v1/models` per provider, e.g.
   * `{ 'opencode-zen': OPENCODE_ZEN_MODELS }`. Merged with live `/models`
   * discovery where the provider supports it.
   */
  staticModels?: Record<string, string[]>;
  /** Request body size cap in bytes. Default 64 MiB (room for inline base64 images). */
  maxBodyBytes?: number;
  /** Called once per request with a one-line summary. */
  logger?: (line: string) => void;
  /**
   * Called once per completed inference request with token usage + cost.
   * Fires for successful non-stream calls and for streams that run to
   * completion (not for aborted/disconnected streams). Handy for dashboards,
   * per-user metering, or rate-limit accounting.
   */
  onUsage?: (event: UsageEvent) => void;
}

/** One completed inference request, as reported to the `onUsage` hook. */
export interface UsageEvent {
  /** Provider id, e.g. "opencode-zen". */
  providerId: string;
  /** Routed model id. */
  model: string;
  /** Wire that served the request: chat-completions | responses | messages | gemini. */
  wire: string;
  /** True when the client requested SSE streaming. */
  streamed: boolean;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  /** Estimated USD (best-effort list pricing; 0 for free/unknown). */
  costUsd: number;
  /** Wall time from request start to completion, ms. */
  latencyMs: number;
  /** ISO timestamp. */
  at: string;
}

const DEFAULT_MAX_BODY_BYTES = 64 * 1024 * 1024; // images arrive as inline base64 — 10 MiB was too small

/**
 * A local, OpenAI-compatible HTTP server in front of the ModelHitch harness.
 *
 * Agentic IDEs (Android Studio's Agent Mode, JetBrains AI, Cursor, ...) that
 * accept a "custom model endpoint" can point at this server and drive any
 * registered provider — OpenCode Zen/Go, OpenAI, Anthropic, Ollama, ... —
 * with tools, multi-turn roles, and SSE streaming. Keys resolve locally
 * (apiKeys > keystore > provider env fallback) and never leave the machine.
 *
 * Endpoints:
 * - `POST /v1/chat/completions` (stream + non-stream)
 * - `POST /v1/responses` (stream + non-stream — Codex CLI / Responses-API clients)
 * - `POST /v1/messages` (stream + non-stream — Claude Code / Anthropic-format clients)
 * - `POST /v1/messages/count_tokens` (Claude Code token counting)
 * - `POST /v1beta/models/:model:generateContent` and
 *   `POST /v1beta/models/:model:streamGenerateContent?alt=sse`
 *   (Gemini CLI / Google-native clients)
 * - `GET /v1/models` and `GET /v1/models/:id`
 * - `HEAD /api/hello` (Claude Code connection-warming probe)
 * - `GET /healthz`
 *
 * Model routing: `providerId/modelId` (e.g. `opencode-zen/big-pickle`); bare
 * model ids go to the default provider.
 */
export class OpenAICompatibleServer {
  readonly providers: Provider[];
  readonly options: ModelHitchServerOptions;
  private httpServer: Server | null = null;

  constructor(options: ModelHitchServerOptions = {}) {
    this.options = options;
    this.providers = options.providers ?? defaultProviders;
  }

  /** Start listening. `port` defaults to 0 (ephemeral). */
  listen(port = 0, host = '127.0.0.1'): Promise<{ server: Server; port: number; url: string }> {
    if (this.httpServer) return Promise.reject(new Error('Server is already listening.'));
    return new Promise((resolve) => {
      const server = createServer((req, res) => {
        this.dispatch(req, res).catch((err) => this.sendError(res, err));
      });
      server.listen(port, host, () => {
        this.httpServer = server;
        const actual = (server.address() as AddressInfo).port;
        const url = `http://${host === '0.0.0.0' ? '127.0.0.1' : host}:${actual}`;
        resolve({ server, port: actual, url });
      });
    });
  }

  /** Stop the server. */
  close(): Promise<void> {
    clearConversations();
    return new Promise((resolve, reject) => {
      if (!this.httpServer) return resolve();
      this.httpServer.close((err) => (err ? reject(err) : resolve()));
      this.httpServer = null;
    });
  }

  // ---------------------------------------------------------------------------
  // Routing
  // ---------------------------------------------------------------------------

  private async dispatch(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const method = req.method ?? 'GET';
    const url = new URL(req.url ?? '/', 'http://localhost');
    const path = url.pathname;

    if (method === 'OPTIONS') {
      this.cors(res);
      res.writeHead(204);
      res.end();
      return;
    }

    if (method === 'GET' && (path === '/health' || path === '/healthz')) {
      this.log(`${method} ${path} 200`);
      this.sendJson(res, 200, { status: 'ok' });
      return;
    }

    if (method === 'GET' && path === '/v1/models') {
      this.log(`${method} ${path} ->`);
      await this.handleModels(res);
      return;
    }

    if (method === 'GET' && path.startsWith('/v1/models/')) {
      this.log(`${method} ${path} ->`);
      await this.handleModelById(res, decodeURIComponent(path.slice('/v1/models/'.length)));
      return;
    }

    if (method === 'POST' && path === '/v1/chat/completions') {
      this.log(`${method} ${path} ->`);
      await this.handleChat(req, res);
      return;
    }

    if (method === 'POST' && path === '/v1/responses') {
      this.log(`${method} ${path} ->`);
      await this.handleResponses(req, res);
      return;
    }

    // Claude Code / Anthropic-format gateways. Claude Code posts to
    // `/v1/messages?beta=true` — `url.pathname` strips the query for us.
    if (method === 'POST' && path === '/v1/messages') {
      this.log(`${method} ${path} ->`);
      try {
        await this.handleAnthropic(req, res);
      } catch (err) {
        // Non-stream Anthropic errors use the Anthropic error envelope.
        if (res.headersSent) throw err;
        const { status, body } = toAnthropicError(err);
        const error = body.error as { type?: string; message?: string };
        this.log(`  !! HTTP ${status} ${error.type ?? 'error'}: ${error.message ?? ''}`);
        this.sendJson(res, status, body);
      }
      return;
    }

    if (method === 'POST' && path === '/v1/messages/count_tokens') {
      this.log(`${method} ${path} ->`);
      try {
        await this.handleAnthropicCountTokens(req, res);
      } catch (err) {
        if (res.headersSent) throw err;
        const { status, body } = toAnthropicError(err);
        this.sendJson(res, status, body);
      }
      return;
    }

    // Gemini CLI / Google-native clients. Gemini CLI sends model ids in the
    // *path* (`/v1beta/models/{model}:generateContent`), so the capture is
    // `[^:]+` — `provider/model` prefixes survive for explicit routing.
    // `v1alpha` / `v1` prefixes are tolerated (GOOGLE_GENAI_API_VERSION).
    const geminiMatch = path.match(/^\/v1(?:beta|alpha)?\/models\/([^:]+):(generateContent|streamGenerateContent)$/);
    if (method === 'POST' && geminiMatch) {
      const modelFromPath = decodeURIComponent(geminiMatch[1] ?? '');
      const isStream = geminiMatch[2] === 'streamGenerateContent';
      this.log(`${method} ${path} ->`);
      try {
        await this.handleGemini(req, res, modelFromPath, isStream);
      } catch (err) {
        // Non-stream Gemini errors use the Google API error envelope.
        if (res.headersSent) throw err;
        const { status, body } = toGeminiError(err);
        const error = body.error as { status?: string; message?: string };
        this.log(`  !! HTTP ${status} ${error.status ?? 'INTERNAL'}: ${error.message ?? ''}`);
        this.sendJson(res, status, body);
      }
      return;
    }

    // Best-effort connection-warming probe from Claude Code — safe to ignore.
    if (method === 'HEAD' && path === '/api/hello') {
      res.writeHead(200);
      res.end();
      return;
    }

    this.log(`${method} ${path} 404`);
    this.sendJson(res, 404, {
      error: { message: `Unknown endpoint: ${method} ${path}`, type: 'invalid_request_error', param: null, code: 'unknown_endpoint' },
    });
  }

  // ---------------------------------------------------------------------------
  // Chat completions
  // ---------------------------------------------------------------------------

  private async handleChat(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const body = (await this.readBody(req)) as OpenAIChatRequest | null;
    if (!body || !Array.isArray(body.messages) || body.messages.length === 0) {
      throw new ModelHitchError('bad-request', "The request body must include a non-empty 'messages' array.", { status: 400 });
    }
    const { provider, model } = routeModel(body.model, this.providers, this.options.defaultProviderId);
    const credentials = await this.resolveCredentials(provider.id);
    const params = mapRequest(body, model);
    if (this.options.defaultModel && !body.model) params.model = this.options.defaultModel;

    if (body.stream === true) {
      this.log(`  -> ${provider.id}/${model} (stream)`);
      await this.writeStream(res, provider, params, credentials, model);
      return;
    }

    this.log(`  -> ${provider.id}/${model}`);
    const startedAt = Date.now();
    const result = await provider.chat(params, credentials);
    this.reportUsage({ providerId: provider.id, model, wire: 'chat-completions', streamed: false }, result.usage, startedAt);
    this.sendJson(res, 200, toChatCompletion(result, model));
  }

  /** Stream a normalized provider stream out as OpenAI SSE chunks. */
  private async writeStream(
    res: ServerResponse,
    provider: Provider,
    params: ChatParams,
    credentials: ProviderCredentials,
    model: string,
  ): Promise<void> {
    const controller = new AbortController();
    const id = `chatcmpl-${randomUUID()}`;
    const created = Math.floor(Date.now() / 1000);
    const chunkBase = { id, object: 'chat.completion.chunk' as const, created, model };
    const startedAt = Date.now();

    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });

    // Abort the upstream call if the client disconnects mid-stream.
    res.on('close', () => {
      if (!res.writableEnded) controller.abort();
    });

    const toolIndex = new Map<string, number>();
    let nextToolIndex = 0;
    let started = false;

    const write = (chunk: OpenAIStreamChunk) => {
      res.write(`data: ${JSON.stringify(chunk)}\n\n`);
    };

    try {
      const stream = this.trackStream(
        provider.stream({ ...params, signal: controller.signal }, credentials),
        { providerId: provider.id, model, wire: 'chat-completions', streamed: true },
        startedAt,
      );
      for await (const event of stream) {
        switch (event.type) {
          case 'text-delta': {
            const delta: Record<string, unknown> = { content: event.text };
            if (!started) {
              delta.role = 'assistant';
              started = true;
            }
            write({ ...chunkBase, choices: [{ index: 0, delta, finish_reason: null }] });
            break;
          }
          case 'tool-call-start': {
            const index = nextToolIndex++;
            toolIndex.set(event.id, index);
            const delta = {
              role: 'assistant',
              tool_calls: [
                {
                  index,
                  id: event.id,
                  type: 'function',
                  function: { name: event.name, arguments: '' },
                  ...(event.thoughtSignature ? { thoughtSignature: event.thoughtSignature } : {}),
                },
              ],
            };
            write({ ...chunkBase, choices: [{ index: 0, delta, finish_reason: null }] });
            break;
          }
          case 'tool-call-args-delta': {
            const index = toolIndex.get(event.id) ?? 0;
            const delta = { tool_calls: [{ index, function: { arguments: event.argsDelta } }] };
            write({ ...chunkBase, choices: [{ index: 0, delta, finish_reason: null }] });
            break;
          }
          case 'tool-call-end':
            // The final finish chunk carries the resolved finish_reason.
            break;
          case 'finish': {
            const finish: OpenAIStreamChunk = {
              ...chunkBase,
              choices: [{ index: 0, delta: {}, finish_reason: mapFinishReasonOpenAI(event.finishReason) }],
            };
            if (event.usage) finish.usage = toUsageOutput(event.usage) ?? undefined;
            write(finish);
            break;
          }
        }
      }
      // Some providers end without an explicit finish chunk — synthesize one.
      write({ ...chunkBase, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] });
      res.write('data: [DONE]\n\n');
      res.end();
    } catch (err) {
      if (res.writableEnded) return;
      const { status, body } = toOpenAIError(err);
      // Stream already started: emit the error as an SSE event, then [DONE].
      res.write(`data: ${JSON.stringify(body)}\n\n`);
      res.write('data: [DONE]\n\n');
      res.end();
      this.log(`  !! ${provider.id} failed: HTTP ${status} ${body.error.code}`);
    }
  }

  // ---------------------------------------------------------------------------
  // Responses API (Codex CLI wire protocol)
  // ---------------------------------------------------------------------------

  private async handleResponses(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const body = (await this.readBody(req)) as ResponsesRequest | null;
    const hasInput = Array.isArray(body?.input) && body!.input!.length > 0;
    const hasInstructions = typeof body?.instructions === 'string' && body.instructions.length > 0;
    if (!body || (!hasInput && !hasInstructions)) {
      throw new ModelHitchError('bad-request', "The request body must include a non-empty 'input' array or 'instructions'.", { status: 400 });
    }
    const { provider, model } = routeModel(body.model, this.providers, this.options.defaultProviderId);
    const credentials = await this.resolveCredentials(provider.id);
    const params = mapResponsesRequest(body, model);
    if (this.options.defaultModel && !body.model) params.model = this.options.defaultModel;

    // Stateful continuation: the client sliced prior turns out and references
    // them via previous_response_id. The bridge holds the state (zen rejects
    // the field outright) — expand the delta against the cache and forward
    // the FULL conversation stateless.
    if (process.env.MODELHITCH_DEBUG === '1') this.log(`<- POST /v1/responses ${JSON.stringify(body)}`);
    params.messages = resolveConversation(params, body.previous_response_id);

    // Never forward an unanswerable input: if the delta can't be resolved
    // against the cache (previous_response_id lost/missing), try re-anchoring
    // the tool results by their call ids — the function_call they answer may
    // still be cached. Only if nothing resolves do we fail, with a clear
    // message instead of the upstream provider's opaque 400.
    const hasRealContent = params.messages.some((m) => m.role !== 'tool');
    if (!hasRealContent) {
      const outputs = toolOutputsFromInput(body.input);
      const prior = outputs.length > 0 ? findConversationWithToolCall(new Set(outputs.map((o) => o.callId))) : undefined;
      if (prior) {
        this.log(`  ~~ re-anchored delta by call_id (${outputs.map((o) => o.callId).join(', ')})`);
        params.messages = [...prior, ...toolMessagesFromOutputs(outputs)];
      } else {
        throw new ModelHitchError(
          'bad-request',
          'This request contains only tool results whose conversation state is unavailable (bridge restarted or cache evicted). Start a new chat.',
          { status: 400 },
        );
      }
    }
    params.previousResponseId = undefined;

    if (body.stream === true) {
      this.log(`  -> ${provider.id}/${model} (responses stream)`);
      await this.writeResponsesStream(res, provider, params, credentials, model);
      return;
    }

    this.log(`  -> ${provider.id}/${model} (responses)`);
    const startedAt = Date.now();
    const result = await provider.chat(params, credentials);
    this.reportUsage({ providerId: provider.id, model, wire: 'responses', streamed: false }, result.usage, startedAt);
    const completion = toResponsesCompletion(result, model);
    this.sendJson(res, 200, completion);
    // Remember this turn so a follow-up previous_response_id can be resolved.
    rememberConversation(String(completion.id), [...params.messages, ...assistantMessagesFromResult(result.message)]);
  }

  /** Stream a normalized provider stream out as Responses API SSE events. */
  private async writeResponsesStream(
    res: ServerResponse,
    provider: Provider,
    params: ChatParams,
    credentials: ProviderCredentials,
    model: string,
  ): Promise<void> {
    const controller = new AbortController();
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });

    // Abort the upstream call if the client disconnects mid-stream.
    res.on('close', () => {
      if (!res.writableEnded) controller.abort();
    });

    try {
      const stream = this.trackStream(
        provider.stream({ ...params, signal: controller.signal }, credentials),
        { providerId: provider.id, model, wire: 'responses', streamed: true },
        Date.now(),
      );
      for await (const line of toResponsesStreamEvents(stream, model, {
        onCompleted: (responseId, assistantMessages) => {
          rememberConversation(responseId, [...params.messages, ...assistantMessages]);
        },
      })) {
        res.write(line);
      }
      res.end();
    } catch (err) {
      if (res.writableEnded) return;
      const { status, body } = toOpenAIError(err);
      res.write(
        `data: ${JSON.stringify({
          type: 'response.failed',
          response: { error: { code: body.error.code ?? 'provider_error', message: body.error.message } },
        })}\n\n`,
      );
      res.end();
      this.log(`  !! ${provider.id} failed: HTTP ${status} ${body.error.code}`);
    }
  }

  // ---------------------------------------------------------------------------
  // Anthropic Messages (Claude Code gateway wire protocol)
  // ---------------------------------------------------------------------------

  private async handleAnthropic(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const body = (await this.readBody(req)) as AnthropicRequest | null;
    if (!body || !Array.isArray(body.messages) || body.messages.length === 0) {
      throw new ModelHitchError('bad-request', "The request body must include a non-empty 'messages' array.", { status: 400 });
    }
    const { provider, model } = routeModel(body.model, this.providers, this.options.defaultProviderId);
    const credentials = await this.resolveCredentials(provider.id);
    const params = mapAnthropicRequest(body, model);
    if (this.options.defaultModel && !body.model) params.model = this.options.defaultModel;

    if (body.stream === true) {
      this.log(`  -> ${provider.id}/${model} (anthropic stream)`);
      await this.writeAnthropicStream(res, provider, params, credentials, model, body);
      return;
    }

    this.log(`  -> ${provider.id}/${model} (anthropic)`);
    const startedAt = Date.now();
    const result = await provider.chat(params, credentials);
    this.reportUsage({ providerId: provider.id, model, wire: 'messages', streamed: false }, result.usage, startedAt);
    this.sendJson(res, 200, toAnthropicCompletion(result, model, estimateAnthropicInputTokens(body)));
  }

  /** Stream a normalized provider stream out as Anthropic Messages SSE events. */
  private async writeAnthropicStream(
    res: ServerResponse,
    provider: Provider,
    params: ChatParams,
    credentials: ProviderCredentials,
    model: string,
    body: AnthropicRequest,
  ): Promise<void> {
    const controller = new AbortController();
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });

    // Abort the upstream call if the client disconnects mid-stream.
    res.on('close', () => {
      if (!res.writableEnded) controller.abort();
    });

    // Keep-alive pings: Claude Code aborts streams that go silent for ~300s,
    // so relay a ping while upstream is thinking.
    const ping = setInterval(() => {
      if (!res.writableEnded) res.write('event: ping\ndata: {"type":"ping"}\n\n');
    }, 15_000);

    try {
      const stream = this.trackStream(
        provider.stream({ ...params, signal: controller.signal }, credentials),
        { providerId: provider.id, model, wire: 'messages', streamed: true },
        Date.now(),
      );
      for await (const line of toAnthropicStreamEvents(stream, model, estimateAnthropicInputTokens(body))) {
        res.write(line);
      }
      res.end();
    } catch (err) {
      if (res.writableEnded) return;
      const { status, body: errBody } = toAnthropicError(err);
      res.write(`event: error\ndata: ${JSON.stringify(errBody)}\n\n`);
      res.end();
      this.log(`  !! ${provider.id} failed: HTTP ${status} ${(errBody.error as { type?: string })?.type ?? 'error'}`);
    } finally {
      clearInterval(ping);
    }
  }

  /** Claude Code's optional token counter — cheap estimate, no inference call. */
  private async handleAnthropicCountTokens(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const body = await this.readBody(req);
    if (!body || typeof body !== 'object' || !Array.isArray((body as AnthropicRequest).messages) || (body as AnthropicRequest).messages!.length === 0) {
      throw new ModelHitchError('bad-request', "The request body must include a non-empty 'messages' array.", { status: 400 });
    }
    this.sendJson(res, 200, { input_tokens: estimateAnthropicInputTokens(body) });
  }

  // ---------------------------------------------------------------------------
  // Gemini generateContent (Gemini CLI / Google-native wire protocol)
  // ---------------------------------------------------------------------------

  private async handleGemini(
    req: IncomingMessage,
    res: ServerResponse,
    modelFromPath: string,
    stream: boolean,
  ): Promise<void> {
    const body = (await this.readBody(req)) as GeminiRequest | null;
    if (!body || !Array.isArray(body.contents) || body.contents.length === 0) {
      throw new ModelHitchError('bad-request', "The request body must include a non-empty 'contents' array.", { status: 400 });
    }
    // The model lives in the URL path for the Google wire; body.model (if any)
    // is a fallback for clients that send it anyway.
    const { provider, model } = routeModel(modelFromPath || body.model, this.providers, this.options.defaultProviderId);
    const credentials = await this.resolveCredentials(provider.id);
    const params = mapGeminiRequest(body, model);
    if (this.options.defaultModel && !modelFromPath && !body.model) params.model = this.options.defaultModel;

    if (stream) {
      this.log(`  -> ${provider.id}/${model} (gemini stream)`);
      await this.writeGeminiStream(res, provider, params, credentials, model, body);
      return;
    }

    this.log(`  -> ${provider.id}/${model} (gemini)`);
    const startedAt = Date.now();
    const result = await provider.chat(params, credentials);
    this.reportUsage({ providerId: provider.id, model, wire: 'gemini', streamed: false }, result.usage, startedAt);
    this.sendJson(res, 200, toGeminiCompletion(result, model, estimateGeminiInputTokens(body)));
  }

  /** Stream a normalized provider stream out as Google `:streamGenerateContent` SSE. */
  private async writeGeminiStream(
    res: ServerResponse,
    provider: Provider,
    params: ChatParams,
    credentials: ProviderCredentials,
    model: string,
    body: GeminiRequest,
  ): Promise<void> {
    const controller = new AbortController();
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });

    // Abort the upstream call if the client disconnects mid-stream.
    res.on('close', () => {
      if (!res.writableEnded) controller.abort();
    });

    try {
      const stream = this.trackStream(
        provider.stream({ ...params, signal: controller.signal }, credentials),
        { providerId: provider.id, model, wire: 'gemini', streamed: true },
        Date.now(),
      );
      for await (const line of toGeminiStreamEvents(stream, model, estimateGeminiInputTokens(body))) {
        res.write(line);
      }
      res.end();
    } catch (err) {
      if (res.writableEnded) return;
      // Mid-stream failures surface as a Google error envelope chunk — the SDK
      // reads `error` out of the SSE payload, same as a plain JSON error.
      const { status, body: errBody } = toGeminiError(err);
      res.write(`data: ${JSON.stringify(errBody)}\n\n`);
      res.end();
      this.log(`  !! ${provider.id} failed: HTTP ${status} ${(errBody.error as { status?: string })?.status ?? 'INTERNAL'}`);
    }
  }

  // ---------------------------------------------------------------------------
  // Models
  // ---------------------------------------------------------------------------

  private async modelCatalog(): Promise<OpenAIModelEntry[]> {
    const out: OpenAIModelEntry[] = [];
    const seen = new Set<string>();
    const push = (id: string, ownedBy: string) => {
      if (!id || seen.has(id)) return;
      seen.add(id);
      out.push({ id, object: 'model', created: 0, owned_by: ownedBy });
    };

    for (const provider of this.providers) {
      const credentials = await this.resolveCredentials(provider.id);
      const ownedBy = provider.id;
      // The default provider's models are advertised with bare ids.
      const isDefault = provider.id === this.options.defaultProviderId;
      const qualify = (modelId: string) => (isDefault ? modelId : `${provider.id}/${modelId}`);

      push(qualify(provider.defaultModel), ownedBy);
      for (const modelId of this.options.staticModels?.[provider.id] ?? []) {
        push(qualify(modelId), ownedBy);
      }
      if (provider.listModels) {
        try {
          const live = await provider.listModels(credentials);
          for (const m of live) push(qualify(m.id), ownedBy);
        } catch {
          // Missing key / offline endpoint: static catalog still applies.
        }
      }
    }
    return out.sort((a, b) => a.id.localeCompare(b.id));
  }

  private async handleModels(res: ServerResponse): Promise<void> {
    const data = await this.modelCatalog();
    this.log(`  -> ${data.length} models`);
    this.sendJson(res, 200, { object: 'list', data });
  }

  private async handleModelById(res: ServerResponse, id: string): Promise<void> {
    const catalog = await this.modelCatalog();
    const entry = catalog.find((m) => m.id === id);
    if (!entry) {
      throw new ModelHitchError('model-not-found', `Model "${id}" is not available on this bridge.`, { status: 404 });
    }
    this.sendJson(res, 200, entry);
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  /** Credential resolution: apiKeys option > keystore > provider env fallback. */
  private async resolveCredentials(providerId: string): Promise<ProviderCredentials> {
    const credentials: ProviderCredentials = {};
    if (this.options.apiKeys?.[providerId]) credentials.apiKey = this.options.apiKeys[providerId];
    if (this.options.baseUrls?.[providerId]) credentials.baseUrl = this.options.baseUrls[providerId];
    if (!credentials.apiKey && this.options.keystore) {
      const apiKey = await this.options.keystore.get(providerId);
      if (apiKey) credentials.apiKey = apiKey;
    }
    return credentials;
  }

  private readBody(req: IncomingMessage): Promise<unknown> {
    const max = this.options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      let size = 0;
      req.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (size > max) {
          // Don't destroy the socket — the error response wouldn't flush.
          // Pause reading and let the dispatch error handler write the 413;
          // Node closes the connection after the response since the body
          // wasn't consumed.
          req.pause();
          reject(new ModelHitchError('bad-request', 'Request body too large.', { status: 413 }));
          return;
        }
        chunks.push(chunk);
      });
      req.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        if (!text.trim()) return resolve({});
        try {
          const parsed = JSON.parse(text) as unknown;
          // Inline local image files (file://, vscode-resource:// URIs) so the
          // upstream never has to fetch client-local URLs — otherwise those
          // come back as opaque upstream 400s. Data/http(s) URLs are untouched.
          normalizeBodyImages(parsed)
            .then(() => resolve(parsed))
            .catch((err) => reject(err));
        } catch {
          reject(new ModelHitchError('bad-request', 'Request body is not valid JSON.', { status: 400 }));
        }
      });
      req.on('error', reject);
    });
  }

  private sendJson(res: ServerResponse, status: number, data: unknown): void {
    this.cors(res);
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(data));
  }

  private sendError(res: ServerResponse, err: unknown): void {
    if (res.headersSent) return;
    const { status, body } = toOpenAIError(err);
    this.log(`  !! HTTP ${status} ${body.error.code}: ${body.error.message}`);
    this.sendJson(res, status, body);
  }

  private cors(res: ServerResponse): void {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  }

  private log(line: string): void {
    this.options.logger?.(line);
  }

  // ---------------------------------------------------------------------------
  // Usage / cost tracking
  // ---------------------------------------------------------------------------

  private emitUsage(event: UsageEvent): void {
    this.options.onUsage?.(event);
  }

  /** Report usage for a completed non-stream call. */
  private reportUsage(
    info: { providerId: string; model: string; wire: string; streamed: boolean },
    usage: Usage | undefined,
    startedAt: number,
  ): void {
    if (!usage) return;
    const cost = estimateCost(info.model, usage, info.providerId);
    this.emitUsage({
      ...info,
      inputTokens: usage.inputTokens ?? 0,
      outputTokens: usage.outputTokens ?? 0,
      totalTokens: usage.totalTokens ?? (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0),
      costUsd: cost.totalCostUsd,
      latencyMs: Date.now() - startedAt,
      at: new Date().toISOString(),
    });
  }

  /**
   * Wrap a provider stream to capture the `finish` event's usage and report
   * it via `onUsage` once the stream runs to completion. Pass-through: chunk
   * events are re-emitted untouched. Aborted/errored streams report nothing
   * (their usage is partial at best).
   */
  private trackStream(
    stream: AsyncIterable<StreamChunk>,
    info: { providerId: string; model: string; wire: string; streamed: boolean },
    startedAt: number,
  ): AsyncIterable<StreamChunk> {
    const self = this;
    let usage: Usage | undefined;
    return (async function* () {
      for await (const chunk of stream) {
        if (chunk.type === 'finish') usage = chunk.usage;
        yield chunk;
      }
      self.reportUsage(info, usage, startedAt);
    })();
  }
}

/** Create a bridge server with the given options. */
export function createModelHitchServer(options: ModelHitchServerOptions = {}): OpenAICompatibleServer {
  return new OpenAICompatibleServer(options);
}
