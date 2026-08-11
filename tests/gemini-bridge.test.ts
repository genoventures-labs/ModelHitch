import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createModelHitchServer, mockProvider, type OpenAICompatibleServer } from '../src/index.js';

/**
 * End-to-end tests for `POST /v1beta/models/{model}:generateContent` (+ the
 * `:streamGenerateContent?alt=sse` variant) — the Google Generative Language
 * API wire protocol that Gemini CLI speaks to any custom
 * `GOOGLE_GEMINI_BASE_URL`. Uses the deterministic mock provider ("!tool
 * <name>" user text triggers a simulated tool call; tool_choice 'none'
 * suppresses it).
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

/** Non-stream: POST /v1beta/models/:model:generateContent */
function gemini(model: string, body: unknown): Promise<Response> {
  return fetch(`${base}/v1beta/models/${model}:generateContent`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

/** Stream: POST /v1beta/models/:model:streamGenerateContent?alt=sse */
function geminiStream(model: string, body: unknown): Promise<Response> {
  return fetch(`${base}/v1beta/models/${model}:streamGenerateContent?alt=sse`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

async function sseChunks(res: Response): Promise<Array<Record<string, any>>> {
  const text = await res.text();
  const chunks: Array<Record<string, any>> = [];
  for (const raw of text.split('\n\n')) {
    for (const line of raw.split('\n')) {
      if (line.startsWith('data:')) {
        const payload = line.slice(5).trim();
        if (payload) chunks.push(JSON.parse(payload) as Record<string, any>);
      }
    }
  }
  return chunks;
}

const TOOL_DEF = {
  functionDeclarations: [
    {
      name: 'get_weather',
      description: 'Get the current weather for a city.',
      parameters: { type: 'object', properties: { q: { type: 'string' } }, required: ['q'] },
    },
  ],
};

describe('bridge :generateContent — validation', () => {
  it('400s when contents is missing or empty with the Google error envelope', async () => {
    const res = await gemini('mock-model', { generationConfig: { maxOutputTokens: 10 } });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { status: string; code: number } };
    expect(body.error.status).toBe('INVALID_ARGUMENT');
    expect(body.error.code).toBe(400);
  });

  it('accepts Google extras (safetySettings, cachedContent) without 400ing', async () => {
    const res = await gemini('mock-model', {
      contents: [{ role: 'user', parts: [{ text: 'hi there' }] }],
      safetySettings: [{ category: 'HARM_CATEGORY_HARASSMENT', threshold: 'BLOCK_NONE' }],
      cachedContent: 'projects/1/locations/us-central1/cachedContents/abc',
      userAgent: 'gemini-cli/0.4',
    });
    expect(res.status).toBe(200);
  });
});

describe('bridge :generateContent — non-streaming', () => {
  it('turns a functionCall + functionResponse round-trip into Google candidates', async () => {
    // Turn 1: the model must call get_weather.
    const turn1 = await gemini('mock-model', {
      contents: [{ role: 'user', parts: [{ text: '!tool get_weather' }] }],
      tools: [TOOL_DEF],
      toolConfig: { functionCallingConfig: { mode: 'ANY', allowedFunctionNames: ['get_weather'] } },
    });
    expect(turn1.status).toBe(200);
    const c1 = (await turn1.json()) as {
      candidates: Array<{ content: { role: string; parts: Array<Record<string, any>> }; finishReason: string; index: number }>;
      usageMetadata: { promptTokenCount: number; candidatesTokenCount: number };
      modelVersion: string;
    };
    expect(c1.modelVersion).toBe('mock-model');
    const fc = c1.candidates[0]!.content.parts.find((p) => p.functionCall);
    expect(fc?.functionCall.name).toBe('get_weather');
    expect(fc?.functionCall.args).toEqual({ q: 'mock query' });
    expect(fc?.functionCall.id).toBe('call_mock_1');
    expect(c1.candidates[0]!.finishReason).toBe('TOOL_CALLS');
    expect(c1.usageMetadata.promptTokenCount).toBeGreaterThan(0);

    // Turn 2: functionResponse part + NONE mode -> plain text answer.
    const turn2 = await gemini('mock-model', {
      contents: [
        { role: 'user', parts: [{ text: '!tool get_weather' }] },
        { role: 'model', parts: [{ functionCall: { id: fc!.functionCall.id, name: 'get_weather', args: { q: 'mock query' } } }] },
        { role: 'user', parts: [{ functionResponse: { name: 'get_weather', response: { temp: 21, condition: 'sunny' } } }] },
      ],
      tools: [TOOL_DEF],
      toolConfig: { functionCallingConfig: { mode: 'NONE' } },
    });
    expect(turn2.status).toBe(200);
    const c2 = (await turn2.json()) as { candidates: Array<{ content: { parts: Array<{ text?: string }> }; finishReason: string }> };
    const text = c2.candidates[0]!.content.parts.map((p) => p.text ?? '').join('');
    expect(text).toContain('Mock reply: !tool get_weather');
    expect(c2.candidates[0]!.finishReason).toBe('STOP');
  });

  it('maps systemInstruction to a system message and honors generationConfig', async () => {
    const res = await gemini('mock-model', {
      contents: [{ role: 'user', parts: [{ text: 'hello' }] }],
      systemInstruction: { parts: [{ text: 'You are a weather bot.' }] },
      generationConfig: { temperature: 0.2, maxOutputTokens: 77, stopSequences: ['\n'] },
    });
    expect(res.status).toBe(200);
  });
});

describe('bridge :streamGenerateContent — streaming', () => {
  it('emits partial chunks for a streamed tool call and finishes with TOOL_CALLS', async () => {
    const res = await geminiStream('mock-model', {
      contents: [{ role: 'user', parts: [{ text: '!tool get_weather' }] }],
      tools: [TOOL_DEF],
      toolConfig: { functionCallingConfig: { mode: 'ANY', allowedFunctionNames: ['get_weather'] } },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    const chunks = await sseChunks(res);
    expect(chunks.length).toBeGreaterThan(0);

    let functionCallPart: Record<string, any> | undefined;
    let args = '';
    let finishReason: string | undefined;
    for (const chunk of chunks) {
      const candidate = chunk.candidates?.[0];
      for (const part of candidate?.content?.parts ?? []) {
        if (part.functionCall) {
          functionCallPart ??= part.functionCall;
          if (typeof part.functionCall.args === 'string') args += part.functionCall.args;
        }
      }
      if (candidate?.finishReason) finishReason = candidate.finishReason;
    }
    expect(functionCallPart?.name).toBe('get_weather');
    expect(functionCallPart?.id).toBe('call_mock_1');
    expect(args).toContain('"q"');
    expect(finishReason).toBe('TOOL_CALLS');
  });

  it('streams text deltas and finishes with STOP', async () => {
    const res = await geminiStream('mock-model', {
      contents: [{ role: 'user', parts: [{ text: 'hi there' }] }],
    });
    const chunks = await sseChunks(res);
    const text = chunks
      .flatMap((c) => (c.candidates?.[0]?.content?.parts ?? []).map((p: { text?: string }) => p.text ?? ''))
      .join('');
    expect(text).toContain('Mock reply: hi there');
    expect(chunks[chunks.length - 1]!.candidates[0].finishReason).toBe('STOP');
  });
});

describe('bridge :generateContent — routing', () => {
  it('routes provider-prefixed model ids from the URL path', async () => {
    const res = await gemini('mock/mock-model', {
      contents: [{ role: 'user', parts: [{ text: 'hi' }] }],
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { modelVersion: string };
    expect(body.modelVersion).toBe('mock-model');
  });
});
