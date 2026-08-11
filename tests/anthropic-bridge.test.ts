import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createModelHitchServer, mockProvider, type OpenAICompatibleServer } from '../src/index.js';

/**
 * End-to-end tests for `POST /v1/messages` — the Anthropic Messages API wire
 * protocol that Claude Code speaks to any LLM gateway via `ANTHROPIC_BASE_URL`.
 * Uses the deterministic mock provider ("!tool <name>" user text triggers a
 * simulated tool call; tool_choice 'none' suppresses it).
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

function anthropic(body: unknown): Promise<Response> {
  return fetch(`${base}/v1/messages`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'anthropic-version': '2023-06-01',
      Authorization: 'Bearer test-gateway-token',
    },
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

describe('bridge POST /v1/messages — validation', () => {
  it('400s when messages is missing or empty', async () => {
    const res = await anthropic({ model: 'mock-model', max_tokens: 10 });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { type: string; error: { type: string } };
    expect(body.type).toBe('error');
    expect(body.error.type).toBe('invalid_request_error');
  });

  it('accepts a request with Claude Code extras (thinking, betas) without 400ing', async () => {
    const res = await anthropic({
      model: 'mock-model',
      max_tokens: 64,
      thinking: { type: 'adaptive' },
      context_management: { type: 'auto' },
      output_config: { effort: 'high' },
      metadata: { user_id: 'u_1' },
      betas: ['context-management-2025-04-30'],
      messages: [{ role: 'user', content: 'hi there' }],
    });
    expect(res.status).toBe(200);
  });
});

describe('bridge POST /v1/messages — non-streaming', () => {
  it('turns a tool_use + tool_result round-trip into Anthropic content blocks', async () => {
    // Turn 1: user asks, model must call get_weather (mock sees "!tool").
    const turn1 = await anthropic({
      model: 'mock-model',
      max_tokens: 256,
      system: [{ type: 'text', text: 'You are the Android Studio agent.' }],
      messages: [{ role: 'user', content: [{ type: 'text', text: '!tool get_weather' }] }],
      tools: [
        {
          name: 'get_weather',
          description: 'Fetch weather',
          input_schema: { type: 'object', properties: { city: { type: 'string' } } },
        },
      ],
      tool_choice: { type: 'auto' },
    });
    expect(turn1.status).toBe(200);
    const body1 = (await turn1.json()) as any;
    expect(body1.type).toBe('message');
    expect(body1.role).toBe('assistant');
    expect(body1.model).toBe('mock-model');
    expect(body1.stop_reason).toBe('tool_use');
    expect(body1.stop_sequence).toBeNull();

    const uses = body1.content.filter((b: any) => b.type === 'tool_use');
    expect(uses).toHaveLength(1);
    expect(uses[0]!.id).toBe('call_mock_1');
    expect(uses[0]!.name).toBe('get_weather');
    // Anthropic tool input is a JSON *object*, not a string.
    expect(uses[0]!.input).toEqual({ q: 'mock query' });
    expect(body1.usage.input_tokens).toBeGreaterThan(0);

    // Turn 2: feed the tool_use + tool_result back in, ask to answer with
    // tool_choice 'none' (mock echoes the user text).
    const turn2 = await anthropic({
      model: 'mock-model',
      max_tokens: 256,
      messages: [
        { role: 'user', content: [{ type: 'text', text: '!tool get_weather' }] },
        {
          role: 'assistant',
          content: [{ type: 'tool_use', id: 'call_mock_1', name: 'get_weather', input: { q: 'mock query' } }],
        },
        {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: 'call_mock_1', content: '{"temp": 21}' }],
        },
      ],
      tools: [{ name: 'get_weather', description: 'Fetch weather', input_schema: { type: 'object' } }],
      tool_choice: { type: 'none' },
    });
    expect(turn2.status).toBe(200);
    const body2 = (await turn2.json()) as any;
    const texts = body2.content.filter((b: any) => b.type === 'text');
    expect(texts).toHaveLength(1);
    expect(texts[0]!.text).toContain('Mock reply: !tool get_weather');
  });

  it('maps the system field to a system message and honors max_tokens', async () => {
    const res = await anthropic({
      model: 'mock-model',
      max_tokens: 42,
      system: 'Be terse.',
      messages: [{ role: 'user', content: 'hi there' }],
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    const texts = body.content.filter((b: any) => b.type === 'text');
    expect(texts[0]!.text).toContain('Mock reply: hi there');
  });
});

describe('bridge POST /v1/messages — streaming', () => {
  it('emits Anthropic SSE events for a streamed tool call', async () => {
    const res = await anthropic({
      model: 'mock-model',
      max_tokens: 256,
      stream: true,
      messages: [{ role: 'user', content: '!tool get_weather' }],
      tools: [{ name: 'get_weather', description: 'Fetch weather', input_schema: { type: 'object' } }],
      tool_choice: { type: 'auto' },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/event-stream');

    const events = await sseEvents(res);
    const types = events.map((e) => e.type);
    expect(types[0]).toBe('message_start');
    expect(types).toContain('content_block_start');
    expect(types).toContain('content_block_delta');
    expect(types).toContain('content_block_stop');
    expect(types).toContain('message_delta');
    expect(types[types.length - 1]).toBe('message_stop');

    const start = events.find((e) => e.type === 'content_block_start')!;
    expect(start.content_block.type).toBe('tool_use');
    expect(start.content_block.name).toBe('get_weather');
    expect(start.content_block.id).toBe('call_mock_1');

    const delta = events.find(
      (e) => e.type === 'content_block_delta' && e.delta?.type === 'input_json_delta',
    )!;
    expect(delta.delta.partial_json).toBe('{"q":"mock query"}');

    const messageDelta = events.find((e) => e.type === 'message_delta')!;
    expect(messageDelta.delta.stop_reason).toBe('tool_use');
  });

  it('emits text deltas for a plain answer and stops with message_stop', async () => {
    const res = await anthropic({
      model: 'mock-model',
      max_tokens: 256,
      stream: true,
      messages: [{ role: 'user', content: 'hi there' }],
    });
    const events = await sseEvents(res);
    const types = events.map((e) => e.type);
    expect(types).toContain('content_block_start');
    expect(types).toContain('content_block_delta');

    const text = events
      .filter((e) => e.type === 'content_block_delta' && e.delta?.type === 'text_delta')
      .map((e) => e.delta.text)
      .join('');
    expect(text).toContain('Mock reply: hi there');

    const stop = events[events.length - 1]!;
    expect(stop.type).toBe('message_stop');
    const messageDelta = events.find((e) => e.type === 'message_delta')!;
    expect(messageDelta.delta.stop_reason).toBe('end_turn');
  });
});

describe('bridge POST /v1/messages — count_tokens + routing', () => {
  it('returns an input_tokens estimate without calling the provider', async () => {
    const res = await fetch(`${base}/v1/messages/count_tokens`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'mock-model',
        system: 'Be terse.',
        messages: [{ role: 'user', content: 'hello world, this is a longer message for counting' }],
      }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { input_tokens: number };
    expect(typeof body.input_tokens).toBe('number');
    expect(body.input_tokens).toBeGreaterThan(0);
  });

  it('routes prefixed model ids to the named provider', async () => {
    const res = await anthropic({
      model: 'mock/mock-model',
      max_tokens: 16,
      messages: [{ role: 'user', content: 'hi' }],
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.model).toBe('mock-model');
  });

  it('serves the HEAD /api/hello warm-up probe', async () => {
    const res = await fetch(`${base}/api/hello`, { method: 'HEAD' });
    expect(res.status).toBe(200);
  });
});
