import { describe, expect, it } from 'vitest';
import { createOpenAICompatibleProvider, zai } from '../src/providers/index.js';
import { ModelHitchError } from '../src/core/errors.js';
import type { ChatParams } from '../src/core/types.js';

interface CapturedRequest {
  url: string;
  init: RequestInit;
  body: Record<string, unknown>;
}

function mockFetch(opts: { status?: number; errorBody?: string } = {}) {
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
    return new Response(
      JSON.stringify({
        choices: [{ message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 },
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  };
  return { fetchImpl, calls };
}

const baseParams: ChatParams = {
  model: 'glm-5.2',
  messages: [{ role: 'user', content: 'hi' }],
};

describe('zai default provider', () => {
  it('exposes the Z.ai (GLM) config', () => {
    expect(zai.id).toBe('zai');
    expect(zai.name).toBe('Z.ai (GLM)');
    expect(zai.defaultModel).toBe('glm-5.2');
    expect(zai.capabilities).toMatchObject({
      streaming: true,
      toolCalling: true,
      vision: false,
      embeddings: false,
      maxContextTokens: 1_000_000,
    });
  });

  it('chats against the Z.ai OpenAI-compatible endpoint with an API key', async () => {
    // The exported default providers are singletons, so build an instance with
    // the same config plus an injected fetch to exercise the wire path offline.
    const { fetchImpl, calls } = mockFetch();
    const provider = createOpenAICompatibleProvider({
      id: 'zai',
      name: 'Z.ai (GLM)',
      baseUrl: 'https://api.z.ai/api/paas/v4/',
      defaultModel: 'glm-5.2',
      apiKeyEnvVar: 'ZAI_API_KEY',
      fetchImpl,
    });
    const result = await provider.chat(baseParams, { apiKey: 'zai-test-key' });
    expect(calls[0]!.url).toBe('https://api.z.ai/api/paas/v4/chat/completions');
    expect(calls[0]!.init.headers).toMatchObject({ Authorization: 'Bearer zai-test-key' });
    expect(result.message).toEqual({ role: 'assistant', content: 'ok' });
    expect(result.finishReason).toBe('stop');
    expect(result.usage).toEqual({ inputTokens: 5, outputTokens: 2, totalTokens: 7 });
  });

  it('throws missing-api-key when no ZAI_API_KEY is set', async () => {
    const saved = process.env.ZAI_API_KEY;
    delete process.env.ZAI_API_KEY;
    try {
      const err = await zai.chat(baseParams, {}).then(
        () => null,
        (e: unknown) => e,
      );
      expect(err).toBeInstanceOf(ModelHitchError);
      expect((err as ModelHitchError).code).toBe('missing-api-key');
      expect((err as ModelHitchError).message).toContain('ZAI_API_KEY');
    } finally {
      if (saved !== undefined) process.env.ZAI_API_KEY = saved;
      else delete process.env.ZAI_API_KEY;
    }
  });
});
