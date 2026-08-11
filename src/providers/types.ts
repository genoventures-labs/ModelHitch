import type { Capabilities, ChatParams, ChatResult, ProviderCredentials, StreamChunk } from '../core/types.js';

/** Metadata about a model available from a provider (from `/models` endpoints). */
export interface ModelInfo {
  id: string;
  name?: string;
  contextLength?: number;
}

/**
 * The contract every provider adapter implements. ModelHitch talks to these
 * only — your app never touches provider-specific payloads.
 */
export interface Provider {
  readonly id: string;
  readonly name: string;
  readonly defaultModel: string;
  readonly capabilities: Capabilities;
  /** Complete (non-streaming) chat. */
  chat(params: ChatParams, credentials: ProviderCredentials): Promise<ChatResult>;
  /** Streaming chat, normalized to `StreamChunk` events. */
  stream(params: ChatParams, credentials: ProviderCredentials): AsyncIterable<StreamChunk>;
  /** Optional: fetch the provider's available models (e.g. GET /models). */
  listModels?(credentials: ProviderCredentials): Promise<ModelInfo[]>;
}
