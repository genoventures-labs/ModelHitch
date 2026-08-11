import type { Usage } from './types.js';

/**
 * Best-effort cost estimation for tracked usage.
 *
 * Pricing is approximate list price (USD per 1M tokens) as of mid-2026 for
 * common model families; local providers are free. Exact prices drift — treat
 * this as an estimate for dashboards, not billing.
 */
export interface ModelPricing {
  /** USD per 1M input tokens. */
  inputPerMillion?: number;
  /** USD per 1M output tokens. */
  outputPerMillion?: number;
}

/** Exact model id → pricing (wins over family fallback). */
export const MODEL_PRICING: Record<string, ModelPricing> = {
  // OpenCode Zen gateway models (family pricing as a stand-in).
  'gpt-5.6-luna': { inputPerMillion: 2.5, outputPerMillion: 10 },
  'deepseek-v4-flash': { inputPerMillion: 0.27, outputPerMillion: 1.1 },
  'qwen3.6-plus': { inputPerMillion: 0.4, outputPerMillion: 1.2 },
  'gemini-3.5-flash-lite': { inputPerMillion: 0.1, outputPerMillion: 0.4 },
};

/**
 * OpenCode Go subscription pricing (USD per 1M tokens) — the rates the Go
 * usage limits ($12/5h, $30/wk, $60/mo) are charged against. See
 * https://opencode.ai/docs/go. Applied only when the provider is
 * `opencode-go`; Zen pay-as-you-go pricing stays in `MODEL_PRICING`.
 */
export const GO_MODEL_PRICING: Record<string, ModelPricing> = {
  'grok-4.5': { inputPerMillion: 2.0, outputPerMillion: 6.0 },
  'gpt-5.6-luna': { inputPerMillion: 0.2, outputPerMillion: 1.2 },
  'glm-5.2': { inputPerMillion: 1.4, outputPerMillion: 4.4 },
  'glm-5.1': { inputPerMillion: 1.4, outputPerMillion: 4.4 },
  'kimi-k3': { inputPerMillion: 3.0, outputPerMillion: 15.0 },
  'kimi-k2.7-code': { inputPerMillion: 0.95, outputPerMillion: 4.0 },
  'kimi-k2.6': { inputPerMillion: 0.95, outputPerMillion: 4.0 },
  'mimo-v2.5': { inputPerMillion: 0.14, outputPerMillion: 0.28 },
  'mimo-v2.5-pro': { inputPerMillion: 0.435, outputPerMillion: 0.87 },
  'minimax-m3': { inputPerMillion: 0.3, outputPerMillion: 1.2 },
  'minimax-m2.7': { inputPerMillion: 0.3, outputPerMillion: 1.2 },
  'qwen3.8-max': { inputPerMillion: 2.0, outputPerMillion: 6.0 },
  'qwen3.7-max': { inputPerMillion: 2.5, outputPerMillion: 7.5 },
  'qwen3.7-plus': { inputPerMillion: 0.4, outputPerMillion: 1.6 },
  'qwen3.6-plus': { inputPerMillion: 0.5, outputPerMillion: 3.0 },
  'deepseek-v4-pro': { inputPerMillion: 0.435, outputPerMillion: 0.87 },
  'deepseek-v4-flash': { inputPerMillion: 0.14, outputPerMillion: 0.28 },
  hy3: { inputPerMillion: 0.14, outputPerMillion: 0.58 },
};

/** Model family prefixes → pricing fallback. */
const FAMILY_PRICING: Array<{ prefix: string; pricing: ModelPricing }> = [
  { prefix: 'gpt-', pricing: { inputPerMillion: 2.5, outputPerMillion: 10 } },
  { prefix: 'grok-', pricing: { inputPerMillion: 0.3, outputPerMillion: 1.2 } },
  { prefix: 'claude-', pricing: { inputPerMillion: 3, outputPerMillion: 15 } },
  { prefix: 'gemini-', pricing: { inputPerMillion: 0.3, outputPerMillion: 1.5 } },
  { prefix: 'qwen', pricing: { inputPerMillion: 0.4, outputPerMillion: 1.2 } },
  { prefix: 'deepseek-', pricing: { inputPerMillion: 0.27, outputPerMillion: 1.1 } },
  { prefix: 'llama-', pricing: { inputPerMillion: 0.2, outputPerMillion: 0.6 } },
  // Local providers — free.
  { prefix: 'local-model', pricing: { inputPerMillion: 0, outputPerMillion: 0 } },
];

/** Providers that are always local/free regardless of model id. */
const LOCAL_PROVIDER_IDS = new Set(['ollama', 'lmstudio', 'vllm', 'llamacpp', 'koboldcpp']);

export interface CostEstimate {
  /** True when a pricing entry was found; false = free or unknown (0 cost). */
  priced: boolean;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  inputCostUsd: number;
  outputCostUsd: number;
  totalCostUsd: number;
}

/** Resolve pricing for a model id (optionally scoped to a provider id). */
export function pricingFor(model: string, providerId?: string): ModelPricing {
  if (providerId && LOCAL_PROVIDER_IDS.has(providerId)) {
    return { inputPerMillion: 0, outputPerMillion: 0 };
  }
  // OpenCode Go charges its own subscription rates against the usage limits.
  if (providerId === 'opencode-go') {
    const go = GO_MODEL_PRICING[model];
    if (go) return go;
  }
  const exact = MODEL_PRICING[model];
  if (exact) return exact;
  for (const { prefix, pricing } of FAMILY_PRICING) {
    if (model.startsWith(prefix)) return pricing;
  }
  return {};
}

/** Estimate USD cost of a usage record. Returns 0s for free/unknown models. */
export function estimateCost(model: string, usage: Usage, providerId?: string): CostEstimate {
  const inputTokens = usage.inputTokens ?? 0;
  const outputTokens = usage.outputTokens ?? 0;
  const pricing = pricingFor(model, providerId);
  const inputCostUsd =
    pricing.inputPerMillion === undefined ? 0 : (inputTokens / 1_000_000) * pricing.inputPerMillion;
  const outputCostUsd =
    pricing.outputPerMillion === undefined ? 0 : (outputTokens / 1_000_000) * pricing.outputPerMillion;
  return {
    priced: pricing.inputPerMillion !== undefined || pricing.outputPerMillion !== undefined,
    inputTokens,
    outputTokens,
    totalTokens: usage.totalTokens ?? inputTokens + outputTokens,
    inputCostUsd,
    outputCostUsd,
    totalCostUsd: inputCostUsd + outputCostUsd,
  };
}
