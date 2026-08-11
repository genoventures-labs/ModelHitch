import type { Provider } from './providers/types.js';
import {
  anthropic,
  groq,
  koboldcpp,
  llamacpp,
  lmstudio,
  mockProvider,
  ollama,
  openai,
  opencodeGo,
  opencodeZen,
  openrouter,
  together,
  vllm,
} from './providers/index.js';

/** The providers that ship with ModelHitch out of the box. */
export const defaultProviders: Provider[] = [
  opencodeZen,
  opencodeGo,
  openai,
  anthropic,
  groq,
  openrouter,
  together,
  lmstudio,
  ollama,
  vllm,
  llamacpp,
  koboldcpp,
  mockProvider,
];
