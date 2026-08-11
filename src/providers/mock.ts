import type {
  Capabilities,
  ChatParams,
  ChatResult,
  ModelMessage,
  ProviderCredentials,
  StreamChunk,
} from '../core/types.js';
import type { Provider } from './types.js';

/**
 * Deterministic provider for demos and tests. Echoes the last user message.
 * Prefix a user message with "!tool <name>" to simulate a tool call instead.
 */
export const mockProvider: Provider = {
  id: 'mock',
  name: 'Mock (deterministic)',
  defaultModel: 'mock-model',
  capabilities: {
    streaming: true,
    toolCalling: true,
    vision: false,
    embeddings: false,
  },

  async chat(params: ChatParams): Promise<ChatResult> {
    return simulate(params, false);
  },

  async *stream(params: ChatParams): AsyncGenerator<StreamChunk> {
    const { text, toolName } = inspect(params);
    if (toolName) {
      const id = `call_mock_1`;
      yield { type: 'tool-call-start', id, name: toolName };
      yield { type: 'tool-call-args-delta', id, argsDelta: '{"q":"mock query"}' };
      yield { type: 'tool-call-end', id };
      yield { type: 'finish', finishReason: 'tool-calls' };
      return;
    }
    // Stream the echo word-by-word with a tiny delay so the UI shows progress.
    const words = `Mock reply: ${text}`.split(' ');
    for (const word of words) {
      yield { type: 'text-delta', text: `${word} ` };
      await new Promise((r) => setTimeout(r, 10));
    }
    yield {
      type: 'finish',
      finishReason: 'stop',
      usage: { inputTokens: 10, outputTokens: words.length },
    };
  },
};

function inspect(params: ChatParams): { text: string; toolName: string | null } {
  const last = [...params.messages].reverse().find((m) => m.role === 'user');
  const raw = typeof last?.content === 'string' ? last.content : '';
  const match = raw.match(/^!tool\s+(\S+)/);
  // toolChoice 'none' suppresses tool simulation.
  if (params.toolChoice === 'none') return { text: raw, toolName: null };
  if (match?.[1]) return { text: raw, toolName: match[1] };
  return { text: raw, toolName: null };
}

function simulate(params: ChatParams, _stream: boolean): ChatResult {
  const { text, toolName } = inspect(params);
  let message: ModelMessage;
  let finishReason: string;
  if (toolName) {
    message = {
      role: 'assistant',
      content: '',
      toolCalls: [{ id: 'call_mock_1', name: toolName, arguments: { q: 'mock query' } }],
    };
    finishReason = 'tool-calls';
  } else {
    message = { role: 'assistant', content: `Mock reply: ${text}` };
    finishReason = 'stop';
  }
  return {
    message,
    finishReason,
    usage: { inputTokens: 10, outputTokens: typeof message.content === 'string' ? message.content.length : 10 },
  };
}
