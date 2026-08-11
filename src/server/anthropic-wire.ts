import { randomUUID } from 'node:crypto';
import { ModelHitchError } from '../core/errors.js';
import { serializeText } from '../core/content.js';
import type {
  ChatParams,
  ChatResult,
  ContentPart,
  ModelMessage,
  StreamChunk,
  ToolCall,
  ToolChoice,
  ToolDefinition,
  Usage,
} from '../core/types.js';

/**
 * Anthropic *Messages API* wire protocol — what Claude Code speaks to any
 * LLM gateway configured via `ANTHROPIC_BASE_URL`.
 *
 * The bridge maps between the two wire protocols:
 *
 *   Claude Code (Anthropic Messages) -> normalized ChatParams -> family router
 *     POST /v1/messages                  (system/messages/tools)    -> /chat/completions
 *                                                                   -> /responses
 *                                                                   -> /messages
 *                                                                   -> :generateContent
 *
 * Claude Code treats a custom `ANTHROPIC_BASE_URL` as an Anthropic-format
 * endpoint and passes *any* model id through unchecked, so model strings like
 * `gpt-5.6-luna` (or `provider/model`) reach the bridge as-is and route by
 * family. The bridge must tolerate Claude Code's extras: `thinking`,
 * `context_management`, `output_config` and `anthropic-beta` headers are
 * ignored/dropped (never 400'd); tool_use `input` is a JSON *object* (not a
 * string like OpenAI); and inference responses must stream Anthropic SSE
 * events (message_start -> content_block_* -> message_delta -> message_stop)
 * with periodic pings.
 */

export interface AnthropicRequest {
  model?: string;
  /** Single system prompt: a string or a list of text blocks. */
  system?: string | Array<{ type?: string; text?: string }>;
  /** Conversation: user/assistant turns; tool results live in user content. */
  messages?: Array<{ role?: string; content?: string | unknown[] }>;
  max_tokens?: number;
  stream?: boolean;
  temperature?: number;
  stop_sequences?: string[];
  tools?: Array<{ name?: string; description?: string; input_schema?: Record<string, unknown> }>;
  tool_choice?: Record<string, unknown> | string;
  // Fields Claude Code sends that the bridge deliberately drops:
  thinking?: unknown;
  context_management?: unknown;
  output_config?: unknown;
  metadata?: unknown;
  betas?: unknown[];
}

interface AnthropicContentBlock {
  type?: string;
  text?: string;
  id?: string;
  name?: string;
  input?: unknown;
  tool_use_id?: string;
  content?: unknown;
  source?: { type?: string; media_type?: string; data?: string; url?: string };
}

// ---------------------------------------------------------------------------
// Inbound: Anthropic Messages request -> normalized ChatParams
// ---------------------------------------------------------------------------

/**
 * Convert an Anthropic `messages` array into normalized messages. Text and
 * image blocks become user/assistant content; `tool_use` blocks become
 * assistant tool calls (input is already a JSON object); `tool_result` blocks
 * become `tool` messages with the matching `toolCallId`. Thinking and
 * redacted-thinking blocks carry no instruction for the routed model — drop.
 */
export function anthropicMessagesToMessages(messages: AnthropicRequest['messages']): ModelMessage[] {
  const out: ModelMessage[] = [];
  for (const raw of messages ?? []) {
    const msg = raw as { role?: string; content?: string | AnthropicContentBlock[] };
    const role = msg.role ?? 'user';
    const blocks: AnthropicContentBlock[] =
      typeof msg.content === 'string' ? [{ type: 'text', text: msg.content }] : (msg.content ?? []);

    const textParts: string[] = [];
    const imageParts: ContentPart[] = [];
    const toolCalls: ToolCall[] = [];
    const toolResults: Array<{ id: string; content: string }> = [];

    for (const block of blocks) {
      switch (block.type) {
        case 'text':
          if (block.text) textParts.push(block.text);
          break;
        case 'image': {
          const src = block.source;
          if (src?.type === 'base64' && src.data) {
            imageParts.push({ type: 'image-data', mimeType: src.media_type ?? 'image/png', data: src.data });
          } else if (src?.type === 'url' && src.url) {
            imageParts.push({ type: 'image', imageUrl: src.url });
          }
          break;
        }
        case 'tool_use':
          toolCalls.push({
            id: block.id ?? `toolu_${out.length}`,
            name: block.name ?? 'unknown',
            arguments: (block.input as Record<string, unknown>) ?? {},
          });
          break;
        case 'tool_result':
          toolResults.push({
            id: block.tool_use_id ?? '',
            content: typeof block.content === 'string' ? block.content : JSON.stringify(block.content ?? ''),
          });
          break;
        // 'thinking' / 'redacted_thinking' / 'server_tool_use' / ... — drop.
      }
    }

    const content: string | ContentPart[] =
      imageParts.length > 0
        ? [
            ...imageParts,
            ...(textParts.length ? [{ type: 'text', text: textParts.join('\n') } as ContentPart] : []),
          ]
        : textParts.join('\n');

    if (role === 'system') {
      out.push({ role: 'system', content: textParts.join('\n') });
    } else if (role === 'assistant') {
      if (content !== '' || toolCalls.length > 0) {
        out.push(toolCalls.length ? { role: 'assistant', content, toolCalls } : { role: 'assistant', content });
      }
    } else {
      if (content !== '') out.push({ role: 'user', content });
      for (const tr of toolResults) {
        out.push({ role: 'tool', content: tr.content, toolCallId: tr.id });
      }
    }
  }
  return out;
}

function mapAnthropicToolChoice(choice: AnthropicRequest['tool_choice']): ToolChoice | undefined {
  if (typeof choice === 'string') return choice === 'any' ? 'required' : choice === 'none' ? 'none' : undefined;
  if (choice && typeof choice === 'object') {
    const c = choice as Record<string, unknown>;
    if (c.type === 'none') return 'none';
    if (c.type === 'any') return 'required';
    if (c.type === 'tool' && typeof c.name === 'string') return { type: 'function', name: c.name };
  }
  return undefined;
}

/** Convert an Anthropic Messages request into normalized ChatParams. */
export function mapAnthropicRequest(body: AnthropicRequest, model: string): ChatParams {
  const messages = anthropicMessagesToMessages(body.messages);

  // Anthropic keeps the system prompt in a top-level `system` field (a string
  // or a list of text blocks — Claude Code prepends its attribution block).
  const systemText =
    typeof body.system === 'string'
      ? body.system
      : (body.system ?? []).map((b) => b.text ?? '').join('\n\n');
  if (systemText) messages.unshift({ role: 'system', content: systemText });

  const params: ChatParams = { model, messages };
  if (Array.isArray(body.tools)) {
    const tools: ToolDefinition[] = [];
    for (const t of body.tools) {
      if (t.name) tools.push({ name: t.name, description: t.description, parameters: t.input_schema ?? {} });
    }
    if (tools.length) params.tools = tools;
  }
  const toolChoice = mapAnthropicToolChoice(body.tool_choice);
  if (toolChoice) params.toolChoice = toolChoice;
  if (typeof body.max_tokens === 'number') params.maxTokens = body.max_tokens;
  if (typeof body.temperature === 'number') params.temperature = body.temperature;
  if (Array.isArray(body.stop_sequences) && body.stop_sequences.length) params.stop = body.stop_sequences;
  // thinking / context_management / output_config / metadata / betas are
  // intentionally not mapped — the routed model decides its own reasoning.
  return params;
}

// ---------------------------------------------------------------------------
// Outbound: normalized result -> Anthropic Messages body / SSE events
// ---------------------------------------------------------------------------

/** Normalized finish reason -> Anthropic stop_reason. */
function toAnthropicStopReason(reason: string): string {
  switch (reason) {
    case 'length':
      return 'max_tokens';
    case 'tool-calls':
      return 'tool_use';
    default:
      return 'end_turn';
  }
}

/** Convert a normalized ChatResult into a non-streamed Anthropic response. */
export function toAnthropicCompletion(
  result: ChatResult,
  model: string,
  inputTokens = 0,
): Record<string, unknown> {
  const content: Array<Record<string, unknown>> = [];
  const text = serializeText(result.message.content);
  if (text) content.push({ type: 'text', text });
  if (result.message.role === 'assistant') {
    for (const tc of result.message.toolCalls ?? []) {
      content.push({ type: 'tool_use', id: tc.id, name: tc.name, input: tc.arguments });
    }
  }
  return {
    id: `msg_${randomUUID()}`,
    type: 'message',
    role: 'assistant',
    model,
    content,
    stop_reason: toAnthropicStopReason(result.finishReason),
    stop_sequence: null,
    usage: {
      input_tokens: result.usage?.inputTokens ?? inputTokens,
      output_tokens: result.usage?.outputTokens ?? 0,
    },
  };
}

/**
 * Convert a normalized provider event stream into Anthropic Messages SSE
 * lines (`event: <type>\ndata: {...}\n\n`). Emits message_start, per-block
 * content_block_start/delta/stop (text_delta / input_json_delta), then
 * message_delta with the resolved stop_reason, then message_stop. The server
 * layer interleaves `ping` events so the client's 300s silence watchdog
 * never trips during long upstream pauses.
 */
export async function* toAnthropicStreamEvents(
  events: AsyncIterable<StreamChunk>,
  model: string,
  inputTokens = 0,
): AsyncGenerator<string> {
  const id = `msg_${randomUUID()}`;
  const emit = (type: string, data: unknown) => `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;

  yield emit('message_start', {
    type: 'message_start',
    message: {
      id,
      type: 'message',
      role: 'assistant',
      model,
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: inputTokens, output_tokens: 0 },
    },
  });

  let textBlock: { index: number } | null = null;
  const toolBlocks = new Map<string, { index: number }>();
  let nextIndex = 0;
  let finishReason = 'end_turn';
  let outputTokens = 0;

  try {
    for await (const event of events) {
      switch (event.type) {
        case 'text-delta': {
          if (!textBlock) {
            textBlock = { index: nextIndex++ };
            yield emit('content_block_start', {
              type: 'content_block_start',
              index: textBlock.index,
              content_block: { type: 'text', text: '' },
            });
          }
          yield emit('content_block_delta', {
            type: 'content_block_delta',
            index: textBlock.index,
            delta: { type: 'text_delta', text: event.text },
          });
          break;
        }
        case 'tool-call-start': {
          const index = nextIndex++;
          toolBlocks.set(event.id, { index });
          yield emit('content_block_start', {
            type: 'content_block_start',
            index,
            content_block: { type: 'tool_use', id: event.id, name: event.name, input: {} },
          });
          break;
        }
        case 'tool-call-args-delta': {
          const block = toolBlocks.get(event.id);
          if (block) {
            yield emit('content_block_delta', {
              type: 'content_block_delta',
              index: block.index,
              delta: { type: 'input_json_delta', partial_json: event.argsDelta },
            });
          }
          break;
        }
        case 'tool-call-end': {
          const block = toolBlocks.get(event.id);
          if (block) yield emit('content_block_stop', { type: 'content_block_stop', index: block.index });
          break;
        }
        case 'finish': {
          finishReason = toAnthropicStopReason(event.finishReason);
          outputTokens = event.usage?.outputTokens ?? 0;
          break;
        }
      }
    }
  } finally {
    // Nothing to release — the server layer owns the upstream abort signal.
  }

  if (textBlock) yield emit('content_block_stop', { type: 'content_block_stop', index: textBlock.index });
  yield emit('message_delta', {
    type: 'message_delta',
    delta: { stop_reason: finishReason, stop_sequence: null },
    usage: { output_tokens: outputTokens },
  });
  yield emit('message_stop', { type: 'message_stop' });
}

// ---------------------------------------------------------------------------
// Errors, token estimation
// ---------------------------------------------------------------------------

/** Map a ModelHitchError (or any error) into an Anthropic error body. */
export function toAnthropicError(err: unknown): { status: number; body: Record<string, unknown> } {
  const isMh = err instanceof ModelHitchError;
  const message = err instanceof Error ? err.message : String(err);
  const status = isMh && err.status ? err.status : 500;
  let type = 'api_error';
  switch (isMh ? err.code : undefined) {
    case 'bad-request':
      type = 'invalid_request_error';
      break;
    case 'missing-api-key':
    case 'invalid-api-key':
      type = 'authentication_error';
      break;
    case 'rate-limited':
      type = 'rate_limit_error';
      break;
    case 'model-not-found':
      type = 'not_found_error';
      break;
  }
  return { status, body: { type: 'error', error: { type, message } } };
}

/**
 * Rough input-token estimate (chars/4) for the request body — used for the
 * Anthropic `usage`/count_tokens payloads when the provider reports none.
 */
export function estimateAnthropicInputTokens(body: unknown): number {
  let chars = 0;
  const walk = (v: unknown): void => {
    if (v == null) return;
    if (typeof v === 'string') {
      chars += v.length;
      return;
    }
    if (typeof v === 'number' || typeof v === 'boolean') {
      chars += String(v).length;
      return;
    }
    if (Array.isArray(v)) {
      for (const x of v) walk(x);
      return;
    }
    if (typeof v === 'object') {
      for (const key of Object.keys(v as Record<string, unknown>)) {
        chars += key.length + 2;
        walk((v as Record<string, unknown>)[key]);
      }
    }
  };
  walk(body);
  return Math.max(1, Math.ceil(chars / 4));
}

/** Re-exported for the server layer's typing convenience. */
export type { Usage };
