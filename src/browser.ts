// ModelHitch — plug-and-play BYOK integration layer.
// Browser-safe entry: the full library surface minus the Node-only bridge
// server and SQLite usage persistence. Bundlers resolve this entry via the
// `browser` export condition (or `modelhitch/browser` explicitly), so web
// apps never pull in `node:` modules.

export { ModelHitch, type ModelHitchOptions, type ChatInput } from './client.js';
export { ASCII_LOGO, printAsciiLogo } from './ascii.js';
export { runToolLoop, type ToolExecutor, type ToolLoopOptions, type ToolLoopEvent } from './agent.js';
export { defaultProviders } from './registry.js';
export { MemoryKeyStore } from './storage/memory.js';
export { LocalStorageKeyStore } from './storage/local-storage.js';

// auto-mode: rate-limit failover + usage tracking
export {
  DEFAULT_FAILOVER_LANES,
  DEFAULT_RETRYABLE_CODES,
  errorInfo,
  isRetryableError,
  isCredentialError,
  resolveLanes,
  retryableCodesFor,
  maxAttemptsFor,
  withFailover,
  withFailoverStream,
  type AutoModeOptions,
  type FailoverEvent,
  type FailoverTarget,
  type FailoverErrorInfo,
} from './core/failover.js';
export { UsageTracker, usageDashboardHtml } from './core/usage.js';
// `UsageStorage` is an interface only — safe for browsers. `SqliteUsageStorage`
// (the Node `node:sqlite` implementation) stays Node-only and is not exported
// here.
export type { UsageStorage } from './core/usage-storage.js';
export type {
  UsageEvent,
  UsageSnapshot,
  UsageTotals,
  UsageWindow,
} from './core/usage.js';

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
  huggingface,
  gemini,
  deepseek,
  xai,
  mistral,
  moonshot,
  zai,
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
