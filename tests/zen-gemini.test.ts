import { describe, expect, it } from 'vitest';
import type { ProviderCredentials } from '../src/core/types.js';
import { createOpenCodeZenProvider, zenProtocolForModel } from '../src/providers/opencode.js';
import { createZenGeminiProvider } from '../src/providers/zen-gemini.js';

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
    return new Response(JSON.stringify(opts.responseBody ?? { candidates: [] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };
  return { fetchImpl, calls };
}

const CREDENTIALS: ProviderCredentials = { apiKey: 'sk-zen-123' };

describe('zenProtocolForModel (Gemini)', () => {
  it('routes gemini-* models to the native Google protocol', () => {
    expect(zenProtocolForModel('gemini-3.6-flash')).toBe('gemini');
    expect(zenProtocolForModel('gemini-3.5-flash-lite')).toBe('gemini');
    expect(zenProtocolForModel('gemini-3.1-pro')).toBe('gemini');
    expect(zenProtocolForModel('GEMINI-3-FLASH')).toBe('gemini');
  });
});

describe('ZenGeminiProvider', () => {
  it('POSTs Google GenerateContent-shaped bodies with x-goog-api-key auth', async () => {
    const { fetchImpl, calls } = mockFetch({
      responseBody: {
        candidates: [{ content: { role: 'model', parts: [{ text: 'Hello from Gemini!' }] }, finishReason: 'STOP' }],
        usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5, totalTokenCount: 15 },
      },
    });
    const gemini = createZenGeminiProvider({ fetchImpl });
    const result = await gemini.chat(
      {
        model: 'gemini-3.5-flash-lite',
        messages: [
          { role: 'system', content: 'You are terse.' },
          { role: 'user', content: 'hi' },
        ],
        temperature: 0.2,
        maxTokens: 100,
      },
      CREDENTIALS,
    );
    expect(calls[0]!.url).toBe('https://opencode.ai/zen/v1/models/gemini-3.5-flash-lite:generateContent');
    expect(calls[0]!.init.headers).toMatchObject({ 'x-goog-api-key': 'sk-zen-123' });
    expect(calls[0]!.body).toMatchObject({
      contents: [{ role: 'user', parts: [{ text: 'hi' }] }],
      systemInstruction: { parts: [{ text: 'You are terse.' }] },
      generationConfig: { temperature: 0.2, maxOutputTokens: 100 },
    });
    expect(result.message).toEqual({ role: 'assistant', content: 'Hello from Gemini!' });
    expect(result.finishReason).toBe('stop');
    expect(result.usage?.totalTokens).toBe(15);
  });

  it('maps tool calls and results onto functionCall/functionResponse parts', async () => {
    const { fetchImpl, calls } = mockFetch({
      responseBody: {
        candidates: [
          {
            content: {
              role: 'model',
              parts: [
                {
                  thoughtSignature: 'sig123',
                  functionCall: { id: 'fc_1', name: 'get_weather', args: { city: 'SF' } },
                },
              ],
            },
            // Zen reports STOP even when the candidate carries a functionCall.
            finishReason: 'STOP',
          },
        ],
      },
    });
    const gemini = createZenGeminiProvider({ fetchImpl });
    const result = await gemini.chat(
      {
        model: 'gemini-3.5-flash-lite',
        messages: [
          { role: 'user', content: 'weather in SF?' },
          { role: 'assistant', content: '', toolCalls: [{ id: 'call_1', name: 'get_weather', arguments: { city: 'SF' } }] },
          { role: 'tool', toolCallId: 'call_1', content: '{"temp":18,"condition":"Sunny"}' },
        ],
        tools: [
          {
            name: 'get_weather',
            description: 'Get the weather',
            parameters: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] },
          },
        ],
        toolChoice: { type: 'function', name: 'get_weather' },
      },
      CREDENTIALS,
    );
    const body = calls[0]!.body;
    // Function declaration + forced tool config.
    expect(body.tools).toEqual([
      {
        functionDeclarations: [
          {
            name: 'get_weather',
            description: 'Get the weather',
            parameters: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] },
          },
        ],
      },
    ]);
    expect(body.toolConfig).toEqual({
      functionCallingConfig: { mode: 'ANY', allowedFunctionNames: ['get_weather'] },
    });
    // Conversation history: model functionCall then user functionResponse.
    const contents = body.contents as Array<{ role: string; parts: unknown[] }>;
    expect(contents[1]).toEqual({
      role: 'model',
      parts: [{ functionCall: { name: 'get_weather', args: { city: 'SF' } } }],
    });
    expect(contents[2]).toEqual({
      role: 'user',
      parts: [{ functionResponse: { name: 'get_weather', response: { temp: 18, condition: 'Sunny' } } }],
    });
    // Incoming tool call parsed from the candidate (incl. id + thoughtSignature).
    expect(result.finishReason).toBe('tool-calls');
    const toolCalls = result.message.role === 'assistant' ? result.message.toolCalls : undefined;
    expect(toolCalls).toEqual([
      { id: 'fc_1', name: 'get_weather', arguments: { city: 'SF' }, thoughtSignature: 'sig123' },
    ]);
  });

  it('echoes thoughtSignature on the next turn functionCall part', async () => {
    const { fetchImpl, calls } = mockFetch({
      responseBody: {
        candidates: [{ content: { role: 'model', parts: [{ text: 'done' }] }, finishReason: 'STOP' }],
      },
    });
    const gemini = createZenGeminiProvider({ fetchImpl });
    await gemini.chat(
      {
        model: 'gemini-3.5-flash-lite',
        messages: [
          { role: 'user', content: 'weather in SF?' },
          {
            role: 'assistant',
            content: '',
            toolCalls: [
              { id: 'fc_1', name: 'get_weather', arguments: { city: 'SF' }, thoughtSignature: 'sig123' },
            ],
          },
          { role: 'tool', toolCallId: 'fc_1', content: '{"temp":18}' },
        ],
      },
      CREDENTIALS,
    );
    const contents = calls[0]!.body.contents as Array<{ role: string; parts: unknown[] }>;
    expect(contents[1]).toEqual({
      role: 'model',
      parts: [{ thoughtSignature: 'sig123', functionCall: { name: 'get_weather', args: { city: 'SF' } } }],
    });
    expect(contents[2]).toEqual({
      role: 'user',
      parts: [{ functionResponse: { name: 'get_weather', response: { temp: 18 } } }],
    });
  });

  it('maps JSON mode to generationConfig.responseMimeType', async () => {
    const { fetchImpl, calls } = mockFetch({
      responseBody: {
        candidates: [{ content: { role: 'model', parts: [{ text: '{"ok":true}' }] }, finishReason: 'STOP' }],
      },
    });
    const gemini = createZenGeminiProvider({ fetchImpl });
    await gemini.chat(
      { model: 'gemini-3.5-flash-lite', messages: [{ role: 'user', content: 'json please' }], responseFormat: 'json' },
      CREDENTIALS,
    );
    expect(calls[0]!.body.generationConfig).toEqual({ responseMimeType: 'application/json' });
  });

  it('normalizes :streamGenerateContent SSE chunks into StreamChunks', async () => {
    const { fetchImpl } = mockFetch({
      stream: true,
      chunks: [
        'data: {"candidates":[{"content":{"role":"model","parts":[{"text":"It is "}]}}]}',
        'data: {"candidates":[{"content":{"parts":[{"functionCall":{"name":"get_weather","args":"{\\"ci"}}]}}]}',
        'data: {"candidates":[{"content":{"parts":[{"functionCall":{"args":"ty\\":\\"SF\\"}"}}]}}]}',
        'data: {"candidates":[{"content":{"parts":[{"text":"Sunny."}]},"finishReason":"TOOL_CALLS"}],"usageMetadata":{"promptTokenCount":8,"candidatesTokenCount":6,"totalTokenCount":14}}',
      ],
    });
    const gemini = createZenGeminiProvider({ fetchImpl });
    const events = [];
    for await (const e of gemini.stream(
      { model: 'gemini-3.5-flash-lite', messages: [{ role: 'user', content: 'weather?' }] },
      CREDENTIALS,
    )) {
      events.push(e);
    }
    expect(events).toEqual([
      { type: 'text-delta', text: 'It is ' },
      { type: 'tool-call-start', id: 'call_0', name: 'get_weather' },
      { type: 'tool-call-args-delta', id: 'call_0', argsDelta: '{"ci' },
      { type: 'tool-call-args-delta', id: 'call_0', argsDelta: 'ty":"SF"}' },
      { type: 'text-delta', text: 'Sunny.' },
      { type: 'tool-call-end', id: 'call_0' },
      {
        type: 'finish',
        finishReason: 'tool-calls',
        usage: { inputTokens: 8, outputTokens: 6, totalTokens: 14 },
      },
    ]);
  });

  it('throws missing-api-key without credentials', async () => {
    const { fetchImpl } = mockFetch({});
    const gemini = createZenGeminiProvider({ fetchImpl });
    await expect(
      gemini.chat({ model: 'gemini-3.5-flash-lite', messages: [{ role: 'user', content: 'hi' }] }, {}),
    ).rejects.toMatchObject({ code: 'missing-api-key' });
  });

  it('maps 404 to model-not-found', async () => {
    const { fetchImpl } = mockFetch({ status: 404 });
    const gemini = createZenGeminiProvider({ fetchImpl });
    await expect(
      gemini.chat({ model: 'gemini-nope', messages: [{ role: 'user', content: 'hi' }] }, CREDENTIALS),
    ).rejects.toMatchObject({ code: 'model-not-found' });
  });
});

describe('opencodeZen family routing (Gemini)', () => {
  it('sends gemini-* models to the :generateContent endpoint via the routed provider', async () => {
    const { fetchImpl, calls } = mockFetch({
      responseBody: {
        candidates: [{ content: { role: 'model', parts: [{ text: 'ok' }] }, finishReason: 'STOP' }],
      },
    });
    const zen = createOpenCodeZenProvider({ fetchImpl });
    await zen.chat({ model: 'gemini-3.6-flash', messages: [{ role: 'user', content: 'hi' }] }, CREDENTIALS);
    expect(calls[0]!.url).toBe('https://opencode.ai/zen/v1/models/gemini-3.6-flash:generateContent');
    expect(calls[0]!.init.headers).toMatchObject({ 'x-goog-api-key': 'sk-zen-123' });
  });
});
