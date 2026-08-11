// ModelHitch — plug-and-play BYOK integration layer.
// Hitch any model to your app: one interface, user-supplied providers & keys.

export { ModelHitch, type ModelHitchOptions, type ChatInput } from './client.js';
export { runToolLoop, type ToolExecutor, type ToolLoopOptions, type ToolLoopEvent } from './agent.js';
export { defaultProviders } from './registry.js';
export { MemoryKeyStore } from './storage/memory.js';
export { LocalStorageKeyStore } from './storage/local-storage.js';

// OpenAI-compatible bridge server (agentic IDEs: Android Studio, JetBrains, ...)
export { OpenAICompatibleServer, createModelHitchServer } from './server/server.js';
export type { ModelHitchServerOptions } from './server/server.js';

export {
  // Provider framework
  createOpenAICompatibleProvider,
  OpenAICompatibleProvider,
  type OpenAICompatibleConfig,
  createAnthropicProvider,
  AnthropicProvider,
  createOllamaProvider,
  OllamaProvider,
  type Provider,
  type ModelInfo,
  // OpenCode Zen & Go
  opencodeZen,
  opencodeGo,
  createOpenCodeZenProvider,
  createOpenCodeGoProvider,
  OPENCODE_ZEN_MODELS,
  OPENCODE_GO_MODELS,
  // Native OpenCode Zen protocol adapters
  zenResponses,
  zenMessages,
  zenGemini,
  createZenResponsesProvider,
  ZenResponsesProvider,
  type ZenResponsesProviderOptions,
  createZenMessagesProvider,
  type ZenMessagesProviderOptions,
  createZenGeminiProvider,
  ZenGeminiProvider,
  type ZenGeminiProviderOptions,
  zenProtocolForModel,
  type ZenProtocol,
  // Default providers
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
} from './providers/index.js';

export {
  ModelHitchError,
  isModelHitchError,
  type ModelHitchErrorCode,
} from './core/errors.js';

export {
  aggregateStream,
  parseSSE,
  parseLines,
  bodyToAsyncIterable,
} from './core/stream.js';

export type {
  ModelMessage,
  ContentPart,
  ToolDefinition,
  ToolCall,
  ChatParams,
  ChatResult,
  StreamChunk,
  Usage,
  Capabilities,
  ProviderCredentials,
} from './core/types.js';

export type { KeyStore } from './core/keystore.js';
