import { createAnthropicProvider } from './anthropic.js';
import type { Provider } from './types.js';

export interface ZenMessagesProviderOptions {
  /** Base URL, e.g. "https://opencode.ai/zen/v1". */
  baseUrl?: string;
  defaultModel?: string;
  fetchImpl?: typeof fetch;
}

/**
 * OpenCode Zen /messages adapter — speaks the Anthropic Messages API against
 * https://opencode.ai/zen/v1/messages (Zen routes the Claude & Qwen families
 * there). Reuses the native Anthropic adapter with Zen's base URL and key env.
 */
export function createZenMessagesProvider(opts: ZenMessagesProviderOptions = {}): Provider {
  return createAnthropicProvider({
    id: 'zen-messages',
    name: 'OpenCode Zen (Anthropic Messages)',
    baseUrl: opts.baseUrl ?? 'https://opencode.ai/zen/v1',
    defaultModel: opts.defaultModel ?? 'claude-sonnet-5',
    apiKeyEnvVar: 'OPENCODE_ZEN_API_KEY',
    apiKeyEnvFallbacks: ['OPENCODE_API_KEY'],
    capabilities: { maxContextTokens: 1_000_000 },
    fetchImpl: opts.fetchImpl,
  });
}

/** Default OpenCode Zen /messages provider instance. */
export const zenMessages: Provider = createZenMessagesProvider();
