import type { Provider } from './types.js';
import { createOpenAICompatibleProvider, type OpenAICompatibleConfig } from './openai-compatible.js';
import { createZenResponsesProvider } from './zen-responses.js';
import { createZenMessagesProvider } from './zen-messages.js';
import { createZenGeminiProvider } from './zen-gemini.js';
import type { ChatParams, ProviderCredentials, StreamChunk } from '../core/types.js';

/**
 * OpenCode Zen & OpenCode Go — the OpenCode team's gateways.
 *
 * - Zen  (https://opencode.ai/docs/zen): curated access to premium models, pay-as-you-go.
 *        Base: https://opencode.ai/zen/v1
 * - Go   (https://opencode.ai/docs/go):  low-cost subscription ($5 first month, then $10/mo)
 *        for tested open coding models. Base: https://opencode.ai/zen/go/v1
 *
 * Both authenticate with an API key from https://opencode.ai/auth. Zen exposes
 * several protocols; ModelHitch picks the right one per model family:
 *
 *   - gpt-* / grok-*   -> OpenAI Responses API        (/responses)
 *   - claude-* / qwen* -> Anthropic Messages API      (/messages)
 *   - gemini-*         -> Google native GenerateContent (models/{model}:generateContent)
 *   - everything else  -> OpenAI-compatible chat      (/chat/completions)
 *
 * The single `opencodeZen` provider routes automatically, so one provider id,
 * one key, and every model works.
 */

/** The wire protocol Zen uses for a given model id. */
export type ZenProtocol = 'responses' | 'messages' | 'gemini' | 'chat-completions';

export function zenProtocolForModel(model: string): ZenProtocol {
  const m = model.toLowerCase();
  if (m.startsWith('gpt-') || m.startsWith('grok-')) return 'responses';
  if (m.startsWith('claude-') || m.startsWith('qwen')) return 'messages';
  if (m.startsWith('gemini-')) return 'gemini';
  return 'chat-completions';
}

/** Curated, non-deprecated Zen model ids (see https://opencode.ai/docs/zen). */
export const OPENCODE_ZEN_MODELS = [
  // Free models
  'big-pickle',
  'deepseek-v4-flash-free',
  'mimo-v2.5-free',
  'laguna-s-2.1-free',
  'ling-3.0-tiny-free',
  'longcat-2.0-free',
  'north-mini-code-free',
  'nemotron-3-ultra-free',
  // OpenAI (Responses API on Zen)
  'gpt-5.6-sol',
  'gpt-5.6-terra',
  'gpt-5.6-luna',
  'gpt-5.5',
  'gpt-5.5-pro',
  'gpt-5.4',
  'gpt-5.4-pro',
  'gpt-5.4-mini',
  'gpt-5.4-nano',
  'gpt-5.3-codex',
  'gpt-5.3-codex-spark',
  'gpt-5',
  'gpt-5-nano',
  // Anthropic (Messages API on Zen)
  'claude-fable-5',
  'claude-opus-5',
  'claude-opus-4-8',
  'claude-opus-4-7',
  'claude-opus-4-6',
  'claude-opus-4-5',
  'claude-sonnet-5',
  'claude-sonnet-4-6',
  'claude-sonnet-4-5',
  'claude-haiku-4-5',
  // Google (native on Zen)
  'gemini-3.6-flash',
  'gemini-3.5-flash',
  'gemini-3.5-flash-lite',
  'gemini-3.1-pro',
  'gemini-3-flash',
  // xAI
  'grok-4.5',
  'grok-build-0.1',
  // Alibaba / Qwen (Messages API on Zen)
  'qwen3.7-max',
  'qwen3.7-plus',
  'qwen3.6-plus',
  'qwen3.5-plus',
  // DeepSeek
  'deepseek-v4-pro',
  'deepseek-v4-flash',
  // MiniMax
  'minimax-m3',
  'minimax-m2.7',
  // Zhipu GLM
  'glm-5.2',
  'glm-5.1',
  // Moonshot Kimi
  'kimi-k3',
  'kimi-k2.7-code',
  'kimi-k2.6',
] as const;

/** Model ids available through OpenCode Go (see https://opencode.ai/docs/go). */
export const OPENCODE_GO_MODELS = [
  'grok-4.5',
  'gpt-5.6-luna',
  'glm-5.2',
  'glm-5.1',
  'kimi-k3',
  'kimi-k2.7-code',
  'kimi-k2.6',
  'mimo-v2.5',
  'mimo-v2.5-pro',
  'minimax-m3',
  'minimax-m2.7',
  'qwen3.8-max',
  'qwen3.7-max',
  'qwen3.7-plus',
  'qwen3.6-plus',
  'deepseek-v4-pro',
  'deepseek-v4-flash',
  'hy3',
] as const;

export interface OpenCodeProviderOptions {
  fetchImpl?: typeof fetch;
  headers?: Record<string, string>;
  defaultModel?: string;
}

function openCodeConfig(
  id: string,
  name: string,
  baseUrl: string,
  apiKeyEnvVar: string,
  models: readonly string[],
  defaultModel: string,
  opts: OpenCodeProviderOptions,
): OpenAICompatibleConfig {
  return {
    id,
    name,
    baseUrl,
    defaultModel: opts.defaultModel ?? defaultModel,
    apiKeyEnvVar,
    apiKeyEnvFallbacks: ['OPENCODE_API_KEY'],
    capabilities: {
      streaming: true,
      toolCalling: true,
      vision: true,
      embeddings: false,
      maxContextTokens: 1_000_000,
    },
    headers: opts.headers,
    fetchImpl: opts.fetchImpl,
  };
}

/** OpenCode Zen — curated premium models, pay-as-you-go (auto-routes by family). */
export function createOpenCodeZenProvider(opts: OpenCodeProviderOptions = {}): Provider {
  const zenChat = createOpenAICompatibleProvider(
    openCodeConfig(
      'opencode-zen',
      'OpenCode Zen',
      'https://opencode.ai/zen/v1',
      'OPENCODE_ZEN_API_KEY',
      OPENCODE_ZEN_MODELS,
      'big-pickle', // free, zero-cost default good for trying things out
      opts,
    ),
  );
  const zenResponses = createZenResponsesProvider({
    baseUrl: 'https://opencode.ai/zen/v1',
    apiKeyEnvVar: 'OPENCODE_ZEN_API_KEY',
    apiKeyEnvFallbacks: ['OPENCODE_API_KEY'],
    defaultModel: opts.defaultModel ?? 'gpt-5.6-luna',
    fetchImpl: opts.fetchImpl,
  });
  const zenMessages = createZenMessagesProvider({ fetchImpl: opts.fetchImpl });
  const zenGemini = createZenGeminiProvider({
    baseUrl: 'https://opencode.ai/zen/v1',
    apiKeyEnvVar: 'OPENCODE_ZEN_API_KEY',
    apiKeyEnvFallbacks: ['OPENCODE_API_KEY'],
    defaultModel: opts.defaultModel ?? 'gemini-3.5-flash-lite',
    fetchImpl: opts.fetchImpl,
  });

  const route = (model: string) => zenProtocolForModel(model);

  return {
    id: 'opencode-zen',
    name: 'OpenCode Zen',
    defaultModel: opts.defaultModel ?? 'big-pickle',
    capabilities: zenChat.capabilities,
    async chat(params: ChatParams, credentials: ProviderCredentials) {
      switch (route(params.model)) {
        case 'responses':
          return zenResponses.chat(params, credentials);
        case 'messages':
          return zenMessages.chat(params, credentials);
        case 'gemini':
          return zenGemini.chat(params, credentials);
        default:
          return zenChat.chat(params, credentials);
      }
    },
    async *stream(params: ChatParams, credentials: ProviderCredentials): AsyncGenerator<StreamChunk> {
      switch (route(params.model)) {
        case 'responses':
          yield* zenResponses.stream(params, credentials);
          return;
        case 'messages':
          yield* zenMessages.stream(params, credentials);
          return;
        case 'gemini':
          yield* zenGemini.stream(params, credentials);
          return;
        default:
          yield* zenChat.stream(params, credentials);
          return;
      }
    },
    async listModels(credentials: ProviderCredentials) {
      return zenChat.listModels ? zenChat.listModels(credentials) : [];
    },
  };
}

/** OpenCode Go — low-cost subscription for tested open coding models. */
export function createOpenCodeGoProvider(opts: OpenCodeProviderOptions = {}): Provider {
  return createOpenAICompatibleProvider(
    openCodeConfig(
      'opencode-go',
      'OpenCode Go',
      'https://opencode.ai/zen/go/v1',
      'OPENCODE_GO_API_KEY',
      OPENCODE_GO_MODELS,
      'deepseek-v4-flash', // largest included allowance (31k+ requests/mo)
      opts,
    ),
  );
}

/** Default OpenCode Zen provider instance (used by the default registry). */
export const opencodeZen: Provider = createOpenCodeZenProvider();

/** Default OpenCode Go provider instance (used by the default registry). */
export const opencodeGo: Provider = createOpenCodeGoProvider();
