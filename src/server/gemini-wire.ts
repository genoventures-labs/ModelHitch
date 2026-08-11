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
} from '../core/types.js';

/**
 * Google Generative Language API wire protocol — what Gemini CLI (and every
 * Google-native SDK client: AI Studio, `@google/genai`, Vertex passthrough)
 * speaks when pointed at a custom `GOOGLE_GEMINI_BASE_URL`.
 *
 * The bridge maps between the two wire protocols:
 *
 *   Gemini CLI (Google native)      -> normalized ChatParams -> family router
 *     POST /v1beta/models/{model}:generateContent
 *     POST /v1beta/models/{model}:streamGenerateContent?alt=sse
 *
 * Gemini CLI sends model ids in the URL *path* (not the body), so
 * `gemini-3.5-flash-lite`, `provider/model`, or any other id reaches the
 * bridge as-is and routes by family. The bridge must tolerate Google's
 * extra request fields (`safetySettings`, `cachedContent`, ...) — they are
 * dropped, never 400'd; functionCall `args` is a JSON *object* (not a string
 * like OpenAI); tool results come back as `functionResponse` parts; and
 * streaming uses `:streamGenerateContent?alt=sse` with one partial
 * GenerateContentResponse JSON per `data:` line (no `[DONE]` sentinel).
 */

export interface GeminiRequest {
  model?: string;
  /** Conversation: user/model turns; tool results are `functionResponse` parts. */
  contents?: Array<{ role?: string; parts?: GeminiPart[] }>;
  systemInstruction?: { parts?: Array<{ text?: string }> } | string;
  tools?: Array<{ functionDeclarations?: Array<{ name?: string; description?: string; parameters?: Record<string, unknown> }> }>;
  toolConfig?: { functionCallingConfig?: { mode?: string; allowedFunctionNames?: string[] } };
  generationConfig?: {
    temperature?: number;
    maxOutputTokens?: number;
    stopSequences?: string[];
    candidateCount?: number;
    responseMimeType?: string;
    responseSchema?: unknown;
  };
  // Fields Gemini CLI / SDK clients send that the bridge deliberately drops:
  safetySettings?: unknown;
  cachedContent?: unknown;
  userAgent?: unknown;
  generationConfigExtras?: unknown;
}

interface GeminiPart {
  text?: string;
  inlineData?: { mimeType?: string; data?: string };
  fileData?: { fileUri?: string };
  functionCall?: { id?: string; name?: string; args?: unknown };
  /** Sibling of `functionCall` (NOT nested inside it) — must be echoed on turn-2. */
  thoughtSignature?: string;
  functionResponse?: { name?: string; response?: unknown };
  thought?: boolean;
}

// ---------------------------------------------------------------------------
// Inbound: Google GenerateContent request -> normalized ChatParams
// ---------------------------------------------------------------------------

/**
 * Convert a Google `contents` array into normalized messages. `role: "model"`
 * turns become assistant messages (functionCall parts become tool calls, args
 * already a JSON object); `functionResponse` parts become `tool` messages —
 * matched to the previous functionCall's id so OpenAI-style providers see a
 * consistent `tool_call_id`. Text/inlineData/fileData map to content parts;
 * `thought` parts carry no instruction for the routed model — drop.
 */
export function geminiContentsToMessages(
  contents: GeminiRequest['contents'],
  systemInstruction?: GeminiRequest['systemInstruction'],
): ModelMessage[] {
  const out: ModelMessage[] = [];
  // Remember function name -> most recent call id, so a functionResponse part
  // (keyed by *name*) can be matched to the assistant's functionCall id.
  const idByFunctionName = new Map<string, string>();

  for (const raw of contents ?? []) {
    const msg = raw as { role?: string; parts?: GeminiPart[] };
    const isModel = msg.role === 'model';

    const textParts: string[] = [];
    const contentParts: ContentPart[] = [];
    const toolCalls: ToolCall[] = [];
    const toolResults: Array<{ id: string; content: string }> = [];

    for (const part of msg.parts ?? []) {
      if (part.thought) continue;
      if (part.text) textParts.push(part.text);
      if (part.inlineData?.data) {
        contentParts.push({ type: 'image-data', mimeType: part.inlineData.mimeType ?? 'image/png', data: part.inlineData.data });
      }
      if (part.fileData?.fileUri) {
        contentParts.push({ type: 'image', imageUrl: part.fileData.fileUri });
      }
      const fc = part.functionCall;
      if (fc?.name) {
        const id = fc.id ?? `call_${out.length}`;
        idByFunctionName.set(fc.name, id);
        toolCalls.push({
          id,
          name: fc.name,
          arguments: (fc.args as Record<string, unknown>) ?? {},
          ...(part.thoughtSignature ? { thoughtSignature: part.thoughtSignature } : {}),
        });
      }
      const fr = part.functionResponse;
      if (fr?.name) {
        const id = idByFunctionName.get(fr.name) ?? fr.name;
        toolResults.push({
          id,
          content: typeof fr.response === 'string' ? fr.response : JSON.stringify(fr.response ?? ''),
        });
      }
    }

    const content: string | ContentPart[] =
      contentParts.length > 0
        ? [
            ...contentParts,
            ...(textParts.length ? [{ type: 'text', text: textParts.join('\n') } as ContentPart] : []),
          ]
        : textParts.join('\n');

    if (isModel) {
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

  // Google keeps the system prompt in `systemInstruction` — unshift it so the
  // routed provider receives it as a system message.
  const systemText =
    typeof systemInstruction === 'string'
      ? systemInstruction
      : (systemInstruction?.parts ?? []).map((p) => p.text ?? '').join('\n\n');
  if (systemText) out.unshift({ role: 'system', content: systemText });
  return out;
}

function mapGeminiToolChoice(config: GeminiRequest['toolConfig']): ToolChoice | undefined {
  const mode = config?.functionCallingConfig?.mode;
  if (!mode) return undefined;
  switch (mode) {
    case 'AUTO':
      return 'auto';
    case 'NONE':
      return 'none';
    case 'ANY': {
      const allowed = config.functionCallingConfig?.allowedFunctionNames;
      if (allowed?.length === 1 && allowed[0]) return { type: 'function', name: allowed[0] };
      return 'required';
    }
    default:
      return undefined;
  }
}

/** Convert a Google GenerateContent request into normalized ChatParams. */
export function mapGeminiRequest(body: GeminiRequest, model: string): ChatParams {
  const messages = geminiContentsToMessages(body.contents, body.systemInstruction);
  const params: ChatParams = { model, messages };

  if (Array.isArray(body.tools)) {
    const tools: ToolDefinition[] = [];
    for (const t of body.tools) {
      for (const fd of t.functionDeclarations ?? []) {
        if (fd.name) tools.push({ name: fd.name, description: fd.description, parameters: fd.parameters ?? {} });
      }
    }
    if (tools.length) params.tools = tools;
  }
  const toolChoice = mapGeminiToolChoice(body.toolConfig);
  if (toolChoice) params.toolChoice = toolChoice;

  const g = body.generationConfig;
  if (g?.temperature !== undefined) params.temperature = g.temperature;
  if (g?.maxOutputTokens !== undefined) params.maxTokens = g.maxOutputTokens;
  if (Array.isArray(g?.stopSequences) && g.stopSequences.length) params.stop = g.stopSequences;
  // safetySettings / cachedContent / userAgent are intentionally not mapped —
  // the routed provider applies its own moderation and caching.
  return params;
}

// ---------------------------------------------------------------------------
// Outbound: normalized result -> Google GenerateContent body / SSE chunks
// ---------------------------------------------------------------------------

/** Normalized finish reason -> Gemini finishReason. */
function toGeminiFinishReason(reason: string): string {
  switch (reason) {
    case 'tool-calls':
      return 'TOOL_CALLS';
    case 'length':
      return 'MAX_TOKENS';
    case 'content-filter':
      return 'SAFETY';
    default:
      return 'STOP';
  }
}

/** Convert a normalized ChatResult into a non-streamed GenerateContent response. */
export function toGeminiCompletion(
  result: ChatResult,
  model: string,
  inputTokens = 0,
): Record<string, unknown> {
  const parts: Array<Record<string, unknown>> = [];
  const text = serializeText(result.message.content);
  if (text) parts.push({ text });
  if (result.message.role === 'assistant') {
    for (const tc of result.message.toolCalls ?? []) {
      parts.push({
        ...(tc.thoughtSignature ? { thoughtSignature: tc.thoughtSignature } : {}),
        functionCall: { id: tc.id, name: tc.name, args: tc.arguments },
      });
    }
  }
  const input = result.usage?.inputTokens ?? inputTokens;
  const output = result.usage?.outputTokens ?? 0;
  return {
    candidates: [
      {
        content: { role: 'model', parts },
        finishReason: toGeminiFinishReason(result.finishReason),
        index: 0,
      },
    ],
    usageMetadata: {
      promptTokenCount: input,
      candidatesTokenCount: output,
      totalTokenCount: result.usage?.totalTokens ?? input + output,
    },
    modelVersion: model,
  };
}

/**
 * Convert a normalized provider event stream into Google `:streamGenerateContent`
 * SSE lines — one partial GenerateContentResponse JSON per `data:` line (no
 * `[DONE]` sentinel, unlike OpenAI). Text arrives as `parts[].text`; tool calls
 * open with `functionCall: { id, name }` (no args) and continue with partial
 * JSON-string `args` deltas that concatenate into the full object, mirroring
 * the real API. The final chunk carries the resolved `finishReason` and
 * `usageMetadata`.
 */
export async function* toGeminiStreamEvents(
  events: AsyncIterable<StreamChunk>,
  model: string,
  inputTokens = 0,
): AsyncGenerator<string> {
  const emit = (data: unknown) => `data: ${JSON.stringify(data)}\n\n`;
  let finishReason = 'STOP';
  let usage: { inputTokens?: number; outputTokens?: number; totalTokens?: number } | undefined;

  for await (const event of events) {
    switch (event.type) {
      case 'text-delta':
        yield emit({
          candidates: [{ content: { role: 'model', parts: [{ text: event.text }] }, index: 0 }],
        });
        break;
      case 'tool-call-start': {
        yield emit({
          candidates: [
            {
              content: {
                role: 'model',
                parts: [
                  {
                    ...(event.thoughtSignature ? { thoughtSignature: event.thoughtSignature } : {}),
                    // No args on the opening chunk — partial args deltas that
                    // follow must concatenate into the full JSON object.
                    functionCall: { id: event.id, name: event.name },
                  },
                ],
              },
              index: 0,
            },
          ],
        });
        break;
      }
      case 'tool-call-args-delta': {
        // Continuation chunks carry only the partial args string, like the API.
        yield emit({
          candidates: [
            { content: { role: 'model', parts: [{ functionCall: { args: event.argsDelta } }] }, index: 0 },
          ],
        });
        break;
      }
      case 'tool-call-end':
        // Nothing to emit — the SDK accumulates partial args itself.
        break;
      case 'finish': {
        finishReason = toGeminiFinishReason(event.finishReason);
        usage = event.usage;
        break;
      }
    }
  }

  const input = usage?.inputTokens ?? inputTokens;
  const output = usage?.outputTokens ?? 0;
  const chunk: Record<string, unknown> = {
    candidates: [{ content: {}, finishReason, index: 0 }],
    usageMetadata: {
      promptTokenCount: input,
      candidatesTokenCount: output,
      totalTokenCount: usage?.totalTokens ?? input + output,
    },
    modelVersion: model,
  };
  yield emit(chunk);
}

// ---------------------------------------------------------------------------
// Errors, token estimation
// ---------------------------------------------------------------------------

/** Map a ModelHitchError (or any error) into a Google API error body. */
export function toGeminiError(err: unknown): { status: number; body: Record<string, unknown> } {
  const isMh = err instanceof ModelHitchError;
  const message = err instanceof Error ? err.message : String(err);
  const status = isMh && err.status ? err.status : 500;
  let gstatus = 'INTERNAL';
  switch (isMh ? err.code : undefined) {
    case 'bad-request':
      gstatus = 'INVALID_ARGUMENT';
      break;
    case 'missing-api-key':
      gstatus = 'UNAUTHENTICATED';
      break;
    case 'invalid-api-key':
      gstatus = 'PERMISSION_DENIED';
      break;
    case 'rate-limited':
      gstatus = 'RESOURCE_EXHAUSTED';
      break;
    case 'model-not-found':
      gstatus = 'NOT_FOUND';
      break;
  }
  return { status, body: { error: { code: status, message, status: gstatus } } };
}

/**
 * Rough input-token estimate (chars/4) for the request body — used for the
 * `usageMetadata.promptTokenCount` when the provider reports none.
 */
export function estimateGeminiInputTokens(body: unknown): number {
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
