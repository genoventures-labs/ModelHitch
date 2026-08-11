import type { Provider } from './providers/types.js';
import {
  anthropic,
  groq,
  lmstudio,
  mockProvider,
  ollama,
  openai,
  opencodeGo,
  opencodeZen,
  openrouter,
  together,
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
  mockProvider,
];
