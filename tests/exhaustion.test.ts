import { describe, expect, it } from 'vitest';
import {
  ExhaustedError,
  ModelHitch,
  ModelHitchError,
  MemoryLaneCooldown,
  isExhaustedError,
  withFailover,
  withFailoverStream,
  type FailoverTarget,
} from '../src/index.js';

const lane = (providerId: string, model: string): FailoverTarget => ({ providerId, model });

/** Run an async call and return the rejection (or null on success) as unknown. */
async function capture<T>(fn: () => Promise<T>): Promise<unknown> {
  try {
    await fn();
    return null;
  } catch (err) {
    return err;
  }
}

/** Narrow after an isExhaustedError assertion. */
function exhausted(err: unknown): ExhaustedError {
  if (!isExhaustedError(err)) throw new Error('expected an ExhaustedError');
  return err;
}

describe('ExhaustedError (Milestone 4 — explicit exhaustion diagnostics)', () => {
  it('is thrown when every lane fails, preserving the FIRST error contract', async () => {
    const err = exhausted(
      await capture(() =>
        withFailover(
          [lane('a', 'm1'), lane('b', 'm2')],
          async (t) => {
            if (t.providerId === 'a') throw new ModelHitchError('rate-limited', '429 first', { status: 429 });
            throw new ModelHitchError('provider-error', '502 second');
          },
        ),
      ),
    );
    // Contract: code/status stay the FIRST error; message keeps that text and
    // adds a short rotation trail so clients can see failover ran.
    expect(err.code).toBe('rate-limited');
    expect(err.message).toContain('429 first');
    expect(err.message).toMatch(/rotated 2 lanes/);
    expect(err.status).toBe(429);
    // Diagnostics: full walk + per-lane attempts.
    expect(err.info.targets).toEqual([lane('a', 'm1'), lane('b', 'm2')]);
    expect(err.lanes.map((l) => l.target)).toEqual([lane('a', 'm1'), lane('b', 'm2')]);
    expect(err.lanes.map((l) => l.error.code)).toEqual(['rate-limited', 'provider-error']);
    expect(err.info.firstError).toBeInstanceOf(ModelHitchError);
  });

  it('is thrown on stream exhaustion too (pre-content)', async () => {
    const stream = withFailoverStream<string, FailoverTarget>(
      [lane('a', 'm1'), lane('b', 'm2')],
      async function* () {
        throw new ModelHitchError('network-error', 'reset');
      },
    );
    const err = exhausted(
      await capture(async () => {
        for await (const _ of stream) { /* drain */ }
      }),
    );
    expect(err.info.attempts).toHaveLength(2);
  });

  it('the all-lanes-cooled case is an ExhaustedError with no attempts', async () => {
    const cd = new MemoryLaneCooldown({ now: () => 0 });
    cd.cool(lane('a', 'm1'), 10_000);
    cd.cool(lane('b', 'm2'), 10_000);
    const err = exhausted(
      await capture(() =>
        withFailover(
          [lane('a', 'm1'), lane('b', 'm2')],
          async () => 'unreachable',
          { cooldown: cd },
        ),
      ),
    );
    expect(err.code).toBe('provider-error');
    expect(err.message).toContain('on cooldown');
    expect(err.lanes).toEqual([]);
  });

  it('surfaces credential failures with their code through an ExhaustedError', async () => {
    const err = exhausted(
      await capture(() =>
        withFailover(
          [lane('a', 'm1')],
          async () => {
            throw new ModelHitchError('missing-api-key', 'no key');
          },
        ),
      ),
    );
    expect(err.code).toBe('missing-api-key');
  });

  it('preserves the message of a plain (non-ModelHitchError) first error', () => {
  // Plain Errors are non-retryable so the kernel propagates them directly;
  // the fallback message handling is defensive — pin it via direct construction.
  const err = new ExhaustedError(new Error('plain first error message'), {
    targets: [lane('a', 'm1')],
    attempts: [],
    firstError: new Error('plain first error message'),
  });
  expect(err.code).toBe('provider-error'); // no ModelHitchError code available
  expect(err.message).toBe('plain first error message');
  expect(err.cause).toBeInstanceOf(Error);
});

  it('ModelHitch.chat() exhaustion surfaces ExhaustedError and still fires onExhausted', async () => {
    const exhaustedEvents: unknown[] = [];
    const mk = (id: string, e: ModelHitchError) => ({
      id,
      name: id,
      defaultModel: 'm',
      capabilities: { streaming: true, toolCalling: true, vision: true, embeddings: false },
      chat: async () => { throw e; },
      stream: async function* () { throw e; },
    });
    const mh = new ModelHitch({
      providers: [
        mk('a', new ModelHitchError('rate-limited', '429', { status: 429 })),
        mk('b', new ModelHitchError('provider-error', '502', { status: 502 })),
      ],
      policy: {
        trusted: [{ providerId: 'a', models: ['m'] }],
        fallback: [{ providerId: 'b', models: ['m'] }],
      },
      onExhausted: (info) => exhaustedEvents.push(info),
    });
    const err = exhausted(
      await capture(() => mh.chat({ messages: [{ role: 'user', content: 'hi' }] })),
    );
    expect(err.code).toBe('rate-limited');
    expect(exhaustedEvents).toHaveLength(1);
  });
});