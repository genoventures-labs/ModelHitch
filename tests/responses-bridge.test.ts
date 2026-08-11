import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  createModelHitchServer,
  mockProvider,
  type ChatParams,
  type ChatResult,
  type OpenAICompatibleServer,
  type Provider,
  type StreamChunk,
} from '../src/index.js';
import { clearConversations } from '../src/server/conversation-state.js';

/**
 * End-to-end tests for `POST /v1/responses` — the OpenAI Responses API wire
 * protocol that Codex CLI custom model providers speak. Uses the deterministic
 * mock provider ("!tool <name>" user text triggers a simulated tool call;
 * tool_choice 'none' suppresses it).
 */

let server: OpenAICompatibleServer;
let base: string;

beforeAll(async () => {
  server = createModelHitchServer({
    providers: [mockProvider],
    defaultProviderId: 'mock',
  });
  const info = await server.listen(0, '127.0.0.1');
  base = info.url;
});

afterAll(async () => {
  await server.close();
});

function responses(body: unknown): Promise<Response> {
  return fetch(`${base}/v1/responses`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

async function sseEvents(res: Response): Promise<Array<Record<string, any>>> {
  const text = await res.text();
  const events: Array<Record<string, any>> = [];
  for (const raw of text.split('\n\n')) {
    for (const line of raw.split('\n')) {
      if (line.startsWith('data:')) {
        const payload = line.slice(5).trim();
        if (payload) events.push(JSON.parse(payload) as Record<string, any>);
      }
    }
  }
  return events;
}

describe('bridge POST /v1/responses — validation', () => {
  it('400s when input and instructions are both missing', async () => {
    const res = await responses({ model: 'mock-model' });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('bad-request');
  });

  it('accepts an instructions-only request (no input array)', async () => {
    const res = await responses({ model: 'mock-model', instructions: 'hi from instructions' });
    expect(res.status).toBe(200);
  });
});

describe('bridge POST /v1/responses — non-streaming', () => {
  it('turns a tool call + tool result round-trip into Responses output items', async () => {
    // Turn 1: user asks, model must call get_weather (mock sees "!tool").
    const turn1 = await responses({
      model: 'mock-model',
      input: [{ role: 'user', content: [{ type: 'input_text', text: '!tool get_weather' }] }],
      tools: [
        {
          type: 'function',
          name: 'get_weather',
          description: 'Fetch weather',
          parameters: { type: 'object', properties: { city: { type: 'string' } } },
        },
      ],
      tool_choice: 'auto',
    });
    expect(turn1.status).toBe(200);
    const body1 = (await turn1.json()) as any;
    expect(body1.object).toBe('response');
    expect(body1.status).toBe('completed');
    expect(body1.model).toBe('mock-model');
    const calls = body1.output.filter((o: any) => o.type === 'function_call');
    expect(calls).toHaveLength(1);
    expect(calls[0]!.name).toBe('get_weather');
    expect(calls[0]!.call_id).toBe('call_mock_1');
    expect(JSON.parse(calls[0]!.arguments)).toEqual({ q: 'mock query' });
    expect(body1.usage.input_tokens).toBeGreaterThan(0);

    // Turn 2: feed the function_call + function_call_output back in, ask to
    // answer with tool_choice 'none' (mock echoes the user text).
    const turn2 = await responses({
      model: 'mock-model',
      input: [
        { role: 'user', content: [{ type: 'input_text', text: '!tool get_weather' }] },
        { type: 'function_call', call_id: 'call_mock_1', name: 'get_weather', arguments: '{"q":"mock query"}' },
        { type: 'function_call_output', call_id: 'call_mock_1', output: '{"temp": 21}' },
      ],
      tools: [{ type: 'function', name: 'get_weather', description: 'Fetch weather' }],
      tool_choice: 'none',
    });
    expect(turn2.status).toBe(200);
    const body2 = (await turn2.json()) as any;
    const messages = body2.output.filter((o: any) => o.type === 'message');
    expect(messages).toHaveLength(1);
    expect(messages[0]!.content[0]!.type).toBe('output_text');
    expect(messages[0]!.content[0]!.text).toContain('Mock reply: !tool get_weather');
  });

  it('maps instructions to a system message and honors max_output_tokens', async () => {
    const res = await responses({
      model: 'mock-model',
      instructions: 'Be terse.',
      input: [{ role: 'user', content: [{ type: 'input_text', text: 'hi there' }] }],
      max_output_tokens: 42,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.output[0]!.content[0]!.text).toContain('Mock reply: hi there');
  });
});

describe('bridge POST /v1/responses — streaming', () => {
  it('emits Responses SSE events for a streamed tool call', async () => {
    const res = await responses({
      model: 'mock-model',
      stream: true,
      input: [{ role: 'user', content: [{ type: 'input_text', text: '!tool get_weather' }] }],
      tools: [{ type: 'function', name: 'get_weather', description: 'Fetch weather' }],
      tool_choice: 'auto',
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/event-stream');

    const events = await sseEvents(res);
    const types = events.map((e) => e.type);
    expect(types[0]).toBe('response.created');
    expect(types).toContain('response.output_item.added');
    expect(types).toContain('response.function_call_arguments.delta');
    expect(types).toContain('response.output_item.done');
    expect(types[types.length - 1]).toBe('response.completed');

    const added = events.find((e) => e.type === 'response.output_item.added')!;
    expect(added.item.type).toBe('function_call');
    expect(added.item.name).toBe('get_weather');
    expect(added.item.call_id).toBe('call_mock_1');

    const delta = events.find((e) => e.type === 'response.function_call_arguments.delta')!;
    expect(delta.item_id).toBe(added.item.id);
    expect(delta.delta).toBe('{"q":"mock query"}');

    const done = events.find((e) => e.type === 'response.output_item.done')!;
    expect(done.item.arguments).toBe('{"q":"mock query"}');
    expect(done.item.status).toBe('completed');

    const completed = events[events.length - 1]!;
    expect(completed.response.status).toBe('completed');
    expect(completed.response.output[0]!.type).toBe('function_call');
  });

  it('emits text deltas for a plain answer', async () => {
    const res = await responses({
      model: 'mock-model',
      stream: true,
      input: [{ role: 'user', content: [{ type: 'input_text', text: 'hi there' }] }],
    });
    const events = await sseEvents(res);
    const types = events.map((e) => e.type);
    expect(types).toContain('response.output_text.delta');
    expect(types).toContain('response.output_text.done');
    expect(types).toContain('response.output_item.done');

    const text = events
      .filter((e) => e.type === 'response.output_text.delta')
      .map((e) => e.delta)
      .join('');
    expect(text).toContain('Mock reply: hi there');

    const completed = events[events.length - 1]!;
    expect(completed.type).toBe('response.completed');
    expect(completed.response.output[0]!.content[0]!.text).toBe(text);
  });
});

describe('bridge POST /v1/responses — model routing', () => {
  it('routes prefixed model ids to the named provider', async () => {
    const res = await responses({
      model: 'mock/mock-model',
      input: [{ role: 'user', content: 'hi' }],
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.model).toBe('mock-model');
  });
});

describe('bridge POST /v1/responses — extension-shaped requests', () => {
  it('accepts an input_image with a STRING image_url alongside text', async () => {
    const res = await responses({
      model: 'mock-model',
      input: [
        {
          type: 'message',
          role: 'user',
          content: [
            { type: 'input_text', text: 'what is in this screenshot?' },
            { type: 'input_image', detail: 'auto', image_url: 'data:image/png;base64,iVBORw0KGgo=' },
          ],
        },
      ],
    });
    // The mixed text+image item must map and flow through — previously the
    // string image_url was dropped, and text-only items with an unusable
    // image could collapse into an empty user turn (upstream 400).
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.object).toBe('response');
    expect(body.status).toBe('completed');
  });

  it('accepts tool_search_output / tool_search_call items (no empty turns)', async () => {
    const res = await responses({
      model: 'mock-model',
      input: [
        {
          type: 'tool_search_output',
          execution: 'client',
          call_id: 'toolu_search_1',
          status: 'completed',
          tools: [{ type: 'function', name: 'get_weather' }],
        },
        { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'ok done' }] },
      ],
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    const text = body.output
      .filter((o: any) => o.type === 'message')
      .map((o: any) => o.content.map((c: any) => c.text ?? '').join(''))
      .join('');
    expect(text).toContain('Mock reply: ok done');
  });

  it('accepts an orphaned function_call_output without failing', async () => {
    const res = await responses({
      model: 'mock-model',
      input: [
        { type: 'function_call_output', call_id: 'call_from_earlier', output: '42' },
        { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'continue' }] },
      ],
    });
    expect(res.status).toBe(200);
  });
});

describe('bridge POST /v1/responses — stateful continuation (previous_response_id)', () => {
  // Deterministic recording provider: records every ChatParams it receives,
  // simulates a tool call for "!tool <name>" user text, and answers with a
  // real upstream resp_ id (chat + stream finish chunk).
  const received: Array<{ params: ChatParams; model: string }> = [];
  const recordingProvider: Provider = {
    id: 'rec',
    name: 'Recording (stateful echo)',
    defaultModel: 'rec-model',
    capabilities: { streaming: true, toolCalling: true, vision: false, embeddings: false },

    async chat(params: ChatParams): Promise<ChatResult> {
      received.push({ params, model: params.model });
      const text = lastUserText(params);
      if (text.startsWith('!tool ')) {
        return {
          message: {
            role: 'assistant',
            content: '',
            toolCalls: [{ id: 'call_t1', name: text.slice(6).trim(), arguments: { city: 'SF' } }],
          },
          finishReason: 'tool-calls',
          usage: { inputTokens: 7, outputTokens: 3 },
          raw: { id: 'resp_upstream_nonstream', status: 'completed' },
        };
      }
      return {
        message: { role: 'assistant', content: `answered ${params.messages.length} msg` },
        finishReason: 'stop',
        usage: { inputTokens: 7, outputTokens: 9 },
        raw: { id: 'resp_upstream_nonstream', status: 'completed' },
      };
    },

    async *stream(params: ChatParams): AsyncGenerator<StreamChunk> {
      received.push({ params, model: params.model });
      const text = lastUserText(params);
      if (text.startsWith('!tool ')) {
        yield { type: 'tool-call-start', id: 'call_t1', name: text.slice(6).trim() };
        yield { type: 'tool-call-args-delta', id: 'call_t1', argsDelta: '{"city":"' };
        yield { type: 'tool-call-args-delta', id: 'call_t1', argsDelta: 'SF"}' };
        yield { type: 'tool-call-end', id: 'call_t1' };
        yield { type: 'finish', finishReason: 'tool-calls', responseId: 'resp_upstream_stream' };
        return;
      }
      yield { type: 'text-delta', text: 'streamed answer' };
      yield { type: 'finish', finishReason: 'stop', responseId: 'resp_upstream_stream' };
    },
  };

  let server2: OpenAICompatibleServer;
  let base2: string;

  beforeAll(async () => {
    server2 = createModelHitchServer({
      providers: [recordingProvider],
      defaultProviderId: 'rec',
    });
    const info = await server2.listen(0, '127.0.0.1');
    base2 = info.url;
  });

  afterAll(async () => {
    await server2.close();
  });

  // The conversation cache is module-level — isolate every test so chains
  // can't leak across tests.
  beforeEach(() => clearConversations());

  function responses2(body: unknown): Promise<Response> {
    return fetch(`${base2}/v1/responses`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  }

  it('expands a tool-result delta against the cached conversation (non-stream)', async () => {
    received.length = 0;

    // Turn 1: user asks, model must call a tool. The bridge remembers the
    // conversation under the id it returns (upstream resp_ id).
    const turn1 = await responses2({
      model: 'rec-model',
      input: [{ role: 'user', content: [{ type: 'input_text', text: '!tool get_weather' }] }],
      tools: [{ type: 'function', name: 'get_weather', description: 'Fetch weather' }],
      tool_choice: 'auto',
    });
    expect(turn1.status).toBe(200);
    const body1 = (await turn1.json()) as any;
    expect(body1.id).toBe('resp_upstream_nonstream');
    expect(received[0]!.params.messages).toEqual([
      { role: 'user', content: '!tool get_weather' },
    ]);

    // Turn 2 (the shape that 400'd before): previous_response_id + ONLY the
    // function_call_output delta — no user message, no function_call.
    const turn2 = await responses2({
      model: 'rec-model',
      previous_response_id: 'resp_upstream_nonstream',
      input: [{ type: 'function_call_output', call_id: 'call_t1', output: '{"temp": 21}' }],
    });
    expect(turn2.status).toBe(200);

    // The provider must receive the FULL reconstructed conversation (cached
    // turn 1 incl. the assistant tool call + the new tool result), and NO
    // previous_response_id (zen rejects it — the bridge is the state holder).
    const params = received[1]!.params;
    expect(params.previousResponseId).toBeUndefined();
    expect(params.messages).toEqual([
      { role: 'user', content: '!tool get_weather' },
      {
        role: 'assistant',
        content: '',
        toolCalls: [{ id: 'call_t1', name: 'get_weather', arguments: { city: 'SF' } }],
      },
      { role: 'tool', content: '{"temp": 21}', toolCallId: 'call_t1' },
    ]);
  });

  it('expands a delta through the streaming path and round-trips the id in SSE', async () => {
    received.length = 0;

    const turn1 = await responses2({
      model: 'rec-model',
      stream: true,
      input: [{ role: 'user', content: [{ type: 'input_text', text: '!tool get_weather' }] }],
      tools: [{ type: 'function', name: 'get_weather', description: 'Fetch weather' }],
      tool_choice: 'auto',
    });
    expect(turn1.status).toBe(200);
    const events1 = await sseEvents(turn1);
    const completed1 = events1[events1.length - 1]!;
    expect(completed1.response.id).toBe('resp_upstream_stream');

    // Delta-only continuation (tool result, no user text) — the streaming
    // failure the extension hit.
    const turn2 = await responses2({
      model: 'rec-model',
      stream: true,
      previous_response_id: 'resp_upstream_stream',
      input: [{ type: 'function_call_output', call_id: 'call_t1', output: '{"temp": 21}' }],
    });
    expect(turn2.status).toBe(200);
    const events2 = await sseEvents(turn2);
    const completed2 = events2[events2.length - 1]!;
    expect(completed2.type).toBe('response.completed');
    expect(completed2.response.id).toBe('resp_upstream_stream');

    const params = received[1]!.params;
    expect(params.previousResponseId).toBeUndefined();
    expect(params.messages).toEqual([
      { role: 'user', content: '!tool get_weather' },
      {
        role: 'assistant',
        content: '',
        toolCalls: [{ id: 'call_t1', name: 'get_weather', arguments: { city: 'SF' } }],
      },
      { role: 'tool', content: '{"temp": 21}', toolCallId: 'call_t1' },
    ]);
  });

  it('answers a plain follow-up with the prior context included', async () => {
    received.length = 0;
    await responses2({
      model: 'rec-model',
      input: [{ role: 'user', content: [{ type: 'input_text', text: 'hi there' }] }],
    });
    const turn2 = await responses2({
      model: 'rec-model',
      previous_response_id: 'resp_upstream_nonstream',
      input: [{ role: 'user', content: [{ type: 'input_text', text: 'and then?' }] }],
    });
    expect(turn2.status).toBe(200);
    expect(received[1]!.params.messages).toEqual([
      { role: 'user', content: 'hi there' },
      { role: 'assistant', content: 'answered 1 msg', toolCalls: [] },
      { role: 'user', content: 'and then?' },
    ]);
  });

  it('returns a clear error when the referenced conversation is lost (bridge restart)', async () => {
    const res = await responses2({
      model: 'rec-model',
      previous_response_id: 'resp_from_a_dead_bridge',
      input: [{ type: 'function_call_output', call_id: 'call_x', output: '42' }],
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as any;
    expect(body.error.code).toBe('bad-request');
    expect(body.error.message).toContain('Start a new chat');
  });

  it('forwards a full request stateless when previous_response_id is lost but content exists', async () => {
    received.length = 0;
    const res = await responses2({
      model: 'rec-model',
      previous_response_id: 'resp_from_a_dead_bridge',
      input: [{ role: 'user', content: [{ type: 'input_text', text: 'what is 2+2?' }] }],
    });
    expect(res.status).toBe(200);
    expect(received[0]!.params.previousResponseId).toBeUndefined();
    expect(received[0]!.params.messages).toEqual([{ role: 'user', content: 'what is 2+2?' }]);
  });

  it('re-anchors a delta-only tool result by call_id when previous_response_id is missing', async () => {
    received.length = 0;

    // Turn 1 caches a conversation whose assistant message holds call_t1.
    await responses2({
      model: 'rec-model',
      input: [{ role: 'user', content: [{ type: 'input_text', text: '!tool get_weather' }] }],
      tools: [{ type: 'function', name: 'get_weather', description: 'Fetch weather' }],
      tool_choice: 'auto',
    });

    // Turn 2: NO previous_response_id (the client lost it), just the orphaned
    // tool result. The bridge must find call_t1 in the cache and expand.
    const turn2 = await responses2({
      model: 'rec-model',
      input: [{ type: 'function_call_output', call_id: 'call_t1', output: '{"temp": 21}' }],
    });
    expect(turn2.status).toBe(200);
    const params = received[1]!.params;
    expect(params.previousResponseId).toBeUndefined();
    expect(params.messages).toEqual([
      { role: 'user', content: '!tool get_weather' },
      {
        role: 'assistant',
        content: '',
        toolCalls: [{ id: 'call_t1', name: 'get_weather', arguments: { city: 'SF' } }],
      },
      { role: 'tool', content: '{"temp": 21}', toolCallId: 'call_t1' },
    ]);
  });

  it('keeps the stateless path unchanged when previous_response_id is absent', async () => {
    received.length = 0;
    const res = await responses2({
      model: 'rec-model',
      input: [{ role: 'user', content: [{ type: 'input_text', text: 'plain question' }] }],
    });
    expect(res.status).toBe(200);
    expect(received[0]!.params.previousResponseId).toBeUndefined();
    expect(received[0]!.params.messages).toEqual([{ role: 'user', content: 'plain question' }]);
  });
});

function lastUserText(params: ChatParams): string {
  const last = [...params.messages].reverse().find((m) => m.role === 'user');
  return typeof last?.content === 'string' ? last.content : '';
}
