import type { KeyStore } from './core/keystore.js';
import type {
  Capabilities,
  ChatParams,
  ChatResult,
  ProviderCredentials,
  StreamChunk,
} from './core/types.js';
import { ModelHitchError } from './core/errors.js';
import { aggregateStream } from './core/stream.js';
import { defaultProviders } from './registry.js';
import type { ModelInfo, Provider } from './providers/types.js';

export interface ModelHitchOptions {
  /** Providers to use. Defaults to the built-in set. */
  providers?: Provider[];
  /** Where end-user API keys live (optional — pass keys per-call instead). */
  keystore?: KeyStore;
  /** Default provider used when calls don't specify one. */
  defaultProviderId?: string;
  /** Default model used when calls don't specify one (falls back to provider default). */
  defaultModel?: string;
}

export type ChatInput = Omit<ChatParams, 'model'> & {
  /** Model id; defaults to the client's `defaultModel` or the provider default. */
  model?: string;
  /** Provider id, e.g. "opencode-zen" or "anthropic". */
  provider?: string;
  /** Explicit credentials for this call (overrides the keystore). */
  apiKey?: string;
  baseUrl?: string;
};

/**
 * ModelHitch — the BYOK integration layer.
 *
 * ```ts
 * const mh = new ModelHitch({ keystore: myKeyStore });
 * const result = await mh.chat({ provider: 'opencode-zen', messages: [{ role: 'user', content: 'hi' }] });
 * ```
 */
export class ModelHitch {
  readonly providers: Provider[];
  readonly keystore?: KeyStore;
  readonly defaultProviderId?: string;
  readonly defaultModel?: string;

  constructor(options: ModelHitchOptions = {}) {
    this.providers = options.providers ?? defaultProviders;
    this.keystore = options.keystore;
    this.defaultProviderId = options.defaultProviderId;
    this.defaultModel = options.defaultModel;
  }

  /** Look up a provider by id. Throws `provider-not-found` if unknown. */
  provider(id: string): Provider {
    const p = this.providers.find((p) => p.id === id);
    if (!p) {
      const known = this.providers.map((p) => p.id).join(', ');
      throw new ModelHitchError('provider-not-found', `Unknown provider "${id}". Available: ${known}`, {
        providerId: id,
      });
    }
    return p;
  }

  private resolveProvider(input: ChatInput): Provider {
    const id = input.provider ?? this.defaultProviderId ?? this.providers[0]?.id;
    if (!id) throw new ModelHitchError('provider-not-found', 'No providers registered.', {});
    return this.provider(id);
  }

  private resolveModel(provider: Provider, input: ChatInput): string {
    return input.model ?? this.defaultModel ?? provider.defaultModel;
  }

  /** Resolve credentials: explicit > keystore > (adapter env var fallback). */
  private async resolveCredentials(
    provider: Provider,
    input: ChatInput,
  ): Promise<ProviderCredentials> {
    const explicit: ProviderCredentials = {};
    if (input.apiKey) explicit.apiKey = input.apiKey;
    if (input.baseUrl) explicit.baseUrl = input.baseUrl;
    if (explicit.apiKey || explicit.baseUrl) return explicit;
    if (this.keystore) {
      const apiKey = await this.keystore.get(provider.id);
      if (apiKey) return { apiKey };
    }
    return {};
  }

  private buildParams(input: ChatInput, provider: Provider): ChatParams {
    const { provider: _p, apiKey: _k, baseUrl: _b, model, ...rest } = input;
    return { ...rest, model: this.resolveModel(provider, input) };
  }

  /** Complete (non-streaming) chat call. */
  async chat(input: ChatInput, credentialsOverride?: ProviderCredentials): Promise<ChatResult> {
    const provider = this.resolveProvider(input);
    const params = this.buildParams(input, provider);
    const credentials = credentialsOverride ?? (await this.resolveCredentials(provider, input));
    return provider.chat(params, credentials);
  }

  /** Streaming chat call — normalized `StreamChunk` events. */
  async stream(input: ChatInput, credentialsOverride?: ProviderCredentials): Promise<AsyncIterable<StreamChunk>> {
    const provider = this.resolveProvider(input);
    const params = this.buildParams(input, provider);
    const credentials = credentialsOverride ?? (await this.resolveCredentials(provider, input));
    return provider.stream(params, credentials);
  }

  /** Convenience: consume a stream and return the full aggregated result. */
  async streamToResult(input: ChatInput, credentialsOverride?: ProviderCredentials): Promise<ChatResult> {
    const iterable = await this.stream(input, credentialsOverride);
    return aggregateStream(iterable);
  }

  /** Capabilities of a provider (streaming? tool calling? vision?). */
  capabilities(providerId: string): Capabilities {
    return this.provider(providerId).capabilities;
  }

  /** Fetch the models a provider offers, if it supports discovery. */
  async listModels(
    providerId: string,
    credentialsOverride?: ProviderCredentials,
  ): Promise<ModelInfo[]> {
    const provider = this.provider(providerId);
    if (!provider.listModels) {
      throw new ModelHitchError(
        'provider-error',
        `Provider "${providerId}" does not support model listing.`,
        { providerId },
      );
    }
    const credentials =
      credentialsOverride ??
      (this.keystore ? { apiKey: (await this.keystore.get(providerId)) ?? undefined } : {});
    return provider.listModels(credentials);
  }
}
