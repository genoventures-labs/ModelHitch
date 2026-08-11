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
} from '../core/types.js';
import { bytesToBase64 } from '../core/base64.js';
import { safeJsonParse } from '../core/json.js';
import { bodyToAsyncIterable, parseLines, requireBody } from '../core/stream.js';
import type { ModelInfo, Provider } from './types.js';

interface OllamaMessage {
  role: string;
  content: string;
  images?: string[];
  tool_calls?: Array<{ function: { name: string; arguments: Record<string, unknown> } }>;
}

interface OllamaChunk {
  message?: OllamaMessage;
  done?: boolean;
  done_reason?: string;
  prompt_eval_count?: number;
  eval_count?: number;
  error?: string;
}

export interface OllamaProviderOptions {
  baseUrl?: string;
  defaultModel?: string;
  fetchImpl?: typeof fetch;
}

/**
 * Native Ollama adapter — runs fully local, no API key required.
 * Endpoints: POST /api/chat (newline-delimited JSON when streaming), GET /api/tags.
 */
export class OllamaProvider implements Provider {
  readonly id = 'ollama';
  readonly name = 'Ollama (local)';
  readonly defaultModel: string;
  readonly capabilities: Capabilities = {
    streaming: true,
    toolCalling: true,
    vision: true,
    embeddings: false,
  };
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: OllamaProviderOptions = {}) {
    this.defaultModel = opts.defaultModel ?? 'llama3.2';
    this.baseUrl = (opts.baseUrl ?? 'http://localhost:11434').replace(/\/+$/, '');
    this.fetchImpl = opts.fetchImpl ?? ((...args) => fetch(...args));
  }

  private async toOllamaContent(
    content: string | ContentPart[],
  ): Promise<{ content: string; images?: string[] }> {
    if (typeof content === 'string') return { content };
    const images: string[] = [];
    const texts: string[] = [];
    for (const part of content) {
      if (part.type === 'text') {
        texts.push(part.text);
      } else if (part.type === 'image-data') {
        images.push(part.data);
      } else {
        const res = await this.fetchImpl(part.imageUrl);
        if (!res.ok) {
          throw new ModelHitchError('network-error', `Failed to fetch image for Ollama: HTTP ${res.status}`, {
            providerId: this.id,
          });
        }
        images.push(bytesToBase64(new Uint8Array(await res.arrayBuffer())));
      }
    }
    return { content: texts.join(' '), images: images.length ? images : undefined };
  }

  private async toOllamaMessages(messages: ModelMessage[]): Promise<OllamaMessage[]> {
    const out: OllamaMessage[] = [];
    for (const m of messages) {
      switch (m.role) {
        case 'system':
        case 'user': {
          const { content, images } = await this.toOllamaContent(m.content);
          out.push({ role: m.role, content, images });
          break;
        }
        case 'assistant': {
          const { content } = await this.toOllamaContent(m.content);
          const toolCalls = m.toolCalls?.map((tc) => ({ function: { name: tc.name, arguments: tc.arguments } }));
          out.push(toolCalls?.length ? { role: 'assistant', content, tool_calls: toolCalls } : { role: 'assistant', content });
          break;
        }
        case 'tool':
          out.push({ role: 'tool', content: m.content });
          break;
      }
    }
    return out;
  }

  private buildBody(params: ChatParams, stream: boolean): Record<string, unknown> {
    const body: Record<string, unknown> = {
      model: params.model,
      messages: undefined as unknown,
      stream,
      options: {},
    };
    if (params.temperature !== undefined) (body.options as Record<string, unknown>).temperature = params.temperature;
    if (params.maxTokens !== undefined) (body.options as Record<string, unknown>).num_predict = params.maxTokens;
    if (params.stop?.length) (body.options as Record<string, unknown>).stop = params.stop;
    if (params.tools?.length) {
      body.tools = params.tools.map((t) => ({ type: 'function', function: t }));
    }
    return body;
  }

  private async request(params: ChatParams, body: Record<string, unknown>): Promise<Response> {
    const messages = await this.toOllamaMessages(params.messages);
    body.messages = messages;
    try {
      return await this.fetchImpl(`${this.baseUrl}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
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

  async chat(params: ChatParams, credentials: ProviderCredentials): Promise<ChatResult> {
    const res = await this.request(params, this.buildBody(params, false));
    const data = safeJsonParse<OllamaChunk>(await res.text(), {});
    if (data.error) throw new ModelHitchError('provider-error', data.error, { providerId: this.id });
    if (!res.ok) throw new ModelHitchError('provider-error', `Ollama returned HTTP ${res.status}`, { providerId: this.id });
    const toolCalls: ToolCall[] | undefined = data.message?.tool_calls?.map((tc, i) => ({
      id: `ollama_${i}`,
      name: tc.function.name,
      arguments: tc.function.arguments,
    }));
    const message: ModelMessage =
      toolCalls && toolCalls.length > 0
        ? { role: 'assistant', content: data.message?.content ?? '', toolCalls }
        : { role: 'assistant', content: data.message?.content ?? '' };
    return {
      message,
      finishReason: mapDoneReason(data.done_reason),
      usage: {
        inputTokens: data.prompt_eval_count,
        outputTokens: data.eval_count,
      },
      raw: data,
    };
  }

  async *stream(params: ChatParams, credentials: ProviderCredentials): AsyncGenerator<StreamChunk> {
    const res = await this.request(params, this.buildBody(params, true));
    if (!res.ok) {
      const text = await res.text();
      const err = safeJsonParse<{ error?: string }>(text, {});
      throw new ModelHitchError('provider-error', err.error ?? `Ollama returned HTTP ${res.status}`, {
        providerId: this.id,
      });
    }
    const body = requireBody(res, this.id);
    const toolAcc = new Map<string, { id: string; name: string; args: string }>();

    for await (const line of parseLines(bodyToAsyncIterable(body))) {
      const chunk = safeJsonParse<OllamaChunk>(line, {});
      if (chunk.error) throw new ModelHitchError('provider-error', chunk.error, { providerId: this.id });
      const content = chunk.message?.content;
      if (content) yield { type: 'text-delta', text: content };
      for (const tc of chunk.message?.tool_calls ?? []) {
        const key = tc.function.name;
        const id = `ollama_${toolAcc.size}`;
        toolAcc.set(key, { id, name: tc.function.name, args: '' });
        yield { type: 'tool-call-start', id, name: tc.function.name };
        const argsJson = JSON.stringify(tc.function.arguments);
        toolAcc.get(key)!.args = argsJson;
        yield { type: 'tool-call-args-delta', id, argsDelta: argsJson };
        yield { type: 'tool-call-end', id };
      }
      if (chunk.done) {
        if (toolAcc.size > 0) {
          // tool calls already ended above; ensure finish fires
        }
        yield {
          type: 'finish',
          finishReason: mapDoneReason(chunk.done_reason),
          usage: { inputTokens: chunk.prompt_eval_count, outputTokens: chunk.eval_count },
        };
      }
    }
  }

  async listModels(credentials: ProviderCredentials): Promise<ModelInfo[]> {
    const res = await this.fetchImpl(`${this.baseUrl}/api/tags`);
    if (!res.ok) throw new ModelHitchError('provider-error', `Ollama returned HTTP ${res.status}`, { providerId: this.id });
    const data = safeJsonParse<{ models?: Array<{ name: string }> }>(await res.text(), {});
    return (data.models ?? []).map((m) => ({ id: m.name }));
  }
}

function mapDoneReason(reason?: string): string {
  switch (reason) {
    case undefined:
    case 'stop':
      return 'stop';
    case 'length':
      return 'length';
    case 'tool_calls':
      return 'tool-calls';
    default:
      return reason;
  }
}

export function createOllamaProvider(opts: OllamaProviderOptions = {}): Provider {
  return new OllamaProvider(opts);
}

/** Default Ollama provider instance. */
export const ollama: Provider = createOllamaProvider();
