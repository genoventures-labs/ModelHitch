import type { Provider } from './types.js';
import { createOpenAICompatibleProvider } from './openai-compatible.js';

/**
 * Default OpenAI-compatible providers (including the OpenCode gateway above,
 * these all share one adapter — that's the point of the hitch).
 */
export const openai: Provider = createOpenAICompatibleProvider({
  id: 'openai',
  name: 'OpenAI',
  baseUrl: 'https://api.openai.com/v1',
  defaultModel: 'gpt-4o-mini',
  apiKeyEnvVar: 'OPENAI_API_KEY',
  capabilities: {
    streaming: true,
    toolCalling: true,
    vision: true,
    embeddings: true,
    maxContextTokens: 128_000,
  },
});

export const groq: Provider = createOpenAICompatibleProvider({
  id: 'groq',
  name: 'Groq',
  baseUrl: 'https://api.groq.com/openai/v1',
  defaultModel: 'llama-3.3-70b-versatile',
  apiKeyEnvVar: 'GROQ_API_KEY',
  capabilities: {
    streaming: true,
    toolCalling: true,
    vision: false,
    embeddings: false,
    maxContextTokens: 128_000,
  },
});

export const openrouter: Provider = createOpenAICompatibleProvider({
  id: 'openrouter',
  name: 'OpenRouter',
  baseUrl: 'https://openrouter.ai/api/v1',
  defaultModel: 'meta-llama/llama-3.1-8b-instruct:free',
  apiKeyEnvVar: 'OPENROUTER_API_KEY',
  capabilities: {
    streaming: true,
    toolCalling: true,
    vision: true,
    embeddings: false,
  },
});

export const together: Provider = createOpenAICompatibleProvider({
  id: 'together',
  name: 'Together AI',
  baseUrl: 'https://api.together.xyz/v1',
  defaultModel: 'meta-llama/Llama-3.3-70B-Instruct-Turbo',
  apiKeyEnvVar: 'TOGETHER_API_KEY',
  capabilities: {
    streaming: true,
    toolCalling: true,
    vision: true,
    embeddings: false,
  },
});

/** LM Studio — fully local, no key required. */
export const lmstudio: Provider = createOpenAICompatibleProvider({
  id: 'lmstudio',
  name: 'LM Studio (local)',
  baseUrl: 'http://localhost:1234/v1',
  defaultModel: 'local-model',
  requiresKey: false,
  capabilities: {
    streaming: true,
    toolCalling: true,
    vision: false,
    embeddings: true,
  },
});
