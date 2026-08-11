/**
 * A single message in a conversation. `content` is either plain text or a list
 * of content parts (text, image URL, or base64 image data) for multimodal models.
 */
export type ModelMessage =
  | { role: 'system' | 'user'; content: string | ContentPart[]; name?: string }
  | { role: 'assistant'; content: string | ContentPart[]; toolCalls?: ToolCall[] }
  | { role: 'tool'; content: string; toolCallId: string };

/** A content part for multimodal messages. */
export type ContentPart =
  | { type: 'text'; text: string }
  | { type: 'image'; imageUrl: string }
  | { type: 'image-data'; data: string; mimeType: string };

/** A tool the model may call. `parameters` is a JSON Schema object. */
export interface ToolDefinition {
  name: string;
  description?: string;
  parameters?: Record<string, unknown>;
}

/** A tool invocation emitted by the model. */
export interface ToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

/** Normalized, provider-agnostic parameters for a chat request. */
export interface ChatParams {
  /** Provider model id, e.g. "gpt-4o-mini", "claude-3-5-sonnet-latest", "llama3.2". */
  model: string;
  messages: ModelMessage[];
  tools?: ToolDefinition[];
  temperature?: number;
  maxTokens?: number;
  stop?: string[];
  signal?: AbortSignal;
}

/** Token usage, normalized. */
export interface Usage {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
}

/** A complete (non-streaming) chat result. */
export interface ChatResult {
  message: ModelMessage;
  finishReason: 'stop' | 'length' | 'tool-calls' | 'content-filter' | (string & {});
  usage?: Usage;
  /** Provider-specific raw payload, when available. */
  raw?: unknown;
}

/** A single normalized streaming event. */
export type StreamChunk =
  | { type: 'text-delta'; text: string }
  | { type: 'tool-call-start'; id: string; name: string }
  | { type: 'tool-call-args-delta'; id: string; argsDelta: string }
  | { type: 'tool-call-end'; id: string }
  | { type: 'finish'; finishReason: string; usage?: Usage };

/** What a provider can do. Used for capability detection and filtering. */
export interface Capabilities {
  streaming: boolean;
  toolCalling: boolean;
  vision: boolean;
  embeddings: boolean;
  maxContextTokens?: number;
}

/** Per-call credentials resolved by the client (from options or the KeyStore). */
export interface ProviderCredentials {
  apiKey?: string;
  baseUrl?: string;
}
