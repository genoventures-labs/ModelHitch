/**
 * Canary — end-to-end agentic loop through the ModelHitch bridge.
 *
 * Proves the full pipeline for every OpenCode Zen protocol family:
 *
 *   AS agent loop -> bridge (/v1/chat/completions) -> family router ->
 *   native protocol -> Zen -> streamed tool call -> normalized response ->
 *   AS executes tool -> second turn with the result
 *
 * Run with a Zen key:
 *
 *   $env:OPENCODE_ZEN_API_KEY="opencode-..." ; npm run canary
 *
 * Cases (one real streamed tool call each):
 *   1. deepseek-v4-flash  -> /chat/completions (OpenAI-compatible)
 *   2. gpt-5.6-luna         -> /responses        (OpenAI Responses API)
 *   3. qwen3.6-plus       -> /messages         (Anthropic Messages API)
 *   4. gemini-3.5-flash-lite -> models/{id}:generateContent (Google native)
 *   5. gpt-5.6-luna via /v1/responses (Codex CLI wire protocol, full bridge)
 *   6. deepseek-v4-flash via /v1/messages (Claude Code gateway wire protocol)
 *   7. gemini-3.5-flash-lite via /v1beta/models/{id}:streamGenerateContent
 *      (Gemini CLI wire protocol, full bridge)
 *
 * Exits 0 only when every case completes a streamed tool call and then
 * correctly uses the tool result in its final answer.
 */
import { readFileSync } from 'node:fs';
import { OPENCODE_ZEN_MODELS, createModelHitchServer, zenProtocolForModel } from '../src/index.js';

/** Load a local .env file (if present) so the key doesn't depend on a terminal session. */
function loadDotEnv(): void {
  try {
    const text = readFileSync(new URL('../.env', import.meta.url), 'utf8');
    for (const line of text.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eq = trimmed.indexOf('=');
      if (eq <= 0) continue;
      const key = trimmed.slice(0, eq).trim();
      const value = trimmed.slice(eq + 1).trim().replace(/^["']|["']$/g, '');
      if (!process.env[key]) process.env[key] = value;
    }
  } catch {
    // No .env file — fall through to the environment.
  }
}
loadDotEnv();

const KEY = process.env.OPENCODE_ZEN_API_KEY ?? process.env.OPENCODE_API_KEY;
if (!KEY) {
  console.error('\n[canary] No Zen key found. Either set OPENCODE_ZEN_API_KEY in the environment or create a .env file:\n');
  console.error('  OPENCODE_ZEN_API_KEY=sk-...   (.env is git-ignored)\n');
  process.exit(2);
}

const TOOL_NAME = 'get_android_sdk';
const TOOL_DEF = {
  type: 'function',
  function: {
    name: TOOL_NAME,
    description:
      'Fetch the Android SDK configuration (compileSdk, minSdk, targetSdk) for the current project. Call this before suggesting Gradle or manifest changes.',
    parameters: {
      type: 'object',
      properties: {
        sdkVersion: { type: 'string', description: "The Android SDK API level to inspect, e.g. '36'." },
      },
      required: ['sdkVersion'],
    },
  },
};

/** Responses API tool shape (flat) — what Codex CLI sends to the bridge. */
const RESPONSES_TOOL_DEF = {
  type: 'function',
  name: TOOL_NAME,
  description:
    'Fetch the Android SDK configuration (compileSdk, minSdk, targetSdk) for the current project. Call this before suggesting Gradle or manifest changes.',
  parameters: {
    type: 'object',
    properties: {
      sdkVersion: { type: 'string', description: "The Android SDK API level to inspect, e.g. '36'." },
    },
    required: ['sdkVersion'],
  },
};

/** Anthropic Messages tool shape — what Claude Code sends to the gateway. */
const ANTHROPIC_TOOL_DEF = {
  name: TOOL_NAME,
  description:
    'Fetch the Android SDK configuration (compileSdk, minSdk, targetSdk) for the current project. Call this before suggesting Gradle or manifest changes.',
  input_schema: {
    type: 'object',
    properties: {
      sdkVersion: { type: 'string', description: "The Android SDK API level to inspect, e.g. '36'." },
    },
    required: ['sdkVersion'],
  },
};

/** Google `functionDeclarations` tool shape — what Gemini CLI sends to the bridge. */
const GEMINI_TOOL_DEF = {
  functionDeclarations: [
    {
      name: TOOL_NAME,
      description:
        'Fetch the Android SDK configuration (compileSdk, minSdk, targetSdk) for the current project. Call this before suggesting Gradle or manifest changes.',
      parameters: {
        type: 'object',
        properties: {
          sdkVersion: { type: 'string', description: "The Android SDK API level to inspect, e.g. '36'." },
        },
        required: ['sdkVersion'],
      },
    },
  ],
};

const PROMPT =
  'Act as the Android Studio agent inspecting this project. Before answering anything, you MUST call the ' +
  'get_android_sdk tool with sdkVersion "36". After you receive the tool result, report the compileSdk value in your final answer.';

/** Simulated Android Studio tool execution — the "AS executes tool" step. */
function executeTool(name: string, args: Record<string, unknown>): string {
  if (name !== TOOL_NAME) throw new Error(`Unexpected tool: ${name}`);
  const sdkVersion = String(args.sdkVersion ?? '36');
  return JSON.stringify({ compileSdk: 36, minSdk: 24, targetSdk: 36, buildTools: `${sdkVersion}.0.0` });
}

const CASES: Array<{ label: string; model: string; forceTool: boolean; wire?: 'responses' | 'anthropic' | 'gemini' }> = [
  // deepseek is a thinking model: it rejects a *forced* tool_choice, so we
  // rely on the prompt to trigger the call with tool_choice 'auto'.
  // (big-pickle is currently upstream-rate-limited on this key.)
  { label: 'chat-completions (/chat/completions)', model: 'deepseek-v4-flash', forceTool: false },
  { label: 'responses (/responses)', model: 'gpt-5.6-luna', forceTool: true },
  // qwen3.6-plus is probe-verified on this key (all claude-* are currently
  // disabled at the gateway); like big-pickle it rejects a *forced* tool_choice.
  { label: 'messages (/messages)', model: 'qwen3.6-plus', forceTool: false },
  { label: 'gemini (:generateContent)', model: 'gemini-3.5-flash-lite', forceTool: true },
  // Codex CLI speaks ONLY the Responses wire API to custom providers — this
  // proves the full path: /v1/responses -> bridge -> family router -> Zen.
  { label: 'responses-wire (/v1/responses)', model: 'gpt-5.6-luna', forceTool: true, wire: 'responses' },
  // Claude Code speaks the Anthropic Messages wire to any LLM gateway
  // (ANTHROPIC_BASE_URL) — proves /v1/messages -> bridge -> family router -> Zen.
  { label: 'anthropic-wire (/v1/messages)', model: 'deepseek-v4-flash', forceTool: false, wire: 'anthropic' },
  // Gemini CLI speaks the Google Generative Language wire to any custom
  // GOOGLE_GEMINI_BASE_URL — proves /v1beta/models/{id}:streamGenerateContent
  // -> bridge -> family router -> Zen (same family: gemini native outbound).
  { label: 'gemini-wire (:streamGenerateContent)', model: 'gemini-3.5-flash-lite', forceTool: true, wire: 'gemini' },
];

async function* ssePayloads(res: Response): AsyncGenerator<string> {
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let idx: number;
    while ((idx = buf.indexOf('\n\n')) >= 0) {
      const raw = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      for (const line of raw.split('\n')) {
        if (line.startsWith('data:')) {
          const payload = line.slice(5).trim();
          if (payload && payload !== '[DONE]') yield payload;
        }
      }
    }
  }
}

interface AccToolCall {
  id: string;
  name: string;
  args: string;
  /** Gemini requires the previous turn's thoughtSignature on the echoed call. */
  thoughtSignature?: string;
}

interface TurnOne {
  content: string;
  toolCalls: AccToolCall[];
  finishReason: string | null;
}

/** Turn 1: streamed chat completion; the model must emit a tool call. */
async function streamToolCall(
  base: string,
  model: string,
  forceTool: boolean,
  signal: AbortSignal,
): Promise<TurnOne> {
  const res = await fetch(`${base}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    signal,
    body: JSON.stringify({
      model,
      stream: true,
      messages: [{ role: 'user', content: PROMPT }],
      tools: [TOOL_DEF],
      // Reasoning models reject a *forced* tool_choice (and temperature), so
      // big-pickle relies on the prompt with tool_choice 'auto'.
      tool_choice: forceTool
        ? { type: 'function', function: { name: TOOL_NAME } }
        : 'auto',
    }),
  });
  if (!res.ok) {
    throw new Error(`HTTP ${res.status}: ${await res.text()}`);
  }
  const out: TurnOne = { content: '', toolCalls: [], finishReason: null };
  const byIndex = new Map<number, AccToolCall>();
  for await (const payload of ssePayloads(res)) {
    const chunk = JSON.parse(payload);
    if (chunk.error) throw new Error(`upstream error: ${chunk.error.message ?? JSON.stringify(chunk.error)}`);
    const choice = chunk.choices?.[0];
    if (!choice) continue;
    const delta = choice.delta ?? {};
    if (delta.content) out.content += delta.content;
    for (const tc of delta.tool_calls ?? []) {
      let acc = byIndex.get(tc.index);
      if (!acc) {
        acc = { id: tc.id ?? `call_${tc.index}`, name: tc.function?.name ?? '', args: '' };
        byIndex.set(tc.index, acc);
        out.toolCalls.push(acc);
      }
      if (tc.id) acc.id = tc.id;
      if (tc.function?.name) acc.name = tc.function.name;
      if (tc.function?.arguments) acc.args += tc.function.arguments;
      if (tc.thoughtSignature) acc.thoughtSignature = tc.thoughtSignature;
    }
    if (choice.finish_reason) out.finishReason = choice.finish_reason;
  }
  return out;
}

/** Turn 2: non-streamed; the model must answer using the tool result. */
async function answerWithResult(base: string, model: string, turn: TurnOne, result: string, signal: AbortSignal): Promise<string> {
  const toolCalls = turn.toolCalls.map((tc) => ({
    id: tc.id,
    type: 'function',
    function: { name: tc.name, arguments: tc.args || '{}' },
    ...(tc.thoughtSignature ? { thoughtSignature: tc.thoughtSignature } : {}),
  }));
  const res = await fetch(`${base}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    signal,
    body: JSON.stringify({
      model,
      stream: false,
      messages: [
        { role: 'user', content: PROMPT },
        { role: 'assistant', content: turn.content || null, tool_calls: toolCalls },
        { role: 'tool', tool_call_id: toolCalls[0]!.id, content: result },
      ],
      tools: [TOOL_DEF],
      tool_choice: 'none',
    }),
  });
  if (!res.ok) {
    throw new Error(`HTTP ${res.status}: ${await res.text()}`);
  }
  const data = await res.json();
  return data.choices?.[0]?.message?.content ?? '';
}

/** Turn 1 via the Codex wire: streamed POST /v1/responses (Responses SSE). */
async function streamResponsesToolCall(
  base: string,
  model: string,
  forceTool: boolean,
  signal: AbortSignal,
): Promise<TurnOne> {
  const res = await fetch(`${base}/v1/responses`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    signal,
    body: JSON.stringify({
      model,
      stream: true,
      input: [{ role: 'user', content: [{ type: 'input_text', text: PROMPT }] }],
      tools: [RESPONSES_TOOL_DEF],
      tool_choice: forceTool ? { type: 'function', name: TOOL_NAME } : 'auto',
    }),
  });
  if (!res.ok) {
    throw new Error(`HTTP ${res.status}: ${await res.text()}`);
  }
  const out: TurnOne = { content: '', toolCalls: [], finishReason: null };
  const byItem = new Map<string, AccToolCall>();
  for await (const payload of ssePayloads(res)) {
    const ev = JSON.parse(payload);
    if (ev.type === 'response.failed') {
      throw new Error(`upstream error: ${ev.response?.error?.message ?? JSON.stringify(ev)}`);
    }
    if (ev.type === 'response.output_item.added' && ev.item?.type === 'function_call') {
      const acc: AccToolCall = {
        id: ev.item.call_id ?? ev.item.id ?? `call_${out.toolCalls.length}`,
        name: ev.item.name ?? '',
        args: '',
        ...(ev.item.thoughtSignature ? { thoughtSignature: ev.item.thoughtSignature } : {}),
      };
      byItem.set(ev.item.id, acc);
      out.toolCalls.push(acc);
    }
    if (ev.type === 'response.function_call_arguments.delta') {
      const acc = byItem.get(ev.item_id);
      if (acc) acc.args += ev.delta ?? '';
    }
    if (ev.type === 'response.output_text.delta') out.content += ev.delta ?? '';
    if (ev.type === 'response.completed') out.finishReason = 'completed';
  }
  return out;
}

/** Turn 2 via the Codex wire: non-stream /v1/responses with tool result items. */
async function answerWithResponsesResult(
  base: string,
  model: string,
  turn: TurnOne,
  result: string,
  signal: AbortSignal,
): Promise<string> {
  const first = turn.toolCalls[0]!;
  const res = await fetch(`${base}/v1/responses`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    signal,
    body: JSON.stringify({
      model,
      stream: false,
      input: [
        { role: 'user', content: [{ type: 'input_text', text: PROMPT }] },
        {
          type: 'function_call',
          call_id: first.id,
          name: first.name,
          arguments: first.args || '{}',
          ...(first.thoughtSignature ? { thoughtSignature: first.thoughtSignature } : {}),
        },
        { type: 'function_call_output', call_id: first.id, output: result },
      ],
      tools: [RESPONSES_TOOL_DEF],
      tool_choice: 'none',
    }),
  });
  if (!res.ok) {
    throw new Error(`HTTP ${res.status}: ${await res.text()}`);
  }
  const data = await res.json();
  const text = (data.output ?? [])
    .filter((o: { type?: string }) => o.type === 'message')
    .flatMap((o: { content?: Array<{ text?: string }> }) => o.content ?? [])
    .map((p: { text?: string }) => p.text ?? '')
    .join('');
  return text;
}

/** Turn 1 via the Claude Code wire: streamed POST /v1/messages (Anthropic SSE). */
async function streamAnthropicToolCall(
  base: string,
  model: string,
  forceTool: boolean,
  signal: AbortSignal,
): Promise<TurnOne> {
  const res = await fetch(`${base}/v1/messages`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'anthropic-version': '2023-06-01',
      Authorization: 'Bearer test-gateway-token',
    },
    signal,
    body: JSON.stringify({
      model,
      max_tokens: 4096,
      stream: true,
      system: 'You are the Android Studio agent.',
      messages: [{ role: 'user', content: PROMPT }],
      tools: [ANTHROPIC_TOOL_DEF],
      tool_choice: forceTool ? { type: 'tool', name: TOOL_NAME } : { type: 'auto' },
    }),
  });
  if (!res.ok) {
    throw new Error(`HTTP ${res.status}: ${await res.text()}`);
  }
  const out: TurnOne = { content: '', toolCalls: [], finishReason: null };
  const byIndex = new Map<number, AccToolCall>();
  for await (const payload of ssePayloads(res)) {
    const ev = JSON.parse(payload);
    if (ev.type === 'error') throw new Error(`upstream error: ${ev.error?.message ?? JSON.stringify(ev)}`);
    if (ev.type === 'content_block_start' && ev.content_block?.type === 'tool_use') {
      const acc: AccToolCall = { id: ev.content_block.id, name: ev.content_block.name, args: '' };
      byIndex.set(ev.index, acc);
      out.toolCalls.push(acc);
    }
    if (ev.type === 'content_block_delta' && ev.delta?.type === 'text_delta') {
      out.content += ev.delta.text ?? '';
    }
    if (ev.type === 'content_block_delta' && ev.delta?.type === 'input_json_delta') {
      const acc = byIndex.get(ev.index);
      if (acc) acc.args += ev.delta.partial_json ?? '';
    }
    if (ev.type === 'message_delta') out.finishReason = ev.delta?.stop_reason ?? null;
  }
  return out;
}

/** Turn 2 via the Claude Code wire: non-stream /v1/messages with tool_result. */
async function answerWithAnthropicResult(
  base: string,
  model: string,
  turn: TurnOne,
  result: string,
  signal: AbortSignal,
): Promise<string> {
  const first = turn.toolCalls[0]!;
  const res = await fetch(`${base}/v1/messages`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'anthropic-version': '2023-06-01',
      Authorization: 'Bearer test-gateway-token',
    },
    signal,
    body: JSON.stringify({
      model,
      max_tokens: 4096,
      stream: false,
      system: 'You are the Android Studio agent.',
      messages: [
        { role: 'user', content: PROMPT },
        {
          role: 'assistant',
          content: [
            ...(turn.content ? [{ type: 'text', text: turn.content }] : []),
            { type: 'tool_use', id: first.id, name: first.name, input: JSON.parse(first.args || '{}') },
          ],
        },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: first.id, content: result }] },
      ],
      tools: [ANTHROPIC_TOOL_DEF],
      tool_choice: { type: 'none' },
    }),
  });
  if (!res.ok) {
    throw new Error(`HTTP ${res.status}: ${await res.text()}`);
  }
  const data = await res.json();
  return (data.content ?? [])
    .filter((b: { type?: string }) => b.type === 'text')
    .map((b: { text?: string }) => b.text ?? '')
    .join('');
}

/**
 * Turn 1 via the Gemini CLI wire: streamed POST
 * /v1beta/models/{model}:streamGenerateContent?alt=sse (Google SSE: one
 * partial GenerateContentResponse JSON per `data:` line, no [DONE]).
 */
async function streamGeminiToolCall(
  base: string,
  model: string,
  forceTool: boolean,
  signal: AbortSignal,
): Promise<TurnOne> {
  const res = await fetch(`${base}/v1beta/models/${model}:streamGenerateContent?alt=sse`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': 'test-key' },
    signal,
    body: JSON.stringify({
      contents: [{ role: 'user', parts: [{ text: PROMPT }] }],
      tools: [GEMINI_TOOL_DEF],
      toolConfig: forceTool
        ? { functionCallingConfig: { mode: 'ANY', allowedFunctionNames: [TOOL_NAME] } }
        : undefined,
      // Gemini CLI sends Google extras; the bridge must tolerate them.
      safetySettings: [{ category: 'HARM_CATEGORY_HARASSMENT', threshold: 'BLOCK_NONE' }],
    }),
  });
  if (!res.ok) {
    throw new Error(`HTTP ${res.status}: ${await res.text()}`);
  }
  const out: TurnOne = { content: '', toolCalls: [], finishReason: null };
  for await (const payload of ssePayloads(res)) {
    const chunk = JSON.parse(payload);
    if (chunk.error) throw new Error(`upstream error: ${chunk.error?.message ?? JSON.stringify(chunk.error)}`);
    const candidate = chunk.candidates?.[0];
    for (const part of candidate?.content?.parts ?? []) {
      if (part.text) out.content += part.text;
      const fc = part.functionCall;
      if (!fc) continue;
      const last = out.toolCalls[out.toolCalls.length - 1];
      // Opening chunk carries id + name (+ object args, like the real API);
      // continuation chunks carry only partial JSON-string args and belong to
      // the in-flight call (Gemini has no per-chunk index on functionCall).
      if (fc.id || fc.name) {
        // Opening chunk: args may be absent (partials follow), a complete
        // object, or already a JSON string — never seed with a bare "{}".
        const acc: AccToolCall = {
          id: fc.id ?? `call_${out.toolCalls.length}`,
          name: fc.name ?? '',
          args:
            fc.args == null
              ? ''
              : typeof fc.args === 'string'
                ? fc.args
                : JSON.stringify(fc.args),
        };
        out.toolCalls.push(acc);
      } else if (last && typeof fc.args === 'string') {
        last.args += fc.args;
      }
      if (part.thoughtSignature && last) last.thoughtSignature = part.thoughtSignature;
    }
    if (candidate?.finishReason) out.finishReason = candidate.finishReason;
  }
  return out;
}

/**
 * Turn 2 via the Gemini CLI wire: non-stream POST
 * /v1beta/models/{model}:generateContent with the functionResponse part. The
 * model turn must echo the functionCall (with thoughtSignature, if any) and
 * the user turn carries the tool result; NONE mode forces a plain answer.
 */
async function answerWithGeminiResult(
  base: string,
  model: string,
  turn: TurnOne,
  result: string,
  signal: AbortSignal,
): Promise<string> {
  const first = turn.toolCalls[0]!;
  const res = await fetch(`${base}/v1beta/models/${model}:generateContent`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': 'test-key' },
    signal,
    body: JSON.stringify({
      contents: [
        { role: 'user', parts: [{ text: PROMPT }] },
        {
          role: 'model',
          parts: [
            ...(turn.content ? [{ text: turn.content }] : []),
            {
              ...(first.thoughtSignature ? { thoughtSignature: first.thoughtSignature } : {}),
              functionCall: { name: first.name, args: JSON.parse(first.args || '{}') },
            },
          ],
        },
        { role: 'user', parts: [{ functionResponse: { name: first.name, response: JSON.parse(result) } }] },
      ],
      tools: [GEMINI_TOOL_DEF],
      toolConfig: { functionCallingConfig: { mode: 'NONE' } },
    }),
  });
  if (!res.ok) {
    throw new Error(`HTTP ${res.status}: ${await res.text()}`);
  }
  const data = await res.json();
  return (data.candidates?.[0]?.content?.parts ?? [])
    .map((p: { text?: string }) => p.text ?? '')
    .join('');
}

async function main() {
  const server = createModelHitchServer({
    providers: undefined, // built-in set includes opencodeZen
    defaultProviderId: 'opencode-zen',
    defaultModel: 'big-pickle',
    staticModels: { 'opencode-zen': [...OPENCODE_ZEN_MODELS] },
  });
  const { url } = await server.listen(0, '127.0.0.1');

  console.log(`\n[canary] ModelHitch bridge at ${url} — key present, running ${CASES.length} protocol cases\n`);

  const results: string[] = [];
  for (const c of CASES) {
    const tag = `[${c.label}] ${c.model}`;
    // One controller per case, timer cleared when the case finishes so nothing
    // lingers and trips libuv on process exit.
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 120_000);
    const signal = controller.signal;
    try {
      const turn =
        c.wire === 'responses'
          ? await streamResponsesToolCall(url, c.model, c.forceTool, signal)
          : c.wire === 'anthropic'
            ? await streamAnthropicToolCall(url, c.model, c.forceTool, signal)
            : c.wire === 'gemini'
              ? await streamGeminiToolCall(url, c.model, c.forceTool, signal)
              : await streamToolCall(url, c.model, c.forceTool, signal);
      if (!turn.toolCalls.length) {
        throw new Error(`no tool call streamed (finish_reason=${turn.finishReason ?? 'none'}; text="${turn.content.slice(0, 80)}")`);
      }
      if (turn.toolCalls.some((tc) => tc.name !== TOOL_NAME)) {
        throw new Error(`unexpected tool name: ${turn.toolCalls.map((tc) => tc.name).join(', ')}`);
      }
      const first = turn.toolCalls[0]!;
      // "AS executes tool"
      const result = executeTool(first.name, JSON.parse(first.args || '{}'));
      // Turn 2: "AS sends result back, model answers"
      const answer =
        c.wire === 'responses'
          ? await answerWithResponsesResult(url, c.model, turn, result, signal)
          : c.wire === 'anthropic'
            ? await answerWithAnthropicResult(url, c.model, turn, result, signal)
            : c.wire === 'gemini'
              ? await answerWithGeminiResult(url, c.model, turn, result, signal)
              : await answerWithResult(url, c.model, turn, result, signal);

      const routed = zenProtocolForModel(c.model);
      const ok =
        answer.length > 0 &&
        (answer.includes('compileSdk') || answer.includes('36'));
      const line = ok
        ? `  PASS ${tag} -> tool call "${first.name}" args=${first.args} routed=${routed} answer="${answer.slice(0, 90).replace(/\s+/g, ' ')}..."`
        : `  FAIL ${tag} -> tool call ok but answer missing tool result: "${answer.slice(0, 120)}"`;
      console.log(line);
      results.push(ok ? 'PASS' : 'FAIL');
    } catch (err) {
      console.log(`  FAIL ${tag} -> ${(err as Error).message}`);
      results.push('FAIL');
    } finally {
      clearTimeout(timer);
    }
  }

  await server.close?.();
  const passed = results.filter((r) => r === 'PASS').length;
  console.log(`\n[canary] ${passed}/${results.length} cases passed\n`);
  process.exit(passed === results.length ? 0 : 1);
}

main().catch((err) => {
  console.error('[canary] fatal:', err);
  process.exit(1);
});
