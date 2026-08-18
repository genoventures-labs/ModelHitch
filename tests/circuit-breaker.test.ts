import { describe, expect, it } from 'vitest';
import {
  CircuitBreaker,
  ModelHitchError,
  withFailover,
  withFailoverStream,
  type FailoverTarget,
} from '../src/index.js';

const lane = (providerId: string, model: string): FailoverTarget => ({ providerId, model });

function breaker(nowFn: () => number, overrides: Partial<ConstructorParameters<typeof CircuitBreaker>[0]> = {}) {
  return new CircuitBreaker({ now: nowFn, baseTripMs: 10_000, maxTripMs: 40_000, graceMs: 1_000, ...overrides });
}

function clock(start = 0) {
  let t = start;
  return { now: () => t, advance: (ms: number) => { t += ms; } };
}

describe('CircuitBreaker', () => {
  it('a 429 trips the lane immediately, honoring Retry-After', () => {
    const c = clock();
    const cb = breaker(c.now);
    cb.cool(lane('a', 'm'), { code: 'rate-limited', message: '429', status: 429, retryAfterMs: 30_000 });
    expect(cb.cooldownMs(lane('a', 'm'))).toBe(30_000);
    expect(cb.snapshotFor(lane('a', 'm'))?.state).toBe('open');
  });

  it('429 without Retry-After cools for the grace window', () => {
    const c = clock();
    const cb = breaker(c.now);
    cb.cool(lane('a', 'm'), { code: 'rate-limited', message: '429', status: 429 });
    expect(cb.cooldownMs(lane('a', 'm'))).toBe(1_000);
  });

  it('5xx/network failures below the threshold only get a short cool (lane stays usable)', () => {
    const c = clock();
    const cb = breaker(c.now, { failureThreshold: 3 });
    cb.cool(lane('a', 'm'), { code: 'provider-error', message: '502', status: 502 });
    cb.cool(lane('a', 'm'), { code: 'network-error', message: 'ECONNRESET' });
    expect(cb.cooldownMs(lane('a', 'm'))).toBe(1_000); // grace, not tripped
    expect(cb.snapshotFor(lane('a', 'm'))?.state).toBe('open'); // still cooling mid-window
    c.advance(1_001);
    expect(cb.cooldownMs(lane('a', 'm'))).toBe(0); // half-open → probe allowed
  });

  it('trips for the base window once the threshold is hit, escalating per trip', () => {
    const c = clock();
    const cb = breaker(c.now, { failureThreshold: 3 });
    const tgt = lane('a', 'm');
    cb.cool(tgt, { code: 'provider-error', message: '502', status: 502 });
    cb.cool(tgt, { code: 'provider-error', message: '502', status: 502 });
    expect(cb.cooldownMs(tgt)).toBe(1_000); // still below threshold

    cb.cool(tgt, { code: 'provider-error', message: '502', status: 502 }); // 3rd → trip
    expect(cb.cooldownMs(tgt)).toBe(10_000);
    expect(cb.snapshotFor(tgt)?.trips).toBe(1);

    c.advance(10_001); // window passes → half-open probe
    expect(cb.cooldownMs(tgt)).toBe(0);
    cb.cool(tgt, { code: 'provider-error', message: '502', status: 502 }); // probe fails → re-trip, escalated
    expect(cb.cooldownMs(tgt)).toBe(20_000);
    expect(cb.snapshotFor(tgt)?.trips).toBe(2);
  });

  it('caps the escalating trip window', () => {
    const c = clock();
    const cb = breaker(c.now, { failureThreshold: 1, maxTripMs: 40_000 });
    const tgt = lane('a', 'm');
    for (let i = 0; i < 3; i++) {
      cb.cool(tgt, { code: 'provider-error', message: '502', status: 502 });
      if (i < 2) c.advance(41_000); // wait out the window before re-tripping
    }
    expect(cb.snapshotFor(tgt)?.trips).toBe(3);
    expect(cb.cooldownMs(tgt)).toBe(40_000); // capped at maxTripMs, not 80k
  });

  it('success() closes the circuit and resets health', () => {
    const c = clock();
    const cb = breaker(c.now);
    const tgt = lane('a', 'm');
    cb.cool(tgt, { code: 'rate-limited', message: '429', status: 429, retryAfterMs: 30_000 });
    cb.success(tgt);
    expect(cb.cooldownMs(tgt)).toBe(0);
    expect(cb.snapshotFor(tgt)).toMatchObject({ state: 'closed', consecutiveFailures: 0, trips: 0 });
  });

  it('is lane-scoped (provider/model is the trust object)', () => {
    const c = clock();
    const cb = breaker(c.now);
    cb.cool(lane('openai', 'gpt-5.5'), { code: 'rate-limited', message: '429', status: 429 });
    expect(cb.cooldownMs(lane('openai', 'gpt-5.5'))).toBe(1_000);
    expect(cb.cooldownMs(lane('openai', 'gpt-5-mini'))).toBe(0);
  });

  it('snapshot() reports state per lane and sorts by lane', () => {
    const c = clock();
    const cb = breaker(c.now);
    cb.cool(lane('b', 'm'), { code: 'rate-limited', message: '429', status: 429 });
    cb.cool(lane('a', 'm'), { code: 'provider-error', message: '502', status: 502 });
    const snap = cb.snapshot();
    expect(snap.map((s) => `${s.providerId}/${s.model}`)).toEqual(['a/m', 'b/m']);
    expect(snap.map((s) => s.state)).toEqual(['open', 'open']);
    c.advance(2_000);
    const after = cb.snapshot();
    expect(after[0]?.state).toBe('half-open'); // grace passed, failures remain
    expect(after[0]?.remainingMs).toBe(0);
  });

  it('resets via the failover loop onSuccess hook', async () => {
    const c = clock();
    const cb = breaker(c.now);
    const successCalls: FailoverTarget[] = [];
    await withFailover(
      [lane('a', 'm'), lane('b', 'm')],
      async (t) => {
        if (t.providerId === 'a') throw new ModelHitchError('rate-limited', '429', { status: 429, retryAfterMs: 5_000 });
        return 'ok';
      },
      { cooldown: cb, onSuccess: (t) => { successCalls.push(t); cb.success(t); }, maxAttempts: 2 },
    );
    expect(cb.cooldownMs(lane('a', 'm'))).toBe(5_000); // failed lane tripped
    expect(successCalls).toEqual([lane('b', 'm')]); // success lane reset
    expect(cb.snapshotFor(lane('b', 'm'))?.state).toBe('closed');
  });

  it('honors Retry-After for 429s in the STREAMING pre-content path (P2 regression pin)', async () => {
    const c = clock();
    const cb = breaker(c.now);
    const stream = withFailoverStream<string, FailoverTarget>(
      [lane('a', 'm'), lane('b', 'm')],
      async function* (t) {
        if (t.providerId === 'a') {
          throw new ModelHitchError('rate-limited', '429', { status: 429, retryAfterMs: 30_000 });
        }
        yield 'ok';
      },
      { cooldown: cb },
    );
    const out: string[] = [];
    for await (const v of stream) out.push(v);
    expect(out).toEqual(['ok']);
    // The streaming lane must trip for the provider's authoritative Retry-After,
    // not the 5s grace — same as the non-stream path.
    expect(cb.cooldownMs(lane('a', 'm'))).toBe(30_000);
    expect(cb.snapshotFor(lane('a', 'm'))?.state).toBe('open');
  });

  it('respects rateLimitTripsImmediately: false (429s count toward the threshold)', () => {
    const c = clock();
    const cb = breaker(c.now, { rateLimitTripsImmediately: false, failureThreshold: 3, maxTripMs: 120_000 });
    const tgt = lane('a', 'm');
    cb.cool(tgt, { code: 'rate-limited', message: '429', status: 429 });
    cb.cool(tgt, { code: 'rate-limited', message: '429', status: 429 });
    expect(cb.cooldownMs(tgt)).toBe(1_000); // grace, not tripped
    expect(cb.snapshotFor(tgt)?.state).toBe('open');
    c.advance(1_001);
    cb.cool(tgt, { code: 'rate-limited', message: '429', status: 429, retryAfterMs: 60_000 });
    // Threshold reached at the 3rd failure: Retry-After sets the window.
    expect(cb.cooldownMs(tgt)).toBe(60_000);
    expect(cb.snapshotFor(tgt)?.trips).toBe(1);
  });
});