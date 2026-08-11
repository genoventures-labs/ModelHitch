import { ModelHitchError, type ModelHitchErrorCode } from './errors.js';

/**
 * auto-mode — transparent failover when a provider lane errors.
 *
 * Detection matches both the normalized `code` and the raw HTTP status:
 * - `rate-limited` (HTTP 429 — OpenCode Zen/Go usage-limit blocks)
 * - `provider-error` (5xx gateway blips)
 * - `network-error` (transient connectivity failures)
 * - **any** error carrying `status === 429`, regardless of code — the
 *   Anthropic streaming adapter currently surfaces 429s as `bad-request`
 *   with the status preserved.
 *
 * Aborts and user cancellations are not `ModelHitchError`s, so they are never
 * retried. Failover only happens *before* content is emitted — a lane that
 * dies mid-stream propagates its error instead of duplicating output.
 */

export interface FailoverTarget {
  providerId: string;
  model: string;
}

export interface FailoverErrorInfo {
  code: ModelHitchErrorCode | 'unknown';
  message: string;
  status?: number;
}

export interface FailoverEvent {
  /** ISO timestamp. */
  at: string;
  /** The lane that failed. */
  from: FailoverTarget;
  /** The lane that took over. */
  to: FailoverTarget;
  error: FailoverErrorInfo;
  /** 0-based index of the lane that took over (1 = first fallback). */
  attempt: number;
}

export interface AutoModeOptions {
  /** Ordered fallback provider/model lanes, tried after the primary fails. */
  lanes?: FailoverTarget[];
  /** Same-provider fallback models, tried before `lanes`. */
  models?: string[];
  /** Error codes that trigger failover (HTTP 429 always triggers regardless). Default: rate-limited, provider-error, network-error. */
  retryableCodes?: ModelHitchErrorCode[];
  /** Total attempts including the primary. Default: 1 + fallback lane count. */
  maxAttempts?: number;
  /** Called each time a lane takes over. */
  onFailover?: (event: FailoverEvent) => void;
}

export const DEFAULT_RETRYABLE_CODES: ModelHitchErrorCode[] = [
  'rate-limited',
  'provider-error',
  'network-error',
];

/**
 * The default fallback lineup, chosen to survive the OpenCode usage limits
 * documented at https://opencode.ai/docs/go:
 *
 * - `opencode-go/deepseek-v4-flash` — the cheapest Go subscription model with
 *   the largest included allowance (~31k requests/5h), still inside the
 *   $12/5h usage limit. Costs nothing beyond the Go subscription.
 * - Free Zen models keep working after the paid limits are exhausted, so they
 *   are the final safety net.
 *
 * Lanes without configured credentials (missing/invalid key) are skipped
 * automatically; lanes duplicate of the primary are deduped.
 */
export const DEFAULT_FAILOVER_LANES: FailoverTarget[] = [
  { providerId: 'opencode-go', model: 'deepseek-v4-flash' },
  { providerId: 'opencode-zen', model: 'big-pickle' },
  { providerId: 'opencode-zen', model: 'deepseek-v4-flash-free' },
  { providerId: 'opencode-zen', model: 'mimo-v2.5-free' },
];

/** True when the error should trigger a failover to the next lane. */
export function isRetryableError(
  err: unknown,
  codes: readonly ModelHitchErrorCode[] = DEFAULT_RETRYABLE_CODES,
): boolean {
  if (!(err instanceof ModelHitchError)) return false;
  if (err.status === 429) return true;
  return codes.includes(err.code);
}

/** True when a lane simply has no working key — skip it silently. */
export function isCredentialError(err: unknown): boolean {
  return (
    err instanceof ModelHitchError &&
    (err.code === 'missing-api-key' || err.code === 'invalid-api-key')
  );
}

export function errorInfo(err: unknown): FailoverErrorInfo {
  if (err instanceof ModelHitchError) return { code: err.code, message: err.message, status: err.status };
  if (err instanceof Error) return { code: 'unknown', message: err.message };
  return { code: 'unknown', message: String(err) };
}

/** Build the ordered, deduped fallback lane list for a primary provider/model. */
export function resolveLanes(
  primary: FailoverTarget,
  opts: AutoModeOptions | boolean | undefined,
): FailoverTarget[] {
  if (!opts) return [];
  const options = opts === true ? {} : opts;
  const lanes: FailoverTarget[] = [];
  const seen = new Set<string>([`${primary.providerId}/${primary.model}`]);
  const push = (t: FailoverTarget) => {
    const key = `${t.providerId}/${t.model}`;
    if (seen.has(key)) return;
    seen.add(key);
    lanes.push(t);
  };
  if (options.models) for (const model of options.models) push({ providerId: primary.providerId, model });
  if (options.lanes) for (const lane of options.lanes) push(lane);
  // Explicit lanes/models win; defaults apply only when neither is configured.
  if (!options.models && !options.lanes) for (const lane of DEFAULT_FAILOVER_LANES) push(lane);
  return lanes;
}

export function retryableCodesFor(opts: AutoModeOptions | boolean | undefined): ModelHitchErrorCode[] {
  if (!opts) return [];
  return opts === true ? [...DEFAULT_RETRYABLE_CODES] : [...(opts.retryableCodes ?? DEFAULT_RETRYABLE_CODES)];
}

/** Total attempts (primary + lanes) honoring an explicit cap. */
export function maxAttemptsFor(opts: AutoModeOptions | boolean | undefined, laneCount: number): number {
  if (!opts) return 1;
  return opts === true ? laneCount + 1 : (opts.maxAttempts ?? laneCount + 1);
}

export interface FailoverContext {
  codes?: readonly ModelHitchErrorCode[];
  maxAttempts?: number;
  onFailover?: (event: FailoverEvent) => void;
}

/**
 * Non-stream: try each target until one resolves. If every lane fails without
 * producing a result, the FIRST error is rethrown — that's the lane the user
 * actually configured, and it's the actionable one (e.g. the original 429).
 */
export async function withFailover<T, L extends FailoverTarget>(
  targets: L[],
  attempt: (target: L) => Promise<T>,
  ctx: FailoverContext = {},
): Promise<{ value: T; target: L }> {
  const codes = ctx.codes ?? DEFAULT_RETRYABLE_CODES;
  const maxAttempts = ctx.maxAttempts ?? targets.length;
  let firstError: unknown;
  for (let i = 0; i < targets.length && i < maxAttempts; i++) {
    const target = targets[i]!;
    try {
      return { value: await attempt(target), target };
    } catch (err) {
      if (i >= targets.length - 1 || i >= maxAttempts - 1) throw firstError ?? err;
      if (isCredentialError(err)) continue; // no key for this lane — try the next
      if (!isRetryableError(err, codes)) throw err;
      firstError ??= err;
      ctx.onFailover?.({
        at: new Date().toISOString(),
        from: target,
        to: targets[i + 1]!,
        error: errorInfo(err),
        attempt: i + 1,
      });
    }
  }
  throw firstError;
}

/**
 * Streaming: fail over only before any content is emitted. If a lane errors
 * after the caller already received chunks, the error propagates — retrying
 * would duplicate output. Clean completions return immediately.
 */
export function withFailoverStream<T, L extends FailoverTarget>(
  targets: L[],
  attempt: (target: L) => AsyncIterable<T>,
  ctx: FailoverContext = {},
): AsyncIterable<T> {
  const codes = ctx.codes ?? DEFAULT_RETRYABLE_CODES;
  const maxAttempts = ctx.maxAttempts ?? targets.length;
  return (async function* () {
    let firstError: unknown;
    for (let i = 0; i < targets.length && i < maxAttempts; i++) {
      const target = targets[i]!;
      let yielded = false;
      try {
        for await (const value of attempt(target)) {
          yielded = true;
          yield value;
        }
        return; // clean completion
      } catch (err) {
        if (i >= targets.length - 1 || i >= maxAttempts - 1) {
          // Exhausted: surface the current error if content was already
          // streamed, otherwise the original error.
          throw yielded ? err : firstError ?? err;
        }
        if (isCredentialError(err)) continue;
        if (!isRetryableError(err, codes)) throw err;
        if (yielded) throw err; // content already sent — never duplicate
        firstError ??= err;
        ctx.onFailover?.({
          at: new Date().toISOString(),
          from: target,
          to: targets[i + 1]!,
          error: errorInfo(err),
          attempt: i + 1,
        });
      }
    }
    throw firstError;
  })();
}
