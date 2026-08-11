import { describe, expect, it } from 'vitest';
import { responsesInputToMessages } from '../src/server/responses.js';

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
});
