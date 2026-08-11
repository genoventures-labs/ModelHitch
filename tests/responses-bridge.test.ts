import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createModelHitchServer, mockProvider, type OpenAICompatibleServer } from '../src/index.js';

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
