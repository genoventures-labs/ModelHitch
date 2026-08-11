import { describe, expect, it } from 'vitest';
import { estimateCost, pricingFor } from '../src/core/cost.js';

describe('pricingFor', () => {
  it('matches exact model ids', () => {
    expect(pricingFor('gpt-5.6-luna').inputPerMillion).toBe(2.5);
    expect(pricingFor('deepseek-v4-flash').inputPerMillion).toBe(0.27);
  });

  it('falls back to family prefixes', () => {
    expect(pricingFor('gpt-4.1-mini').inputPerMillion).toBe(2.5);
    expect(pricingFor('claude-sonnet-4.5').inputPerMillion).toBe(3);
    expect(pricingFor('gemini-2.5-pro').outputPerMillion).toBe(1.5);
  });

  it('is free for local providers regardless of model', () => {
    expect(pricingFor('anything', 'ollama')).toEqual({ inputPerMillion: 0, outputPerMillion: 0 });
    expect(pricingFor('local-model', 'vllm')).toEqual({ inputPerMillion: 0, outputPerMillion: 0 });
  });

  it('returns empty pricing for unknown models', () => {
    expect(pricingFor('weird-model-xyz')).toEqual({});
  });
});

describe('estimateCost', () => {
  it('computes USD from token counts', () => {
    const cost = estimateCost('gpt-5.6-luna', { inputTokens: 1_000_000, outputTokens: 500_000 });
    expect(cost.priced).toBe(true);
    expect(cost.inputCostUsd).toBeCloseTo(2.5);
    expect(cost.outputCostUsd).toBeCloseTo(5.0);
    expect(cost.totalCostUsd).toBeCloseTo(7.5);
    expect(cost.totalTokens).toBe(1_500_000);
  });

  it('treats free local providers as zero cost', () => {
    const cost = estimateCost('local-model', { inputTokens: 1000, outputTokens: 500 }, 'ollama');
    expect(cost.priced).toBe(true);
    expect(cost.totalCostUsd).toBe(0);
  });

  it('returns zero cost for unknown models (not priced)', () => {
    const cost = estimateCost('unknown-model', { inputTokens: 100, outputTokens: 50 });
    expect(cost.priced).toBe(false);
    expect(cost.totalCostUsd).toBe(0);
  });

  it('defaults missing tokens to zero', () => {
    const cost = estimateCost('deepseek-v4-flash', {});
    expect(cost.inputTokens).toBe(0);
    expect(cost.outputTokens).toBe(0);
    expect(cost.totalCostUsd).toBe(0);
  });
});
