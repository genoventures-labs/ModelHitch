import { ModelHitchError } from '../core/errors.js';
import type {
  Capabilities,
  ChatParams,
  ChatResult,
  ContentPart,
  ModelMessage,
  ProviderCredentials,
  StreamChunk,
  ToolCall,
  ToolChoice,
  Usage,
} from '../core/types.js';
import { safeJsonParse } from '../core/json.js';
import { bodyToAsyncIterable, parseSSE, requireBody } from '../core/stream.js';
import type { ModelInfo, Provider } from './types.js';

/**
 * OpenCode Zen Gemini adapter — speaks Google's native Generative Language API
 * against https://opencode.ai/zen/v1/models/{model}:generateContent.
 *
 * Verified against opencode's own console router (packages/console/app/src/
 * routes/zen/v1/models/[model].ts): Zen mirrors the Google endpoints
 * (`:generateContent`, `:streamGenerateContent?alt=sse`) and authenticates with
 * the `x-goog-api-key` header.
 *
 * Gemini specifics handled here:
 *  - system messages -> `systemInstruction`, tool results -> `functionResponse`
 *  - streaming function-call args arrive either as one complete JSON object or
 *    as partial JSON *strings* — both are normalized to args-delta events
 *  - `thoughtSignature` (sibling of `functionCall`) is captured and echoed back
 *    on the next turn's functionCall part, as the API requires
 *  - `tool_choice` -> `toolConfig.functionCallingConfig`
 *  - JSON mode -> `generationConfig.responseMimeType: "application/json"`
 */

export interface ZenGeminiProviderOptions {
  /** Base URL, e.g. "https://opencode.ai/zen/v1". */
  baseUrl?: string;
  defaultModel?: string;
  apiKeyEnvVar?: string;
  apiKeyEnvFallbacks?: string[];
  capabilities?: Partial<Capabilities>;
  fetchImpl?: typeof fetch;
}

interface GeminiPart {
  text?: string;
  functionCall?: { id?: string; name?: string; args?: unknown };
  /** Sibling of `functionCall` (NOT nested inside it) — required on turn-2 echoes. */
  thoughtSignature?: string;
  functionResponse?: { name?: string; response?: unknown };
  inlineData?: { mimeType?: string; data?: string };
  fileData?: { fileUri?: string };
  thought?: boolean;
}

interface GeminiContent {
  role?: string;
  parts?: GeminiPart[];
}

interface GeminiCandidate {
  content?: GeminiContent;
  finishReason?: string;
}

interface GeminiResponse {
  candidates?: GeminiCandidate[];
  usageMetadata?: {
    promptTokenCount?: number;
    candidatesTokenCount?: number;
    totalTokenCount?: number;
  };
  error?: { message?: string; status?: string };
}

type GeminiArgsState = 'object' | 'string';

/** Map a normalized ToolChoice to Gemini's functionCallingConfig. */
function toGeminiToolConfig(choice: ToolChoice | undefined): unknown {
  if (!choice || choice === 'auto') return undefined;
  if (choice === 'none') return { functionCallingConfig: { mode: 'NONE' } };
  if (choice === 'required') return { functionCallingConfig: { mode: 'ANY' } };
  return {
    functionCallingConfig: { mode: 'ANY', allowedFunctionNames: [choice.name] },
  };
}

/** Map a normalized ResponseFormat onto Gemini generationConfig fields. */
function toGeminiResponseConfig(format: ChatParams['responseFormat']): Record<string, unknown> | undefined {
  if (!format || format === 'text') return undefined;
  const out: Record<string, unknown> = { responseMimeType: 'application/json' };
  if (format !== 'json' && format.type === 'json_schema') {
    out.responseSchema = format.schema;
  }
  return out;
}

function toGeminiPart(part: ContentPart): GeminiPart | undefined {
  switch (part.type) {
    case 'text':
      return { text: part.text };
    case 'image':
      return { fileData: { fileUri: part.imageUrl } };
    case 'image-data':
      return { inlineData: { mimeType: part.mimeType, data: part.data } };
    default:
      return undefined;
  }
}

/** Convert normalized messages into Gemini `contents` (+ systemInstruction). */
function toGeminiContents(
  messages: ModelMessage[],
  thoughtSignatures: ReadonlyMap<string, string>,
): {
  system: string;
  contents: GeminiContent[];
} {
  const system: string[] = [];
  const contents: GeminiContent[] = [];
  // Remember toolCallId -> function name so tool results can be mapped.
  const nameById = new Map<string, string>();
  for (const m of messages) {
    switch (m.role) {
      case 'system':
        system.push(typeof m.content === 'string' ? m.content : m.content.map((p) => (p.type === 'text' ? p.text : '')).join(' '));
        break;
      case 'user': {
        const parts: GeminiPart[] =
          typeof m.content === 'string' ? [{ text: m.content }] : (m.content.map(toGeminiPart).filter((p): p is GeminiPart => !!p));
        contents.push({ role: 'user', parts });
        break;
      }
      case 'assistant': {
        const parts: GeminiPart[] = [];
        if (typeof m.content === 'string') {
          if (m.content) parts.push({ text: m.content });
        } else {
          for (const p of m.content) if (p.type === 'text' && p.text) parts.push({ text: p.text });
        }
        for (const tc of m.toolCalls ?? []) {
          nameById.set(tc.id, tc.name);
          // Prefer the signature the client echoed back over our cached one.
          const sig = tc.thoughtSignature ?? thoughtSignatures.get(tc.name);
          parts.push({
            ...(sig ? { thoughtSignature: sig } : {}),
            functionCall: {
              name: tc.name,
              args: tc.arguments,
            },
          });
        }
        if (parts.length) contents.push({ role: 'model', parts });
        break;
      }
      case 'tool': {
        const name = nameById.get(m.toolCallId) ?? m.toolCallId;
        let response: unknown = m.content;
        if (typeof m.content === 'string') {
          response = safeJsonParse<unknown>(m.content, m.content);
        }
        contents.push({
          role: 'user',
          parts: [{ functionResponse: { name, response } }],
        });
        break;
      }
    }
  }
  return { system: system.join('\n\n'), contents };
}

function toUsage(u?: GeminiResponse['usageMetadata']): Usage | undefined {
  if (!u) return undefined;
  return {
    inputTokens: u.promptTokenCount,
    outputTokens: u.candidatesTokenCount,
    totalTokens: u.totalTokenCount,
  };
}

function mapFinishReason(reason?: string): string {
  switch (reason) {
    case undefined:
    case 'STOP':
      return 'stop';
    case 'MAX_TOKENS':
      return 'length';
    case 'TOOL_CALLS':
      return 'tool-calls';
    case 'SAFETY':
    case 'RECITATION':
    case 'BLOCKLIST':
    case 'PROHIBITED_CONTENT':
      return 'content-filter';
    default:
      return reason?.toLowerCase() ?? 'stop';
  }
}

function parseArgs(args: unknown, state: GeminiArgsState): Record<string, unknown> {
  if (state === 'string') {
    const parsed = safeJsonParse<Record<string, unknown>>(String(args ?? ''), { _raw: String(args ?? '') });
    return parsed;
  }
  return (args as Record<string, unknown>) ?? {};
}

/**
 * Native OpenCode Zen provider for the Gemini family, served through Google's
 * Generative Language API at https://opencode.ai/zen/v1/models/{model}.
 */
export class ZenGeminiProvider implements Provider {
  readonly id: string;
  readonly name: string;
  readonly defaultModel: string;
  readonly capabilities: Capabilities;
  private readonly baseUrl: string;
  private readonly apiKeyEnvVar: string;
  private readonly apiKeyEnvFallbacks: string[];
  private readonly fetchImpl: typeof fetch;
  /** Latest thought_signature per tool name, echoed back on functionCall parts. */
  private readonly thoughtSignatures = new Map<string, string>();

  constructor(opts: ZenGeminiProviderOptions = {}) {
    this.id = 'zen-gemini';
    this.name = 'OpenCode Zen (Gemini)';
    this.defaultModel = opts.defaultModel ?? 'gemini-3.5-flash-lite';
    this.baseUrl = (opts.baseUrl ?? 'https://opencode.ai/zen/v1').replace(/\/+$/, '');
    this.apiKeyEnvVar = opts.apiKeyEnvVar ?? 'OPENCODE_ZEN_API_KEY';
    this.apiKeyEnvFallbacks = opts.apiKeyEnvFallbacks ?? ['OPENCODE_API_KEY'];
    this.capabilities = {
      streaming: true,
      toolCalling: true,
      vision: true,
      embeddings: false,
      maxContextTokens: 1_000_000,
      ...opts.capabilities,
    };
    this.fetchImpl = opts.fetchImpl ?? ((...args) => fetch(...args));
  }

  resolveApiKey(credentials: ProviderCredentials): string {
    if (credentials.apiKey) return credentials.apiKey;
    for (const name of [this.apiKeyEnvVar, ...this.apiKeyEnvFallbacks]) {
      const value = (typeof process !== 'undefined' && process.env?.[name]) as string | undefined;
      if (value) return value;
    }
    throw new ModelHitchError(
      'missing-api-key',
      `Provider "${this.id}" requires an API key. Pass one in the client options or set ${this.apiKeyEnvVar}.`,
      { providerId: this.id },
    );
  }

  private buildBody(params: ChatParams, stream: boolean): Record<string, unknown> {
    const { system, contents } = toGeminiContents(params.messages, this.thoughtSignatures);
    const body: Record<string, unknown> = { contents };
    if (system) body.systemInstruction = { parts: [{ text: system }] };
    if (params.tools?.length) {
      body.tools = params.tools.map((t) => ({
        functionDeclarations: [
          {
            name: t.name,
            description: t.description,
            parameters: t.parameters ?? { type: 'object', properties: {} },
          },
        ],
      }));
    }
    const toolConfig = toGeminiToolConfig(params.toolChoice);
    if (toolConfig !== undefined) body.toolConfig = toolConfig;

    const generationConfig: Record<string, unknown> = {};
    if (params.temperature !== undefined) generationConfig.temperature = params.temperature;
    if (params.maxTokens !== undefined) generationConfig.maxOutputTokens = params.maxTokens;
    if (params.stop?.length) generationConfig.stopSequences = params.stop;
    const responseConfig = toGeminiResponseConfig(params.responseFormat);
    if (responseConfig) Object.assign(generationConfig, responseConfig);
    if (Object.keys(generationConfig).length) body.generationConfig = generationConfig;
    // Note: Gemini streams via the :streamGenerateContent endpoint, not a body flag.
    return body;
  }

  private async request(
    params: ChatParams,
    credentials: ProviderCredentials,
    body: Record<string, unknown>,
    stream: boolean,
  ): Promise<Response> {
    const apiKey = this.resolveApiKey(credentials);
    const action = stream ? 'streamGenerateContent?alt=sse' : 'generateContent';
    const url = `${this.baseUrl}/models/${params.model}:${action}`;
    try {
      return await this.fetchImpl(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-goog-api-key': apiKey,
        },
        body: JSON.stringify(body),
        signal: params.signal,
      });
    } catch (err) {
      if (err instanceof ModelHitchError) throw err;
      throw new ModelHitchError('network-error', `Request to provider "${this.id}" failed: ${(err as Error)?.message}`, {
        providerId: this.id,
        cause: err,
      });
    }
  }

  private mapError(status: number, text: string): ModelHitchError {
    const err = safeJsonParse<GeminiResponse>(text, {});
    const detail = err.error?.message ?? '';
    const base = (message: string) => (detail ? `${message} (${detail})` : message);
    switch (status) {
      case 401:
      case 403:
        return new ModelHitchError('invalid-api-key', base(`Provider "${this.id}" rejected the API key.`), {
          status,
          providerId: this.id,
        });
      case 429:
        return new ModelHitchError('rate-limited', base(`Provider "${this.id}" rate limited the request.`), {
          status,
          providerId: this.id,
        });
      case 404:
        return new ModelHitchError('model-not-found', base(`Provider "${this.id}" could not find the model.`), {
          status,
          providerId: this.id,
        });
      case 400:
        return new ModelHitchError('bad-request', base(`Provider "${this.id}" rejected the request.`), {
          status,
          providerId: this.id,
        });
      default:
        return new ModelHitchError(
          status >= 500 ? 'provider-error' : 'bad-request',
          base(`Provider "${this.id}" returned HTTP ${status}.`),
          { status, providerId: this.id },
        );
    }
  }

  /** Extract text + tool calls from a non-streaming candidate. */
  private fromCandidate(candidate: GeminiCandidate | undefined): {
    content: string;
    toolCalls?: ToolCall[];
  } {
    let content = '';
    const toolCalls: ToolCall[] = [];
    for (const part of candidate?.content?.parts ?? []) {
      if (part.text) content += part.text;
      const fc = part.functionCall;
      if (fc?.name) {
        if (part.thoughtSignature) this.thoughtSignatures.set(fc.name, part.thoughtSignature);
        const args = fc.args;
        toolCalls.push({
          id: fc.id ?? `call_${toolCalls.length}`,
          name: fc.name,
          arguments: parseArgs(args, args !== null && typeof args === 'object' ? 'object' : 'string'),
          ...(part.thoughtSignature ? { thoughtSignature: part.thoughtSignature } : {}),
        });
      }
    }
    return { content, toolCalls: toolCalls.length ? toolCalls : undefined };
  }

  async chat(params: ChatParams, credentials: ProviderCredentials): Promise<ChatResult> {
    const res = await this.request(params, credentials, this.buildBody(params, false), false);
    const text = await res.text();
    if (!res.ok) throw this.mapError(res.status, text);
    const data = safeJsonParse<GeminiResponse>(text, {});
    const candidate = data.candidates?.[0];
    const { content, toolCalls } = this.fromCandidate(candidate);
    const message: ModelMessage =
      toolCalls && toolCalls.length > 0
        ? { role: 'assistant', content, toolCalls }
        : { role: 'assistant', content };
    return {
      message,
      // Zen reports STOP even when the candidate carries a functionCall.
      finishReason: toolCalls?.length ? 'tool-calls' : mapFinishReason(candidate?.finishReason),
      usage: toUsage(data.usageMetadata),
      raw: data,
    };
  }

  async *stream(params: ChatParams, credentials: ProviderCredentials): AsyncGenerator<StreamChunk> {
    const res = await this.request(params, credentials, this.buildBody(params, true), true);
    if (!res.ok) {
      const text = await res.text();
      throw this.mapError(res.status, text);
    }
    const body = requireBody(res, this.id);

    // In-flight tool calls: Zen streams functionCall args either as partial
    // JSON strings OR as one complete object on the first chunk.
    const inFlight = new Map<string, { name: string; args: string; state: GeminiArgsState }>();
    let sawFinish = false;

    for await (const payload of parseSSE(bodyToAsyncIterable(body))) {
      const chunk = safeJsonParse<GeminiResponse | null>(payload, null);
      if (!chunk?.candidates?.length) {
        // Non-candidate chunks: ping/heartbeat lines, or a usage-only tail.
        // Only treat a tail as a finish when it carries real token counts.
        const u = chunk?.usageMetadata;
        if (!sawFinish && u && (u.promptTokenCount || u.candidatesTokenCount || u.totalTokenCount)) {
          sawFinish = true;
          yield { type: 'finish', finishReason: 'stop', usage: toUsage(u) };
        }
        continue;
      }
      const candidate = chunk.candidates[0];
      const finishReason = candidate?.finishReason;
      for (const part of candidate?.content?.parts ?? []) {
        if (part.thought) continue;
        if (part.text) yield { type: 'text-delta', text: part.text };
        const fc = part.functionCall;
        if (fc?.name) {
          if (part.thoughtSignature) this.thoughtSignatures.set(fc.name, part.thoughtSignature);
          const id = fc.id ?? `call_${inFlight.size}`;
          const args = fc.args;
          const state: GeminiArgsState = args !== null && typeof args === 'object' ? 'object' : 'string';
          inFlight.set(id, { name: fc.name, args: state === 'string' ? String(args ?? '') : '', state });
          yield { type: 'tool-call-start', id, name: fc.name, ...(part.thoughtSignature ? { thoughtSignature: part.thoughtSignature } : {}) };
          // Complete object args arrive on the FIRST chunk — stream them as one delta.
          if (state === 'object' && args) {
            const json = JSON.stringify(args);
            inFlight.set(id, { name: fc.name, args: json, state });
            yield { type: 'tool-call-args-delta', id, argsDelta: json };
          } else if (state === 'string' && fc.args) {
            yield { type: 'tool-call-args-delta', id, argsDelta: String(fc.args) };
          }
        } else if (fc) {
          // Continuation of a previous functionCall (partial args or final).
          const id = `call_${inFlight.size - 1}`;
          const acc = inFlight.get(id);
          if (acc) {
            if (typeof fc.args === 'string' && fc.args) {
              acc.args += fc.args;
              yield { type: 'tool-call-args-delta', id, argsDelta: fc.args };
            } else if (acc.state === 'object' && fc.args) {
              acc.args = JSON.stringify(fc.args);
            }
          }
        }
      }
      if (finishReason) {
        for (const id of inFlight.keys()) {
          yield { type: 'tool-call-end', id };
        }
        const usage = toUsage(chunk.usageMetadata);
        sawFinish = true;
        // Zen reports STOP even when it just emitted tool calls.
        const reason = inFlight.size ? 'tool-calls' : mapFinishReason(finishReason);
        yield usage
          ? { type: 'finish', finishReason: reason, usage }
          : { type: 'finish', finishReason: reason };
      }
    }
    if (!sawFinish) {
      for (const id of inFlight.keys()) yield { type: 'tool-call-end', id };
      yield { type: 'finish', finishReason: 'stop' };
    }
  }

  async listModels(credentials: ProviderCredentials): Promise<ModelInfo[]> {
    const apiKey = this.resolveApiKey(credentials);
    const res = await this.fetchImpl(`${this.baseUrl}/models`, {
      headers: { 'x-goog-api-key': apiKey },
    });
    if (!res.ok) {
      throw new ModelHitchError('provider-error', `Failed to list Zen models: HTTP ${res.status}`, {
        providerId: this.id,
      });
    }
    const data = safeJsonParse<{ data?: Array<{ id: string; display_name?: string }> }>(await res.text(), {});
    return (data.data ?? []).map((m) => ({ id: m.id, name: m.display_name }));
  }
}

/** Factory for the OpenCode Zen Gemini adapter. */
export function createZenGeminiProvider(opts: ZenGeminiProviderOptions = {}): Provider {
  return new ZenGeminiProvider(opts);
}

/** Default OpenCode Zen Gemini provider instance. */
export const zenGemini: Provider = createZenGeminiProvider();
