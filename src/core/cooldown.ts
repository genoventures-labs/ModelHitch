import type { FailoverErrorInfo, FailoverTarget, LaneCooldown } from './failover.js';

/**
 * Per-lane cooling.
 *
 * The lane is the meaningful trust object, so cooldowns are keyed by
 * provider/model lane — not just by provider. A 429 on `openai/gpt-5.5`
 * cools that lane; `openai/gpt-5-mini` (or any other provider's lane)
 * remains usable.
 *
 * Milestone 3 (circuit breaker) extends this same interface: consecutive
 * failure thresholds, open/half-open probing. Milestone 1 keeps it
 * strictly failure-event driven: providers tell us how long to cool via
 * Retry-After, and we honor it without sitting and waiting on the call.
 */

export interface MemoryLaneCooldownOptions {
  /** Clock for deterministic tests. Defaults to `Date.now`. */
  now?: () => number;
  /**
   * Cooldown applied when a lane fails without a Retry-After header.
   * Default: 5s — enough to avoid instantly re-walking a just-failed lane
   * without making users "stare at the rate-limit response".
   */
  graceMs?: number;
}

export class MemoryLaneCooldown implements LaneCooldown {
  private readonly now: () => number;
  private readonly graceMs: number;
  private readonly until = new Map<string, number>();

  constructor(options: MemoryLaneCooldownOptions = {}) {
    this.now = options.now ?? (() => Date.now());
    this.graceMs = options.graceMs ?? 5_000;
  }

  cooldownMs(lane: FailoverTarget): number {
    this.sweep();
    const until = this.until.get(key(lane)) ?? 0;
    return Math.max(0, until - this.now());
  }

  cool(lane: FailoverTarget, retryAfterMsOrError?: number | FailoverErrorInfo): void {
    this.sweep();
    const retryAfterMs =
      retryAfterMsOrError === undefined || typeof retryAfterMsOrError === 'number'
        ? retryAfterMsOrError
        : retryAfterMsOrError.retryAfterMs;
    const ms = retryAfterMs !== undefined && retryAfterMs > 0 ? retryAfterMs : this.graceMs;
    this.until.set(key(lane), this.now() + Math.ceil(ms));
  }

  /** A lane succeeded — drop any stale cooldown for it. */
  success(lane: FailoverTarget): void {
    this.until.delete(key(lane));
  }

  clear(): void {
    this.until.clear();
  }

  /** Drop expired entries so the map can't grow without bound for dynamic lane keys. */
  private sweep(): void {
    const t = this.now();
    for (const [k, until] of this.until) {
      if (until <= t) this.until.delete(k);
    }
  }
}

function key(lane: FailoverTarget): string {
  return `${lane.providerId}/${lane.model}`;
}