import { describe, expect, it } from 'vitest';
import { createOpenAICompatibleProvider, huggingface } from '../src/providers/index.js';
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
  model: 'Qwen/Qwen2.5-72B-Instruct',
  messages: [{ role: 'user', content: 'hi' }],
};

describe('huggingface default provider', () => {
  it('exposes the HuggingFace router config', () => {
    expect(huggingface.id).toBe('huggingface');
    expect(huggingface.name).toBe('HuggingFace');
    expect(huggingface.defaultModel).toBe('Qwen/Qwen2.5-72B-Instruct');
    expect(huggingface.capabilities).toMatchObject({
      streaming: true,
      toolCalling: true,
      vision: true,
      embeddings: false,
      maxContextTokens: 128_000,
    });
  });

  it('chats against the HuggingFace router with an API key', async () => {
    // The exported default providers are singletons, so build an instance with
    // the same config plus an injected fetch to exercise the wire path offline.
    const { fetchImpl, calls } = mockFetch();
    const provider = createOpenAICompatibleProvider({
      id: 'huggingface',
      name: 'HuggingFace',
      baseUrl: 'https://router.huggingface.co/v1',
      defaultModel: 'Qwen/Qwen2.5-72B-Instruct',
      apiKeyEnvVar: 'HF_TOKEN',
      fetchImpl,
    });
    const result = await provider.chat(baseParams, { apiKey: 'hf-test-key' });
    expect(calls[0]!.url).toBe('https://router.huggingface.co/v1/chat/completions');
    expect(calls[0]!.init.headers).toMatchObject({ Authorization: 'Bearer hf-test-key' });
    expect(result.message).toEqual({ role: 'assistant', content: 'ok' });
    expect(result.finishReason).toBe('stop');
    expect(result.usage).toEqual({ inputTokens: 5, outputTokens: 2, totalTokens: 7 });
  });

  it('throws missing-api-key when no HF_TOKEN is set', async () => {
    const saved = process.env.HF_TOKEN;
    delete process.env.HF_TOKEN;
    try {
      const err = await huggingface.chat(baseParams, {}).then(
        () => null,
        (e: unknown) => e,
      );
      expect(err).toBeInstanceOf(ModelHitchError);
      expect((err as ModelHitchError).code).toBe('missing-api-key');
      expect((err as ModelHitchError).message).toContain('HF_TOKEN');
    } finally {
      if (saved !== undefined) process.env.HF_TOKEN = saved;
      else delete process.env.HF_TOKEN;
    }
  });
});
