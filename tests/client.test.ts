import { describe, expect, it } from 'vitest';
import { ModelHitch, MemoryKeyStore } from '../src/index.js';
import type { Provider, ProviderCredentials, StreamChunk } from '../src/index.js';

/** A provider that records what credentials it receives (no network). */
function recordingProvider(id: string, onCredentials: (c: ProviderCredentials) => void): Provider {
  return {
    id,
    name: id,
    defaultModel: 'test-model',
    capabilities: { streaming: false, toolCalling: false, vision: false, embeddings: false },
    async chat(_params, credentials) {
      onCredentials(credentials);
      return { message: { role: 'assistant', content: 'ok' }, finishReason: 'stop' };
    },
    async *stream(): AsyncGenerator<StreamChunk> {},
  };
}

describe('ModelHitch client', () => {
  it('registers OpenCode Zen and Go by default', () => {
    const mh = new ModelHitch();
    expect(mh.provider('opencode-zen').name).toBe('OpenCode Zen');
    expect(mh.provider('opencode-go').name).toBe('OpenCode Go');
    expect(mh.capabilities('opencode-zen').streaming).toBe(true);
  });

  it('throws provider-not-found for unknown ids', () => {
    const mh = new ModelHitch();
    expect(() => mh.provider('nope')).toThrowError(/Unknown provider/);
    expect(() => mh.provider('nope')).toThrowError(
      expect.objectContaining({ code: 'provider-not-found' }),
    );
  });

  it('resolves keys from the keystore', async () => {
    const keystore = new MemoryKeyStore();
    await keystore.set('mock', 'mock-key');
    const mh = new ModelHitch({ keystore });
    // mock provider doesn't use keys, but the resolution path should not throw
    const result = await mh.chat({
      provider: 'mock',
      messages: [{ role: 'user', content: 'hello' }],
    });
    expect(result.message).toEqual({ role: 'assistant', content: 'Mock reply: hello' });
  });

  it('simulates tool calls with the mock provider', async () => {
    const mh = new ModelHitch();
    const result = await mh.chat({
      provider: 'mock',
      messages: [{ role: 'user', content: '!tool get_weather' }],
      tools: [{ name: 'get_weather', description: 'weather', parameters: { type: 'object' } }],
    });
    expect(result.finishReason).toBe('tool-calls');
    expect(result.message).toMatchObject({
      role: 'assistant',
      toolCalls: [{ name: 'get_weather' }],
    });
  });

  it('streams and aggregates', async () => {
    const mh = new ModelHitch();
    const events = [];
    const stream = await mh.stream({
      provider: 'mock',
      messages: [{ role: 'user', content: 'stream me' }],
    });
    for await (const e of stream) events.push(e);
    expect(events.some((e) => e.type === 'text-delta')).toBe(true);
    expect(events.at(-1)).toMatchObject({ type: 'finish', finishReason: 'stop' });

    const full = await mh.streamToResult({
      provider: 'mock',
      messages: [{ role: 'user', content: 'stream me' }],
    });
    expect(full.message).toMatchObject({ role: 'assistant' });
  });

  it('forwards explicit apiKey/baseUrl to the provider', async () => {
    let received: ProviderCredentials | undefined;
    const mh = new ModelHitch({ providers: [recordingProvider('recorder', (c) => (received = c))] });
    await mh.chat({
      provider: 'recorder',
      apiKey: 'sk-x',
      baseUrl: 'http://custom:8080/v1',
      messages: [{ role: 'user', content: 'hi' }],
    });
    expect(received).toEqual({ apiKey: 'sk-x', baseUrl: 'http://custom:8080/v1' });
  });

  it('resolves keys from the keystore when no explicit key is given', async () => {
    let received: ProviderCredentials | undefined;
    const keystore = new MemoryKeyStore();
    await keystore.set('recorder', 'from-keystore');
    const mh = new ModelHitch({ providers: [recordingProvider('recorder', (c) => (received = c))], keystore });
    await mh.chat({ provider: 'recorder', messages: [{ role: 'user', content: 'hi' }] });
    expect(received).toEqual({ apiKey: 'from-keystore' });
  });

  it('uses the provider default model when none is given', async () => {
    let seenModel: string | undefined;
    const provider: Provider = {
      id: 'recorder',
      name: 'recorder',
      defaultModel: 'default-model-42',
      capabilities: { streaming: false, toolCalling: false, vision: false, embeddings: false },
      async chat(params) {
        seenModel = params.model;
        return { message: { role: 'assistant', content: 'ok' }, finishReason: 'stop' };
      },
      async *stream(): AsyncGenerator<StreamChunk> {},
    };
    const mh = new ModelHitch({ providers: [provider] });
    await mh.chat({ provider: 'recorder', messages: [{ role: 'user', content: 'hi' }] });
    expect(seenModel).toBe('default-model-42');
  });
});
