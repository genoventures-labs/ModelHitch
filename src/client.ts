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
import {
  resolveLanes,
  retryableCodesFor,
  maxAttemptsFor,
  withFailover,
  withFailoverStream,
  type AutoModeOptions,
  type FailoverEvent,
  type FailoverTarget,
} from './core/failover.js';
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
  /**
   * auto-mode: transparent failover when the primary lane errors (429 rate
   * limits, 5xx, network blips). `true` uses the default fallback lineup
   * (cheap Go model, then free Zen models); pass `AutoModeOptions` for custom
   * lanes/models. Keys for fallback lanes resolve from the keystore (or the
   * provider's own env fallback) — per-call `apiKey`/`baseUrl` stay with the
   * primary provider.
   */
  autoMode?: AutoModeOptions | boolean;
  /** Called each time auto-mode switches lanes. */
  onFailover?: (event: FailoverEvent) => void;
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
  readonly autoMode?: AutoModeOptions | boolean;
  readonly onFailover?: (event: FailoverEvent) => void;

  constructor(options: ModelHitchOptions = {}) {
    this.providers = options.providers ?? defaultProviders;
    this.keystore = options.keystore;
    this.defaultProviderId = options.defaultProviderId;
    this.defaultModel = options.defaultModel;
    this.autoMode = options.autoMode;
    this.onFailover = options.onFailover;
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

  /** Ordered lane list: the primary first, then auto-mode fallbacks. */
  private failoverTargets(providerId: string, model: string): FailoverTarget[] {
    return [{ providerId, model }, ...resolveLanes({ providerId, model }, this.autoMode)];
  }

  /** Fallback-lane credentials: keystore only (per-call keys stay primary). */
  private async laneCredentials(providerId: string): Promise<ProviderCredentials> {
    if (this.keystore) {
      const apiKey = await this.keystore.get(providerId);
      if (apiKey) return { apiKey };
    }
    return {};
  }

  private emitFailover(event: FailoverEvent): void {
    this.onFailover?.(event);
  }

  /** Complete (non-streaming) chat call — with optional auto-mode failover. */
  async chat(input: ChatInput, credentialsOverride?: ProviderCredentials): Promise<ChatResult> {
    const provider = this.resolveProvider(input);
    const primaryModel = this.resolveModel(provider, input);
    const params = this.buildParams(input, provider);
    const credentials = credentialsOverride ?? (await this.resolveCredentials(provider, input));
    const targets = this.failoverTargets(provider.id, primaryModel);
    if (targets.length <= 1) return provider.chat(params, credentials);

    const opts = this.autoMode;
    const { value } = await withFailover(
      targets,
      async (target) => {
        if (target.providerId === provider.id && target.model === primaryModel) {
          return provider.chat(params, credentials);
        }
        const laneProvider = this.provider(target.providerId);
        const laneCreds = await this.laneCredentials(target.providerId);
        return laneProvider.chat({ ...params, model: target.model }, laneCreds);
      },
      {
        codes: retryableCodesFor(opts),
        maxAttempts: maxAttemptsFor(opts, targets.length - 1),
        onFailover: (event) => this.emitFailover(event),
      },
    );
    return value;
  }

  /**
   * Streaming chat call — normalized `StreamChunk` events. With auto-mode,
   * failover happens transparently before the first chunk is emitted (a 429
   * on lane 1 restarts on lane 2); lanes that die mid-stream propagate.
   */
  async stream(input: ChatInput, credentialsOverride?: ProviderCredentials): Promise<AsyncIterable<StreamChunk>> {
    const provider = this.resolveProvider(input);
    const primaryModel = this.resolveModel(provider, input);
    const params = this.buildParams(input, provider);
    const credentials = credentialsOverride ?? (await this.resolveCredentials(provider, input));
    const targets = this.failoverTargets(provider.id, primaryModel);
    if (targets.length <= 1) return provider.stream(params, credentials);

    const opts = this.autoMode;
    // Resolve fallback-lane credentials eagerly (they are static per lane and
    // the failover generator needs a synchronous attempt callback).
    const laneCreds = new Map<string, ProviderCredentials>();
    for (const target of targets.slice(1)) {
      if (!laneCreds.has(target.providerId)) {
        laneCreds.set(target.providerId, await this.laneCredentials(target.providerId));
      }
    }
    return withFailoverStream(
      targets,
      (target) => {
        if (target.providerId === provider.id && target.model === primaryModel) {
          return provider.stream(params, credentials);
        }
        return this.provider(target.providerId).stream(
          { ...params, model: target.model },
          laneCreds.get(target.providerId) ?? {},
        );
      },
      {
        codes: retryableCodesFor(opts),
        maxAttempts: maxAttemptsFor(opts, targets.length - 1),
        onFailover: (event) => this.emitFailover(event),
      },
    );
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
