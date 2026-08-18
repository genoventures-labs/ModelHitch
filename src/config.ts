import type { CircuitBreakerOptions } from './core/circuit-breaker.js';
import type { MemoryLaneCooldownOptions } from './core/cooldown.js';
import type { LaneCooldown } from './core/failover.js';
import type { Policy, ProviderSource } from './core/policy.js';
import { validatePolicy } from './core/policy.js';
import { CircuitBreaker } from './core/circuit-breaker.js';
import { MemoryLaneCooldown } from './core/cooldown.js';
import type { CatalogSourceOptions } from './catalog/source.js';

/**
 * Milestone 5 — the serializable settings surface.
 *
 * `ModelHitchConfig` is the single local config document the settings UI
 * reads and writes. Everything here is plain JSON data; nothing imports
 * `node:*` (browser-safe). File I/O lives in `src/config-file.ts` (Node-only).
 *
 * The config separates WHAT the user configures from HOW the runtime is
 * built:
 * - `policy` — the trusted/fallback lane plan (JSON-safe from M1).
 * - `catalog` — the serializable subset of `CatalogSourceOptions`
 *   (`providers` = the allowlist picker, `baseUrls`, `baseUrl`, `ttlMs`).
 *   Runtime injectables (client, fetch, capabilities) are never serialized.
 * - `cooldown` — a JSON discriminator for the lane-health engine instead of
 *   a runtime instance.
 * - `keys` — per-provider API keys, persisted here so nothing requires
 *   digging through env vars; masked in every read API and in the UI.
 */

export interface CatalogConfig {
  /** Catalog provider allowlist — the "pick your providers" knob. */
  providers?: string[];
  /** BYO base URLs for catalog providers that lack a models.dev `api`. */
  baseUrls?: Record<string, string>;
  /** models.dev base URL (default "https://models.dev"). */
  baseUrl?: string;
  /** Catalog cache lifetime in ms (default 1h). */
  ttlMs?: number;
}

export type CooldownConfig =
  | ({ type: 'circuit-breaker' } & CircuitBreakerOptions)
  | ({ type: 'memory' } & MemoryLaneCooldownOptions);

export interface ModelHitchConfig {
  /** Document version — currently 1. */
  version: 1;
  /** Default provider for bare model ids / requests without a provider. */
  defaultProviderId?: string;
  /** Default model when requests omit one. */
  defaultModel?: string;
  /** Trusted + fallback lane plan. */
  policy?: Policy;
  /** models.dev catalog mode (serializable subset). */
  catalog?: CatalogConfig;
  /** Lane-health engine: circuit breaker or memory cooldown. */
  cooldown?: CooldownConfig;
  /** Per-provider API keys. Persisted locally; masked on read. */
  keys?: Record<string, string>;
}

export interface ConfigValidation {
  errors: string[];
  warnings: string[];
}

export const CONFIG_VERSION = 1 as const;

/** A config with every secret value replaced by a masked hint. */
export interface MaskedConfig extends Omit<ModelHitchConfig, 'keys'> {
  keys?: Record<string, string>;
  _masked?: true;
}

/** `sk-abc123xyz` -> `••••••xyz` (keep the last 4 chars as a fingerprint). */
export function maskSecret(value: string): string {
  if (!value) return '';
  if (value.length <= 4) return '••••';
  return `••••••${value.slice(-4)}`;
}

/**
 * True when `value` looks like a masked placeholder we produced (and therefore
 * must never be persisted back as a real key). Protects the settings flow when
 * a client echoes a masked value back to the server.
 */
export function isMaskedSecret(value: string): boolean {
  return typeof value === 'string' && value.includes('••');
}

/** Deep-masked copy of the config for reads/UI (keys never leave the daemon). */
export function serializeConfig(config: ModelHitchConfig, opts: { maskSecrets?: boolean } = {}): ModelHitchConfig | MaskedConfig {
  if (!opts.maskSecrets) return JSON.parse(JSON.stringify(config)) as ModelHitchConfig;
  const { keys, ...rest } = config;
  const masked: MaskedConfig = { ...JSON.parse(JSON.stringify(rest)), _masked: true };
  if (keys) {
    const maskedKeys: Record<string, string> = {};
    for (const [providerId, value] of Object.entries(keys)) {
      maskedKeys[providerId] = maskSecret(value);
    }
    masked.keys = maskedKeys;
  }
  return masked;
}

/**
 * Structural validation only (types, shapes, discriminator, version). Full
 * provider-existence validation of `policy` happens at load time against the
 * real warmed source (registry or catalog) — see `ModelHitch.create()` /
 * the daemon bootstrap.
 */
export function validateConfig(config: unknown): ConfigValidation {
  const errors: string[] = [];
  const warnings: string[] = [];
  if (!config || typeof config !== 'object') {
    return { errors: ['Config must be an object.'], warnings };
  }
  const cfg = config as Partial<ModelHitchConfig>;

  if (cfg.version !== undefined && cfg.version !== CONFIG_VERSION) {
    errors.push(`Unsupported config version "${String(cfg.version)}" — this build expects version ${CONFIG_VERSION}.`);
  }

  if (cfg.defaultProviderId !== undefined && (typeof cfg.defaultProviderId !== 'string' || !cfg.defaultProviderId)) {
    errors.push('defaultProviderId must be a non-empty string.');
  }
  if (cfg.defaultModel !== undefined && (typeof cfg.defaultModel !== 'string' || !cfg.defaultModel)) {
    errors.push('defaultModel must be a non-empty string.');
  }

  if (cfg.policy !== undefined) {
    if (!cfg.policy || typeof cfg.policy !== 'object' || !Array.isArray(cfg.policy.trusted) || !Array.isArray(cfg.policy.fallback)) {
      errors.push('policy must have trusted[] and fallback[] arrays.');
    } else if (cfg.policy.trusted.length === 0 && cfg.policy.fallback.length === 0) {
      errors.push('policy must have at least one entry in trusted or fallback.');
    }
    if (cfg.policy?.maxProviders !== undefined && (!Number.isInteger(cfg.policy.maxProviders) || cfg.policy.maxProviders < 1)) {
      errors.push('policy.maxProviders must be a positive integer.');
    }
    if (cfg.policy?.backoff !== undefined) {
      const b = cfg.policy.backoff;
      if (b.type !== 'fixed' && b.type !== 'exponential') errors.push('policy.backoff.type must be "fixed" or "exponential".');
      if (typeof b.baseMs !== 'number' || b.baseMs < 0) errors.push('policy.backoff.baseMs must be a non-negative number.');
    }
  }

  if (cfg.catalog !== undefined) {
    const c = cfg.catalog;
    if (!c || typeof c !== 'object') {
      errors.push('catalog must be an object.');
    } else {
      if (c.providers !== undefined && (!Array.isArray(c.providers) || c.providers.some((p) => typeof p !== 'string'))) {
        errors.push('catalog.providers must be an array of provider ids.');
      }
      if (c.baseUrls !== undefined && (!c.baseUrls || typeof c.baseUrls !== 'object')) {
        errors.push('catalog.baseUrls must be an object of providerId -> base URL.');
      }
      if (c.ttlMs !== undefined && (!Number.isInteger(c.ttlMs) || c.ttlMs < 0)) {
        errors.push('catalog.ttlMs must be a non-negative integer.');
      }
    }
  }

  if (cfg.cooldown !== undefined) {
    const c = cfg.cooldown;
    if (!c || typeof c !== 'object' || (c.type !== 'circuit-breaker' && c.type !== 'memory')) {
      errors.push('cooldown must be { type: "circuit-breaker" | "memory", ... }.');
    } else {
      if (c.type === 'circuit-breaker') {
        if (c.failureThreshold !== undefined && (!Number.isInteger(c.failureThreshold) || c.failureThreshold < 1)) {
          errors.push('cooldown.failureThreshold must be a positive integer.');
        }
        for (const field of ['baseTripMs', 'maxTripMs', 'graceMs'] as const) {
          if (c[field] !== undefined && (typeof c[field] !== 'number' || c[field] < 0)) {
            errors.push(`cooldown.${field} must be a non-negative number.`);
          }
        }
        if (c.maxTripMs !== undefined && c.baseTripMs !== undefined && c.maxTripMs < c.baseTripMs) {
          errors.push('cooldown.maxTripMs must be >= cooldown.baseTripMs.');
        }
      }
    }
  }

  if (cfg.keys !== undefined && (!cfg.keys || typeof cfg.keys !== 'object')) {
    errors.push('keys must be an object of providerId -> API key.');
  }

  return { errors, warnings };
}

/** Build the runtime cooldown engine from the serializable config. */
export function buildCooldownFromConfig(config: Pick<ModelHitchConfig, 'cooldown'>): LaneCooldown | undefined {
  const c = config.cooldown;
  if (!c) return undefined;
  if (c.type === 'circuit-breaker') {
    const { type: _t, ...options } = c;
    return new CircuitBreaker(options);
  }
  const { type: _t, ...options } = c;
  return new MemoryLaneCooldown(options);
}

/** Build the serializable catalog subset into `CatalogSourceOptions`. */
export function buildCatalogOptions(config: Pick<ModelHitchConfig, 'catalog'>): CatalogSourceOptions | undefined {
  const c = config.catalog;
  if (!c) return undefined;
  const options: CatalogSourceOptions = {};
  if (c.providers !== undefined) options.allow = c.providers;
  if (c.baseUrls !== undefined) options.baseUrls = c.baseUrls;
  if (c.baseUrl !== undefined) options.baseUrl = c.baseUrl;
  if (c.ttlMs !== undefined) options.ttlMs = c.ttlMs;
  return options;
}

/** Effective policy: config policy, or undefined (autoMode path). */
export function policyFromConfig(config: ModelHitchConfig): Policy | undefined {
  return config.policy;
}

/** Structural + (when a source is available) provider-aware policy validation. */
export function validateConfigWithSource(
  config: ModelHitchConfig,
  source?: ProviderSource,
): ConfigValidation {
  const base = validateConfig(config);
  if (source && config.policy) {
    const policy = validatePolicy(config.policy, source);
    base.errors.push(...policy.errors);
    base.warnings.push(...policy.warnings);
  }
  return base;
}