import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  assistantMessagesFromResult,
  mapResponsesRequest,
  resolveConversation,
  responsesInputToMessages,
  toResponsesCompletion,
} from '../src/server/responses.js';
import {
  clearConversations,
  conversationCount,
  rememberConversation,
} from '../src/server/conversation-state.js';

/**
 * Unit tests for `responsesInputToMessages` — the Responses `input` item ->
 * normalized messages conversion. These cover the exact item shapes the VS
 * Code Copilot extension's BYOK request builder emits, which previously
 * produced empty user messages, orphaned tool messages, or mangled
 * function_call_output content that upstream providers rejected with 400s.
 */

const img = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

describe('responsesInputToMessages — image handling', () => {
  it('keeps an input_image with a STRING image_url (extension builder shape)', () => {
    const messages = responsesInputToMessages([
      {
        type: 'message',
        role: 'user',
        content: [
          { type: 'input_text', text: 'see this?' },
          { type: 'input_image', detail: 'auto', image_url: img },
        ],
      },
    ]);
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({ role: 'user' });
    const parts = messages[0]!.content as Array<{ type: string; text?: string; imageUrl?: string }>;
    expect(parts[0]).toEqual({ type: 'text', text: 'see this?' });
    // data: URIs map to image-data; the URL string survives either way.
    expect(parts[1]).toMatchObject({ type: 'image-data', mimeType: 'image/png' });
  });

  it('keeps an input_image with an OBJECT image_url { url } (spec shape)', () => {
    const messages = responsesInputToMessages([
      {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_image', image_url: { url: img, detail: 'high' } }],
      },
    ]);
    expect(messages).toHaveLength(1);
    const parts = messages[0]!.content as Array<{ type: string; imageUrl?: string }>;
    expect(parts[0]).toMatchObject({ type: 'image-data', mimeType: 'image/png' });
  });

  it('keeps a non-data image_url string as an image part', () => {
    const messages = responsesInputToMessages([
      {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_image', image_url: 'https://example.com/a.png' }],
      },
    ]);
    expect(messages).toHaveLength(1);
    const parts = messages[0]!.content as Array<{ type: string; imageUrl?: string }>;
    expect(parts[0]).toMatchObject({ type: 'image', imageUrl: 'https://example.com/a.png' });
  });

  it('keeps accumulated text when an image URL is unusable', () => {
    const messages = responsesInputToMessages([
      {
        type: 'message',
        role: 'user',
        content: [
          { type: 'input_text', text: 'keep me' },
          { type: 'input_image', image_url: '' },
        ],
      },
    ]);
    expect(messages).toHaveLength(1);
    expect(messages[0]!.content).toBe('keep me');
  });

  it('drops a message that is ONLY an unusable image (empty user turn)', () => {
    const messages = responsesInputToMessages([
      {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_image', image_url: '' }],
      },
    ]);
    expect(messages).toHaveLength(0);
  });
});

describe('responsesInputToMessages — non-message items', () => {
  it('skips tool_search_output items instead of emitting empty user messages', () => {
    const messages = responsesInputToMessages([
      {
        type: 'tool_search_output',
        execution: 'client',
        call_id: 'toolu_search_1',
        status: 'completed',
        tools: [{ type: 'function', name: 'get_weather', call_id: 'call_1' }],
      },
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'what now' }] },
    ]);
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({ role: 'user', content: 'what now' });
  });

  it('skips tool_search_call items', () => {
    const messages = responsesInputToMessages([
      {
        type: 'tool_search_call',
        execution: 'client',
        call_id: 'toolu_search_1',
        status: 'completed',
        name: 'search',
        arguments: '{}',
      },
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hi' }] },
    ]);
    expect(messages).toHaveLength(1);
  });

  it('skips reasoning items and unknown vendor items', () => {
    const messages = responsesInputToMessages([
      { type: 'reasoning', summary: [{ type: 'summary_text', text: 'thinking…' }] },
      { type: 'custom_item', whatever: true },
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hi' }] },
    ]);
    expect(messages).toHaveLength(1);
  });

  it('drops an empty user message and an empty assistant message', () => {
    const messages = responsesInputToMessages([
      { type: 'message', role: 'user', content: [] },
      { type: 'message', role: 'assistant', content: [] },
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'real' }] },
    ]);
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({ role: 'user', content: 'real' });
  });
});

describe('responsesInputToMessages — function_call_output', () => {
  it('serializes parts-array output (cache-breakpoint shape) as text only', () => {
    const messages = responsesInputToMessages([
      { type: 'function_call', call_id: 'call_1', name: 'get_weather', arguments: '{}' },
      {
        type: 'function_call_output',
        call_id: 'call_1',
        output: [
          { type: 'output_text', text: '{"temp": 21}' },
          { type: 'prompt_cache_breakpoint', mode: 'explicit' },
        ],
      },
    ]);
    const tool = messages.find((m) => m.role === 'tool');
    expect(tool).toBeDefined();
    expect(tool!.content).toBe('{"temp": 21}');
    expect(tool!.toolCallId).toBe('call_1');
  });

  it('keeps a string output verbatim', () => {
    const messages = responsesInputToMessages([
      { type: 'function_call', call_id: 'call_1', name: 'get_weather', arguments: '{}' },
      { type: 'function_call_output', call_id: 'call_1', output: '{"temp": 21}' },
    ]);
    const tool = messages.find((m) => m.role === 'tool');
    expect(tool!.content).toBe('{"temp": 21}');
  });

  it('drops an ORPHANED function_call_output (stateful conversation slice)', () => {
    // The extension slices prior turns + sends previous_response_id, which
    // the bridge drops — so a function_call_output whose function_call is in
    // an earlier request must NOT be forwarded as an orphaned tool message.
    const messages = responsesInputToMessages([
      { type: 'function_call_output', call_id: 'call_from_previous_turn', output: '42' },
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'continue' }] },
    ]);
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({ role: 'user', content: 'continue' });
  });

  it('drops a function_call_output with NO call_id (matches upstream rejection)', () => {
    const messages = responsesInputToMessages([
      { type: 'function_call_output', output: 'orphaned' },
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'continue' }] },
    ]);
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({ role: 'user', content: 'continue' });
  });

  it('still merges consecutive function_call items into one assistant message', () => {
    const messages = responsesInputToMessages([
      { type: 'function_call', call_id: 'call_1', name: 'a', arguments: '{}' },
      { type: 'function_call', call_id: 'call_2', name: 'b', arguments: '{}' },
      { type: 'function_call_output', call_id: 'call_1', output: '1' },
      { type: 'function_call_output', call_id: 'call_2', output: '2' },
    ]);
    const assistant = messages.find((m) => m.role === 'assistant');
    expect(assistant!.toolCalls).toHaveLength(2);
    expect(messages.filter((m) => m.role === 'tool')).toHaveLength(2);
  });

  it('KEEPS an orphaned function_call_output when keepOrphanedOutputs is set (stateful delta turn)', () => {
    // Stateful continuation: the conversation lives on the upstream provider
    // (previous_response_id), so the delta's function_call_output whose
    // function_call was in an EARLIER request must be kept — its call_id is
    // matched against upstream state, not this request.
    const messages = responsesInputToMessages(
      [
        { type: 'function_call_output', call_id: 'call_from_previous_turn', output: '42' },
        { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'continue' }] },
      ],
      { keepOrphanedOutputs: true },
    );
    expect(messages).toHaveLength(2);
    expect(messages[0]).toMatchObject({ role: 'tool', content: '42', toolCallId: 'call_from_previous_turn' });
    expect(messages[1]).toMatchObject({ role: 'user', content: 'continue' });
  });

  it('still drops a call_id-less function_call_output even when keepOrphanedOutputs is set', () => {
    const messages = responsesInputToMessages(
      [{ type: 'function_call_output', output: 'no-call-id' }],
      { keepOrphanedOutputs: true },
    );
    expect(messages).toHaveLength(0);
  });
});

describe('mapResponsesRequest — stateful continuation (previous_response_id)', () => {
  it('forwards previous_response_id and keeps orphaned outputs in the delta', () => {
    const params = mapResponsesRequest(
      {
        model: 'mock-model',
        previous_response_id: 'resp_zen_abc123',
        input: [
          // Delta of a tool-result turn: the function_call lived in the
          // previous response, only the output is new.
          { type: 'function_call_output', call_id: 'call_t1', output: '{"temp": 21}' },
        ],
      },
      'mock-model',
    );
    expect(params.previousResponseId).toBe('resp_zen_abc123');
    expect(params.messages).toEqual([
      { role: 'tool', content: '{"temp": 21}', toolCallId: 'call_t1' },
    ]);
  });

  it('ignores empty/absent previous_response_id (stateless path unchanged)', () => {
    const params = mapResponsesRequest({ model: 'mock-model', input: [] }, 'mock-model');
    expect(params.previousResponseId).toBeUndefined();
  });
});

describe('toResponsesCompletion — upstream response id round-trip', () => {
  it('echoes the provider raw resp_ id instead of synthesizing a new one', () => {
    const body = toResponsesCompletion(
      {
        message: { role: 'assistant', content: 'hi' },
        finishReason: 'stop',
        usage: { inputTokens: 3, outputTokens: 2 },
        raw: { id: 'resp_zen_real_id', status: 'completed' },
      },
      'mock-model',
    );
    expect(body.id).toBe('resp_zen_real_id');
    expect(body.status).toBe('completed');
    expect(body.model).toBe('mock-model');
  });

  it('falls back to a synthetic resp_ id when raw has none (other providers)', () => {
    const body = toResponsesCompletion(
      { message: { role: 'assistant', content: 'hi' }, finishReason: 'stop' },
      'mock-model',
    );
    expect(body.id).toMatch(/^resp_/);
    expect(body.id).not.toBe('resp_zen_real_id');
  });

  it('ignores non-resp_ raw ids (chat-completion ids would poison the chain)', () => {
    const body = toResponsesCompletion(
      {
        message: { role: 'assistant', content: 'hi' },
        finishReason: 'stop',
        raw: { id: 'chatcmpl-xyz' },
      },
      'mock-model',
    );
    expect(body.id).toMatch(/^resp_[0-9a-f-]{36}$/);
  });

  it('accepts zen native gen- ids so they round-trip', () => {
    const body = toResponsesCompletion(
      {
        message: { role: 'assistant', content: 'hi' },
        finishReason: 'stop',
        raw: { id: 'gen-1786487861-uBH8hIzt1AwyF7XMCa9t', status: 'completed' },
      },
      'mock-model',
    );
    expect(body.id).toBe('gen-1786487861-uBH8hIzt1AwyF7XMCa9t');
  });
});

describe('resolveConversation — bridge-side conversation reconstruction', () => {
  beforeEach(() => clearConversations());
  afterEach(() => clearConversations());

  it('returns messages unchanged when there is no previous_response_id', () => {
    const params = mapResponsesRequest(
      { model: 'mock-model', input: [{ role: 'user', content: 'hi' }] },
      'mock-model',
    );
    expect(resolveConversation(params, undefined)).toBe(params.messages);
  });

  it('expands a delta against the cached conversation', () => {
    rememberConversation('resp_1', [
      { role: 'user', content: '!tool get_weather' },
      { role: 'assistant', content: '', toolCalls: [{ id: 'call_1', name: 'get_weather', arguments: {} }] },
    ]);
    const params = mapResponsesRequest(
      {
        model: 'mock-model',
        previous_response_id: 'resp_1',
        input: [{ type: 'function_call_output', call_id: 'call_1', output: '42' }],
      },
      'mock-model',
    );
    const messages = resolveConversation(params, 'resp_1');
    expect(messages).toEqual([
      { role: 'user', content: '!tool get_weather' },
      { role: 'assistant', content: '', toolCalls: [{ id: 'call_1', name: 'get_weather', arguments: {} }] },
      { role: 'tool', content: '42', toolCallId: 'call_1' },
    ]);
  });

  it('throws a clear bad-request when the referenced conversation is gone', () => {
    const params = mapResponsesRequest(
      {
        model: 'mock-model',
        previous_response_id: 'resp_lost',
        input: [{ type: 'function_call_output', call_id: 'call_1', output: '42' }],
      },
      'mock-model',
    );
    expect(() => resolveConversation(params, 'resp_lost')).toThrow(/Start a new chat/);
  });
});

describe('assistantMessagesFromResult', () => {
  it('extracts an assistant message with content and tool calls', () => {
    expect(
      assistantMessagesFromResult({ role: 'assistant', content: 'done', toolCalls: [{ id: 'c', name: 't', arguments: {} }] }),
    ).toEqual([{ role: 'assistant', content: 'done', toolCalls: [{ id: 'c', name: 't', arguments: {} }] }]);
  });

  it('returns [] for empty or non-assistant messages', () => {
    expect(assistantMessagesFromResult({ role: 'user', content: 'hi' })).toEqual([]);
    expect(assistantMessagesFromResult({ role: 'assistant', content: '' })).toEqual([]);
  });

  it('tracks the cache size (eviction hook)', () => {
    clearConversations();
    rememberConversation('resp_1', []);
    rememberConversation('resp_2', []);
    expect(conversationCount()).toBe(2);
  });
});
