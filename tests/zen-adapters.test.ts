import { describe, expect, it } from 'vitest';
import type { ProviderCredentials } from '../src/core/types.js';
import {
  OPENCODE_ZEN_MODELS,
  createOpenCodeZenProvider,
  zenProtocolForModel,
} from '../src/providers/opencode.js';
import { createZenResponsesProvider } from '../src/providers/zen-responses.js';
import { createZenMessagesProvider } from '../src/providers/zen-messages.js';

interface CapturedRequest {
  url: string;
  init: RequestInit;
  body: Record<string, unknown>;
}

function mockFetch(opts: { status?: number; errorBody?: string; stream?: boolean; chunks?: string[]; responseBody?: Record<string, unknown> } = {}) {
  const calls: CapturedRequest[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof Request ? input.url : input.href;
    calls.push({ url, init: init ?? {}, body: JSON.parse(String(init?.body ?? '{}')) });
    if (opts.status && opts.status >= 400) {
      return new Response(opts.errorBody ?? '{"error":{"message":"boom"}}', {
        status: opts.status,
        headers: { 'content-type': 'application/json' },
      });
    }
    if (opts.stream) {
      const encoder = new TextEncoder();
      const payload = (opts.chunks ?? []).join('\n\n') + '\n\n';
      return new Response(encoder.encode(payload), {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      });
    }
    return new Response(JSON.stringify(opts.responseBody ?? { id: 'resp_1', status: 'completed', output: [] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };
  return { fetchImpl, calls };
}

const CREDENTIALS: ProviderCredentials = { apiKey: 'sk-zen-123' };

describe('zenProtocolForModel', () => {
  it('routes GPT and Grok models to the Responses API', () => {
    expect(zenProtocolForModel('gpt-5.6-sol')).toBe('responses');
    expect(zenProtocolForModel('gpt-5.4-mini')).toBe('responses');
    expect(zenProtocolForModel('grok-4.5')).toBe('responses');
    expect(zenProtocolForModel('Gpt-5')).toBe('responses');
  });

  it('routes Claude and Qwen models to the Messages API', () => {
    expect(zenProtocolForModel('claude-sonnet-5')).toBe('messages');
    expect(zenProtocolForModel('claude-opus-4-8')).toBe('messages');
    expect(zenProtocolForModel('qwen3.7-max')).toBe('messages');
  });

  it('routes everything else to chat completions', () => {
    expect(zenProtocolForModel('deepseek-v4-flash')).toBe('chat-completions');
    expect(zenProtocolForModel('minimax-m3')).toBe('chat-completions');
    expect(zenProtocolForModel('big-pickle')).toBe('chat-completions');
    expect(zenProtocolForModel('kimi-k3')).toBe('chat-completions');
  });

  it('covers every curated Zen model with a known protocol', () => {
    for (const id of OPENCODE_ZEN_MODELS) {
      expect(['responses', 'messages', 'gemini', 'chat-completions']).toContain(zenProtocolForModel(id));
    }
  });
});

describe('ZenResponsesProvider', () => {
  it('POSTs Responses-API-shaped bodies to /responses with Bearer auth', async () => {
    const { fetchImpl, calls } = mockFetch({
      responseBody: {
        id: 'resp_1',
        status: 'completed',
        output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Hello!' }] }],
        usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
      },
    });
    const zen = createZenResponsesProvider({ fetchImpl });
    const result = await zen.chat(
      {
        model: 'gpt-5.6-luna',
        messages: [
          { role: 'system', content: 'You are a terse assistant.' },
          { role: 'user', content: 'hi' },
        ],
      },
      CREDENTIALS,
    );
    expect(calls[0]!.url).toBe('https://opencode.ai/zen/v1/responses');
    expect(calls[0]!.init.headers).toMatchObject({ Authorization: 'Bearer sk-zen-123' });
    expect(calls[0]!.body).toMatchObject({
      model: 'gpt-5.6-luna',
      instructions: 'You are a terse assistant.',
      input: [{ role: 'user', content: [{ type: 'input_text', text: 'hi' }] }],
    });
    expect(result.message).toEqual({ role: 'assistant', content: 'Hello!' });
    expect(result.finishReason).toBe('stop');
    expect(result.usage?.totalTokens).toBe(15);
  });

  it('maps tool calls and tool results onto Responses items', async () => {
    const { fetchImpl, calls } = mockFetch({
      responseBody: {
        id: 'resp_2',
        status: 'completed',
        output: [{ type: 'function_call', call_id: 'call_1', name: 'get_weather', arguments: '{"city":"SF"}' }],
      },
    });
    const zen = createZenResponsesProvider({ fetchImpl });
    const result = await zen.chat(
      {
        model: 'gpt-5.5',
        messages: [
          { role: 'user', content: 'weather in SF?' },
          { role: 'assistant', content: '', toolCalls: [{ id: 'call_1', name: 'get_weather', arguments: { city: 'SF' } }] },
          { role: 'tool', toolCallId: 'call_1', content: '{"temp":18}' },
        ],
      },
      CREDENTIALS,
    );
    const input = calls[0]!.body.input as unknown[];
    expect(input[0]).toEqual({ role: 'user', content: [{ type: 'input_text', text: 'weather in SF?' }] });
    // Tool calls are TOP-LEVEL input items, not nested in an assistant message.
    expect(input[1]).toEqual({
      type: 'function_call',
      call_id: 'call_1',
      name: 'get_weather',
      arguments: '{"city":"SF"}',
    });
    expect(input[2]).toEqual({ type: 'function_call_output', call_id: 'call_1', output: '{"temp":18}' });
    expect(result.finishReason).toBe('tool-calls');
    const toolCalls = result.message.role === 'assistant' ? result.message.toolCalls : undefined;
    expect(toolCalls).toEqual([{ id: 'call_1', name: 'get_weather', arguments: { city: 'SF' } }]);
  });

  it('forwards previous_response_id for stateful continuations', async () => {
    const { fetchImpl, calls } = mockFetch({
      responseBody: {
        id: 'resp_3',
        status: 'completed',
        output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '42 it is.' }] }],
      },
    });
    const zen = createZenResponsesProvider({ fetchImpl });
    await zen.chat(
      {
        model: 'gpt-5.6-luna',
        messages: [{ role: 'tool', toolCallId: 'call_t1', content: '42' }],
        previousResponseId: 'resp_2',
      },
      CREDENTIALS,
    );
    expect(calls[0]!.body.previous_response_id).toBe('resp_2');
    // The delta input is forwarded as-is (zen resolves call ids against its
    // own state for the referenced response).
    expect(calls[0]!.body.input).toEqual([
      { type: 'function_call_output', call_id: 'call_t1', output: '42' },
    ]);
  });

  it('normalizes Responses SSE events into StreamChunks', async () => {
    const { fetchImpl } = mockFetch({
      stream: true,
      chunks: [
        'data: {"type":"response.created","response":{"id":"resp_1"}}',
        'data: {"type":"response.output_item.added","output_index":0,"item":{"type":"function_call","id":"fc_1","call_id":"call_1","name":"get_weather","arguments":"","status":"in_progress"}}',
        'data: {"type":"response.output_text.delta","item_id":"msg_1","output_index":1,"content_index":0,"delta":"It is "}',
        'data: {"type":"response.function_call_arguments.delta","item_id":"fc_1","output_index":0,"delta":"{\\"city\\":\\""}',
        'data: {"type":"response.function_call_arguments.delta","item_id":"fc_1","output_index":0,"delta":"\\"SF\\"}"}',
        'data: {"type":"response.output_text.delta","item_id":"msg_1","output_index":1,"content_index":0,"delta":"18°C."}',
        'data: {"type":"response.output_item.done","output_index":0,"item":{"type":"function_call","id":"fc_1","call_id":"call_1","name":"get_weather","arguments":"{\\"city\\":\\"SF\\"}"}}',
        'data: {"type":"response.completed","response":{"id":"resp_1","status":"completed","output":[{"type":"function_call","call_id":"call_1","name":"get_weather","arguments":"{\\"city\\":\\"SF\\"}"}],"usage":{"input_tokens":8,"output_tokens":6,"total_tokens":14}}}',
      ],
    });
    const zen = createZenResponsesProvider({ fetchImpl });
    const events = [];
    for await (const e of zen.stream(
      { model: 'gpt-5.5', messages: [{ role: 'user', content: 'weather?' }] },
      CREDENTIALS,
    )) {
      events.push(e);
    }
    expect(events).toEqual([
      { type: 'tool-call-start', id: 'call_1', name: 'get_weather' },
      { type: 'text-delta', text: 'It is ' },
      { type: 'tool-call-args-delta', id: 'call_1', argsDelta: '{"city":"' },
      { type: 'tool-call-args-delta', id: 'call_1', argsDelta: '"SF"}' },
      { type: 'text-delta', text: '18°C.' },
      { type: 'tool-call-end', id: 'call_1' },
      {
        type: 'finish',
        finishReason: 'tool-calls',
        usage: { inputTokens: 8, outputTokens: 6, totalTokens: 14 },
        responseId: 'resp_1',
      },
    ]);
  });

  it('throws missing-api-key without credentials', async () => {
    const savedZen = process.env.OPENCODE_ZEN_API_KEY;
    const savedGo = process.env.OPENCODE_API_KEY;
    delete process.env.OPENCODE_ZEN_API_KEY;
    delete process.env.OPENCODE_API_KEY;
    try {
      const { fetchImpl } = mockFetch({});
      const zen = createZenResponsesProvider({ fetchImpl });
      await expect(
        zen.chat({ model: 'gpt-5.5', messages: [{ role: 'user', content: 'hi' }] }, {}),
      ).rejects.toMatchObject({ code: 'missing-api-key' });
    } finally {
      if (savedZen !== undefined) process.env.OPENCODE_ZEN_API_KEY = savedZen;
      else delete process.env.OPENCODE_ZEN_API_KEY;
      if (savedGo !== undefined) process.env.OPENCODE_API_KEY = savedGo;
      else delete process.env.OPENCODE_API_KEY;
    }
  });

  it('maps 404 to model-not-found', async () => {
    const { fetchImpl } = mockFetch({ status: 404 });
    const zen = createZenResponsesProvider({ fetchImpl });
    await expect(
      zen.chat({ model: 'gpt-nope', messages: [{ role: 'user', content: 'hi' }] }, CREDENTIALS),
    ).rejects.toMatchObject({ code: 'model-not-found' });
  });
});

describe('ZenMessagesProvider', () => {
  it('speaks the Anthropic Messages protocol against Zen', async () => {
    const { fetchImpl, calls } = mockFetch({
      responseBody: {
        id: 'msg_1',
        content: [{ type: 'text', text: 'Bonjour' }],
        stop_reason: 'end_turn',
        usage: { input_tokens: 4, output_tokens: 2 },
      },
    });
    const zen = createZenMessagesProvider({ fetchImpl });
    const result = await zen.chat(
      { model: 'claude-sonnet-5', messages: [{ role: 'user', content: 'say hi in french' }] },
      CREDENTIALS,
    );
    expect(calls[0]!.url).toBe('https://opencode.ai/zen/v1/messages');
    expect(calls[0]!.init.headers).toMatchObject({
      'x-api-key': 'sk-zen-123',
      'anthropic-version': '2023-06-01',
    });
    expect(calls[0]!.body).toMatchObject({ model: 'claude-sonnet-5', max_tokens: 4096 });
    expect(result.message).toEqual({ role: 'assistant', content: 'Bonjour' });
    expect(result.finishReason).toBe('stop');
  });

  it('has a Claude default model', () => {
    const zen = createZenMessagesProvider();
    expect(zen.id).toBe('zen-messages');
    expect(zen.defaultModel).toBe('claude-sonnet-5');
  });
});

describe('opencodeZen family routing', () => {
  it('sends Claude models to /messages via the routed provider', async () => {
    const { fetchImpl, calls } = mockFetch({
      responseBody: {
        id: 'msg_1',
        content: [{ type: 'text', text: 'ok' }],
        stop_reason: 'end_turn',
        usage: { input_tokens: 3, output_tokens: 1 },
      },
    });
    const zen = createOpenCodeZenProvider({ fetchImpl });
    await zen.chat({ model: 'claude-sonnet-5', messages: [{ role: 'user', content: 'hi' }] }, CREDENTIALS);
    expect(calls[0]!.url).toBe('https://opencode.ai/zen/v1/messages');
  });

  it('sends GPT models to /responses and chat models to /chat/completions', async () => {
    const calls: string[] = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = typeof input === 'string' ? input : input instanceof Request ? input.url : input.href;
      calls.push(url);
      if (url.endsWith('/responses')) {
        return new Response(JSON.stringify({ id: 'resp_1', status: 'completed', output: [] }), { status: 200 });
      }
      return new Response(
        JSON.stringify({
          choices: [{ message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
        }),
        { status: 200 },
      );
    };
    const zen = createOpenCodeZenProvider({ fetchImpl });
    await zen.chat({ model: 'gpt-5.6-terra', messages: [{ role: 'user', content: 'hi' }] }, CREDENTIALS);
    expect(calls[0]).toBe('https://opencode.ai/zen/v1/responses');

    await zen.chat({ model: 'big-pickle', messages: [{ role: 'user', content: 'hi' }] }, CREDENTIALS);
    expect(calls[1]).toBe('https://opencode.ai/zen/v1/chat/completions');
  });
});
