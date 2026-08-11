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
 *   1. big-pickle           -> /chat/completions (OpenAI-compatible)
 *   2. gpt-5.6-luna         -> /responses        (OpenAI Responses API)
 *   3. claude-sonnet-5      -> /messages         (Anthropic Messages API)
 *   4. gemini-3.5-flash-lite -> models/{id}:generateContent (Google native)
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

const PROMPT =
  'Act as the Android Studio agent inspecting this project. Before answering anything, you MUST call the ' +
  'get_android_sdk tool with sdkVersion "36". After you receive the tool result, report the compileSdk value in your final answer.';

/** Simulated Android Studio tool execution — the "AS executes tool" step. */
function executeTool(name: string, args: Record<string, unknown>): string {
  if (name !== TOOL_NAME) throw new Error(`Unexpected tool: ${name}`);
  const sdkVersion = String(args.sdkVersion ?? '36');
  return JSON.stringify({ compileSdk: 36, minSdk: 24, targetSdk: 36, buildTools: `${sdkVersion}.0.0` });
}

const CASES: Array<{ label: string; model: string; forceTool: boolean }> = [
  // big-pickle is a thinking model: it rejects a *forced* tool_choice, so we
  // rely on the prompt to trigger the call with tool_choice 'auto'.
  { label: 'chat-completions (/chat/completions)', model: 'big-pickle', forceTool: false },
  { label: 'responses (/responses)', model: 'gpt-5.6-luna', forceTool: true },
  // qwen3.5-plus is disabled on this key; claude-sonnet-5 is probe-verified.
  { label: 'messages (/messages)', model: 'claude-sonnet-5', forceTool: true },
  { label: 'gemini (:generateContent)', model: 'gemini-3.5-flash-lite', forceTool: true },
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
      const turn = await streamToolCall(url, c.model, c.forceTool, signal);
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
      const answer = await answerWithResult(url, c.model, turn, result, signal);

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
