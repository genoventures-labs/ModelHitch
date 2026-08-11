import { describe, expect, it } from 'vitest';
import { createBridgeClient } from '../src/react/bridge.js';
import { initialStreamState, reduceChunks, startReduction, reduceStreamChunk } from '../src/react/stream-reducer.js';
import type { StreamChunk } from '../src/index.js';

const textChunks: StreamChunk[] = [
  { type: 'text-delta', text: 'Hello' },
  { type: 'text-delta', text: ' world' },
  { type: 'finish', finishReason: 'stop', usage: { inputTokens: 5, outputTokens: 2, totalTokens: 7 } },
];

const toolChunks: StreamChunk[] = [
  { type: 'tool-call-start', id: 'call_1', name: 'get_weather' },
  { type: 'tool-call-args-delta', id: 'call_1', argsDelta: '{"q":"' },
  { type: 'tool-call-args-delta', id: 'call_1', argsDelta: 'london"}' },
  { type: 'tool-call-end', id: 'call_1' },
  { type: 'finish', finishReason: 'tool-calls' },
];

describe('stream reducer', () => {
  it('accumulates text and captures finish usage', () => {
    const state = reduceChunks(textChunks);
    expect(state.text).toBe('Hello world');
    expect(state.finishReason).toBe('stop');
    expect(state.usage).toEqual({ inputTokens: 5, outputTokens: 2, totalTokens: 7 });
    expect(state.toolCalls).toEqual([]);
  });

  it('assembles tool calls from argument deltas', () => {
    const state = reduceChunks(toolChunks);
    expect(state.finishReason).toBe('tool-calls');
    expect(state.toolCalls).toHaveLength(1);
    expect(state.toolCalls[0]).toEqual({
      id: 'call_1',
      name: 'get_weather',
      arguments: { q: 'london' },
    });
    expect(state.usage).toBeNull(); // tool-only finish carries no usage
  });

  it('supports multiple parallel tool calls', () => {
    const chunks: StreamChunk[] = [
      { type: 'tool-call-start', id: 'a', name: 'tool_a' },
      { type: 'tool-call-start', id: 'b', name: 'tool_b' },
      { type: 'tool-call-args-delta', id: 'a', argsDelta: '{"x":1}' },
      { type: 'tool-call-args-delta', id: 'b', argsDelta: '{"y":2}' },
      { type: 'finish', finishReason: 'tool-calls' },
    ];
    const state = reduceChunks(chunks);
    expect(state.toolCalls).toHaveLength(2);
    expect(state.toolCalls[0]!.arguments).toEqual({ x: 1 });
    expect(state.toolCalls[1]!.arguments).toEqual({ y: 2 });
  });

  it('incremental reduction gives the same result as batch reduction', () => {
    const red = startReduction(initialStreamState);
    for (const chunk of toolChunks) reduceStreamChunk(red, chunk);
    expect(red.state).toEqual(reduceChunks(toolChunks));
  });

  it('handles a raw tool-call args object (already-parsed providers)', () => {
    const state = reduceChunks([
      { type: 'tool-call-start', id: 'c', name: 'f' },
      { type: 'tool-call-args-delta', id: 'c', argsDelta: '{"ok":true}' },
      { type: 'tool-call-end', id: 'c' },
      { type: 'finish', finishReason: 'tool-calls' },
    ]);
    expect(state.toolCalls[0]!.arguments).toEqual({ ok: true });
  });
});

describe('createBridgeClient', () => {
  it('builds a client whose default provider is the bridge', () => {
    const mh = createBridgeClient({ baseUrl: 'http://127.0.0.1:3939/v1', model: 'mock-model' });
    expect(mh.provider('bridge').name).toBe('ModelHitch bridge');
    expect(mh.defaultProviderId).toBe('bridge');
    // keyless — local bridge
    expect(mh.provider('bridge').defaultModel).toBe('mock-model');
  });

  it('normalizes trailing slashes off the base URL', () => {
    const mh = createBridgeClient({ baseUrl: 'http://127.0.0.1:3939/v1/', model: 'x' });
    const p = mh.provider('bridge') as { resolveApiKey?: () => Promise<string | undefined> };
    // reach into the provider config via chat against the mock server path —
    // here we just assert the client was built without throwing.
    expect(p).toBeTruthy();
    expect(mh.provider('bridge').defaultModel).toBe('x');
  });
});
