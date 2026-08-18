import { describe, expect, it } from 'vitest';
import {
  CircuitBreaker,
  ModelHitch,
  MemoryKeyStore,
  createCatalogSource,
  type CatalogSource,
  type Provider,
  type FailoverTarget,
} from '../src/index.js';

// --- fixtures ---------------------------------------------------------------

const fixtureApiJson = {
  openai: {
    id: 'openai',
    env: ['OPENAI_API_KEY'],
    npm: '@ai-sdk/openai',
    name: 'OpenAI',
    doc: '',
    models: {
      'gpt-5.5': {
        id: 'gpt-5.5',
        name: 'GPT-5.5',
        description: '',
        attachment: false,
        reasoning: true,
        tool_call: true,
        release_date: '2026-01-01',
        last_updated: '2026-01-01',
        modalities: { input: ['text'], output: ['text'] },
        open_weights: false,
        limit: { context: 128000, output: 16000 },
        cost: { input: 1, output: 5 },
      },
    },
  },
  neoncortex: {
    id: 'neoncortex',
    env: ['NEON_API_KEY'],
    npm: '@ai-sdk/neoncortex',
    name: 'Neon Cortex',
    api: 'https://api.neoncortex.dev/v1',
    doc: '',
    models: {
      'nc-1': {
        id: 'nc-1',
        name: 'NC-1',
        description: '',
        attachment: false,
        reasoning: false,
        tool_call: true,
        release_date: '2026-01-01',
        last_updated: '2026-01-01',
        modalities: { input: ['text'], output: ['text'] },
        open_weights: false,
        limit: { context: 64000, output: 8000 },
        cost: { input: 0.5, output: 1 },
      },
      'org/slash-model': {
        id: 'org/slash-model',
        name: 'Slash',
        description: '',
        attachment: false,
        reasoning: false,
        tool_call: false,
        release_date: '2026-01-01',
        last_updated: '2026-01-01',
        modalities: { input: ['text'], output: ['text'] },
        open_weights: false,
        limit: { context: 16000, output: 4000 },
        cost: undefined,
      },
    },
  },
  zephyr: {
    id: 'zephyr',
    env: ['ZEPHYR_API_KEY'],
    npm: '@ai-sdk/zephyr',
    name: 'Zephyr',
    api: 'https://api.zephyr.dev/v2',
    doc: '',
    models: {
      'z-1': {
        id: 'z-1',
        name: 'Z-1',
        description: '',
        attachment: false,
        reasoning: false,
        tool_call: true,
        release_date: '2026-01-01',
        last_updated: '2026-01-01',
        modalities: { input: ['text'], output: ['text'] },
        open_weights: false,
        limit: { context: 32000, output: 4000 },
        cost: { input: 0.1, output: 0.4 },
      },
    },
  },
  ghostbits: {
    // Deliberately NO `api` — metadata-only, not directly callable.
    id: 'ghostbits',
    env: ['GHOST_API_KEY'],
    npm: '@ai-sdk/ghostbits',
    name: 'Ghost Bits',
    doc: '',
    models: {
      'gb-1': {
        id: 'gb-1',
        name: 'GB-1',
        description: '',
        attachment: false,
        reasoning: true,
        tool_call: true,
        release_date: '2026-01-01',
        last_updated: '2026-01-01',
        modalities: { input: ['text'], output: ['text'] },
        open_weights: false,
        limit: { context: 128000, output: 8000 },
        cost: { input: 2, output: 8 },
      },
    },
  },
  depo: {
    // Deprecated model listed FIRST — the default must still pick the GA one.
    id: 'depo',
    env: ['DEPO_API_KEY'],
    npm: '@ai-sdk/depo',
    name: 'Depo',
    api: 'https://api.depo.dev/v1',
    doc: '',
    models: {
      'legacy-1': {
        id: 'legacy-1',
        name: 'Legacy',
        description: '',
        attachment: false,
        reasoning: false,
        tool_call: false,
        release_date: '2024-01-01',
        last_updated: '2024-01-01',
        modalities: { input: ['text'], output: ['text'] },
        open_weights: false,
        limit: { context: 4000, output: 0 },
        status: 'deprecated',
        cost: { input: 1, output: 2 },
      },
      'ga-1': {
        id: 'ga-1',
        name: 'GA-1',
        description: '',
        attachment: false,
        reasoning: true,
        tool_call: true,
        release_date: '2026-02-01',
        last_updated: '2026-02-01',
        modalities: { input: ['text'], output: ['text'] },
        open_weights: false,
        limit: { context: 96000, output: 12000 },
        cost: { input: 0.5, output: 2 },
      },
    },
  },
};

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

/** Stub fetch: serves the catalog fixture and routes chat calls per provider. */
function makeStubFetch() {
  const calls: string[] = [];
  const stub = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    calls.push(url);
    if (url.endsWith('/api.json')) return jsonResponse(fixtureApiJson);
    if (url.includes('/chat/completions')) {
      const body = JSON.parse(String(init?.body ?? '{}')) as { model?: string };
      if (url.includes('neoncortex')) {
        // Deterministic 429 with Retry-After — the failover trigger.
        return jsonResponse({ error: { message: 'rate limited, chill' } }, 429, { 'retry-after': '30' });
      }
      const model = body.model ?? 'unknown';
      return jsonResponse({
        id: 'chatcmpl-test',
        object: 'chat.completion',
        choices: [{ index: 0, message: { role: 'assistant', content: `ok-${model}` }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 },
      });
    }
    return jsonResponse({ error: 'not found' }, 404);
  }) as typeof fetch;
  return { stub, calls };
}

/** Minimal curated registry — openai overlaps the catalog to test precedence. */
const registryProviders: Provider[] = [
  {
    id: 'openai',
    name: 'OpenAI Registry Adapter',
    defaultModel: 'gpt-4o-mini',
    capabilities: { streaming: true, toolCalling: true, vision: true, embeddings: false },
    chat: async () => ({ message: { role: 'assistant', content: 'registry-openai' }, finishReason: 'stop' }),
    stream: async function* () {
      yield { type: 'finish', finishReason: 'stop' };
    },
  },
];

// --- tests ------------------------------------------------------------------

describe('createCatalogSource', () => {
  it('refuses providers() before warm()', () => {
    const src = createCatalogSource({ registry: registryProviders, fetch: async () => jsonResponse({}) }) as CatalogSource;
    expect(() => src.providers()).toThrow(/not been warmed/);
  });

  it('warms and merges: registry wins on overlap, catalog-built fill the rest', async () => {
    const { stub } = makeStubFetch();
    const src = createCatalogSource({ registry: registryProviders, fetch: stub }) as CatalogSource;
    await src.warm();

    expect(src.warmed).toBe(true);
    // Registry provider wins for the overlapping id.
    expect(src.lookup('openai')?.defaultModel).toBe('gpt-4o-mini');
    expect(src.usability('openai')).toBe('registry');
    // ...but the catalog still supplies the model inventory.
    expect(src.modelsFor('openai')).toEqual(['gpt-5.5']);
    // Catalog-only provider with an api URL gets an auto-built adapter.
    expect(src.lookup('neoncortex')?.defaultModel).toBe('nc-1');
    expect(src.usability('neoncortex')).toBe('built');
    expect(src.modelsFor('neoncortex')).toEqual(['nc-1', 'org/slash-model']);
    // Metadata-only provider: known, enumerated, but NOT callable.
    expect(src.metadata('ghostbits')?.models.map((m) => m.id)).toEqual(['gb-1']);
    expect(src.lookup('ghostbits')).toBeUndefined();
    expect(src.usability('ghostbits')).toBe('metadata-only');
    expect(src.usabilityReason('ghostbits') ?? '').toMatch(/baseUrls/);
    expect(src.modelsFor('ghostbits')).toEqual(['gb-1']);
  });

  it('preserves registry order (registry providers first)', async () => {
    const { stub } = makeStubFetch();
    const src = createCatalogSource({ registry: registryProviders, fetch: stub }) as CatalogSource;
    await src.warm();
    const ids = src.providers().map((p) => p.id);
    expect(ids[0]).toBe('openai'); // registry position
  });

  it('honors the allowlist for catalog-only providers (registry unaffected)', async () => {
    const { stub } = makeStubFetch();
    const src = createCatalogSource({ registry: registryProviders, fetch: stub, allow: ['neoncortex'] }) as CatalogSource;
    await src.warm();
    expect(src.lookup('openai')).toBeDefined();
    expect(src.lookup('neoncortex')).toBeDefined();
    expect(src.lookup('zephyr')).toBeUndefined();
    expect(src.usabilityReason('zephyr') ?? '').toMatch(/allowlist/);
  });

  it('makes metadata-only providers callable via baseUrls', async () => {
    const { stub } = makeStubFetch();
    const src = createCatalogSource({
      registry: registryProviders,
      fetch: stub,
      baseUrls: { ghostbits: 'https://ghost.example/v1' },
    }) as CatalogSource;
    await src.warm();
    expect(src.lookup('ghostbits')?.defaultModel).toBe('gb-1');
    expect(src.usability('ghostbits')).toBe('built');
  });

  it('picks a non-deprecated chat-like default over raw insertion order', async () => {
    const { stub } = makeStubFetch();
    const src = createCatalogSource({ registry: registryProviders, fetch: stub }) as CatalogSource;
    await src.warm();
    // legacy-1 comes first in the fixture but is deprecated with maxOutput 0.
    expect(src.lookup('depo')?.defaultModel).toBe('ga-1');
  });

  it('serves registry-only providers not present in the catalog', async () => {
    const { stub } = makeStubFetch();
    const withPrivate = [...registryProviders, {
      id: 'corp-private',
      name: 'Corp Private',
      defaultModel: 'internal-1',
      capabilities: { streaming: true, toolCalling: true, vision: false, embeddings: false },
      chat: async () => ({ message: { role: 'assistant', content: 'private' }, finishReason: 'stop' }),
      stream: async function* () {
        yield { type: 'finish', finishReason: 'stop' };
      },
    }] as Provider[];
    const src = createCatalogSource({ registry: withPrivate, fetch: stub }) as CatalogSource;
    await src.warm();
    expect(src.lookup('corp-private')?.defaultModel).toBe('internal-1');
    expect(src.usability('corp-private')).toBe('registry');
    // No catalog inventory for a provider models.dev doesn't know about.
    expect(src.modelsFor('corp-private')).toBeUndefined();
  });
});

describe('ModelHitch catalog mode', () => {
  it('direct construction with catalog throws and points to create()', async () => {
    expect(
      () => new ModelHitch({ providers: registryProviders, catalog: {} }),
    ).toThrow(/ModelHitch\.create\(\)/);
  });

  it('create() without catalog behaves like the sync constructor', async () => {
    const mh = await ModelHitch.create({ providers: registryProviders });
    expect(mh).toBeInstanceOf(ModelHitch);
    expect(mh.providers).toHaveLength(1);
  });

  it('catalog policy mode defaults to the CircuitBreaker', async () => {
    const { stub } = makeStubFetch();
    const mh = await ModelHitch.create({
      providers: registryProviders,
      catalog: { fetch: stub },
      policy: { trusted: [{ providerId: 'openai' }], fallback: [] },
    });
    expect(mh.cooldown).toBeInstanceOf(CircuitBreaker);
    // Health snapshot is reachable for the settings UI.
    expect(mh.cooldown as CircuitBreaker).toBeInstanceOf(CircuitBreaker);
    expect((mh.cooldown as CircuitBreaker).snapshot()).toEqual([]);
  });

  it('routes through policy lanes: 429 on the trusted lane fails over to the fallback catalog provider', async () => {
    const { stub, calls } = makeStubFetch();
    const keystore = new MemoryKeyStore();
    await keystore.set('neoncortex', 'key-1');
    await keystore.set('zephyr', 'key-2');

    const mh = await ModelHitch.create({
      providers: registryProviders,
      keystore,
      catalog: { fetch: stub, adapterFetch: stub },
      policy: {
        trusted: [{ providerId: 'neoncortex', models: ['nc-1'] }],
        fallback: [{ providerId: 'zephyr', models: ['z-1'] }],
      },
    });

    expect(mh.catalogSource).toBeDefined();
    // Explicit primary = neoncortex (the non-registry, catalog-built lane).
    const result = await mh.chat({
      provider: 'neoncortex',
      model: 'nc-1',
      messages: [{ role: 'user', content: 'hi' }],
    });
    expect(result.message.content).toBe('ok-z-1');

    // Both lanes were actually hit over the stub transport.
    expect(calls.some((u) => u.includes('neoncortex') && u.includes('/chat/completions'))).toBe(true);
    expect(calls.some((u) => u.includes('zephyr') && u.includes('/chat/completions'))).toBe(true);
    // The 429'd trusted lane is cooled (Retry-After honored via adapter).
    expect(mh.cooldown?.cooldownMs({ providerId: 'neoncortex', model: 'nc-1' })).toBeGreaterThan(0);
    // Lane health is visible to the settings UI: the failed lane is open, the
    // successful fallback lane shows closed.
    expect(mh.laneHealth).toHaveLength(2);
    expect(mh.laneHealth.find((l) => l.providerId === 'neoncortex')).toMatchObject({
      providerId: 'neoncortex',
      model: 'nc-1',
      state: 'open',
    });
    expect(mh.laneHealth.find((l) => l.providerId === 'zephyr')?.state).toBe('closed');
  });

  it('surfaces actionable errors for metadata-only providers in policy', async () => {
    const { stub } = makeStubFetch();
    await expect(
      ModelHitch.create({
        providers: registryProviders,
        catalog: { fetch: stub },
        policy: { trusted: [{ providerId: 'ghostbits', models: ['gb-1'] }], fallback: [] },
      }),
    ).rejects.toThrow(/in the models\.dev catalog but not callable yet: has no API base URL/);
  });

  it('keeps working for providers NOT present in the catalog (registry-only policy)', async () => {
    const { stub } = makeStubFetch();
    const mh = await ModelHitch.create({
      providers: registryProviders,
      catalog: { fetch: stub },
      policy: { trusted: [{ providerId: 'openai', models: ['gpt-4o-mini'] }], fallback: [] },
    });
    const result = await mh.chat({ messages: [{ role: 'user', content: 'hi' }] });
    expect(result.message.content).toBe('registry-openai'); // used the curated adapter
  });

  it('exposes catalog metadata for inspection via catalogSource', async () => {
    const { stub } = makeStubFetch();
    const mh = await ModelHitch.create({
      providers: registryProviders,
      catalog: { fetch: stub },
      policy: { trusted: [{ providerId: 'openai' }], fallback: [] },
    });
    const meta = mh.catalogSource?.metadata('ghostbits');
    expect(meta?.id).toBe('ghostbits');
    expect(meta?.models[0]?.inputCostPer1M).toBe(2);
    expect(mh.catalogSource?.catalogIds().sort()).toEqual([
      'depo',
      'ghostbits',
      'neoncortex',
      'openai',
      'zephyr',
    ]);
  });

  it('wraps catalog fetch failures into ModelHitchError (network-error)', async () => {
    const failingFetch = (async () => {
      throw new Error('ECONNREFUSED models.dev');
    }) as typeof fetch;
    await expect(
      ModelHitch.create({
        providers: registryProviders,
        catalog: { fetch: failingFetch },
        policy: { trusted: [{ providerId: 'openai' }], fallback: [] },
      }),
    ).rejects.toMatchObject({ code: 'network-error', message: expect.stringContaining('models.dev catalog') });
  });

  it('leaves unknown-provider errors unchanged (no "not callable yet" rewording)', async () => {
    const { stub } = makeStubFetch();
    await expect(
      ModelHitch.create({
        providers: registryProviders,
        catalog: { fetch: stub },
        policy: { trusted: [{ providerId: 'totally-made-up-provider' }], fallback: [] },
      }),
    ).rejects.toThrow(/unknown provider "totally-made-up-provider"/);
    await expect(
      ModelHitch.create({
        providers: registryProviders,
        catalog: { fetch: stub },
        policy: { trusted: [{ providerId: 'totally-made-up-provider' }], fallback: [] },
      }),
    ).rejects.not.toThrow(/not callable yet/);
  });
});

// Keep the FailoverTarget import referenced (typed smoke checks in one place).
void (null as FailoverTarget | null);