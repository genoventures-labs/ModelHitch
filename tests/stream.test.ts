import { describe, expect, it } from 'vitest';
import { aggregateStream, parseLines, parseSSE } from '../src/core/stream.js';

function bytes(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

describe('parseSSE', () => {
  it('parses data payloads across split network chunks', async () => {
    const chunks = [
      bytes('data: {"a":1}\n\n'),
      bytes('data: {"b'),
      bytes('":2}\n\ndata: [DONE]\n\n'),
    ];
    const events: string[] = [];
    for await (const e of parseSSE(chunks)) events.push(e);
    expect(events).toEqual(['{"a":1}', '{"b":2}']);
  });

  it('handles CRLF line endings and comments', async () => {
    const events: string[] = [];
    for await (const e of parseSSE([bytes(': comment\r\ndata: hi\r\n\r\ndata: [DONE]\r\n\r\n')])) {
      events.push(e);
    }
    expect(events).toEqual(['hi']);
  });
});

describe('parseLines', () => {
  it('parses newline-delimited JSON across chunk boundaries', async () => {
    const lines: string[] = [];
    for await (const l of parseLines([bytes('{"a":1}\n{"b'), bytes('":2}\n')])) {
      lines.push(l);
    }
    expect(lines).toEqual(['{"a":1}', '{"b":2}']);
  });
});

describe('aggregateStream', () => {
  it('aggregates text chunks into a ChatResult', async () => {
    const result = await aggregateStream(
      (async function* () {
        yield { type: 'text-delta' as const, text: 'Hel' };
        yield { type: 'text-delta' as const, text: 'lo' };
        yield { type: 'finish' as const, finishReason: 'stop', usage: { inputTokens: 1, outputTokens: 2 } };
      })(),
    );
    expect(result.message).toEqual({ role: 'assistant', content: 'Hello' });
    expect(result.finishReason).toBe('stop');
    expect(result.usage).toEqual({ inputTokens: 1, outputTokens: 2 });
  });

  it('aggregates tool calls with argument deltas', async () => {
    const result = await aggregateStream(
      (async function* () {
        yield { type: 'tool-call-start' as const, id: 'call_0', name: 'get_weather' };
        yield { type: 'tool-call-args-delta' as const, id: 'call_0', argsDelta: '{"city"' };
        yield { type: 'tool-call-args-delta' as const, id: 'call_0', argsDelta: ':"SF"}' };
        yield { type: 'tool-call-end' as const, id: 'call_0' };
        yield { type: 'finish' as const, finishReason: 'tool-calls' };
      })(),
    );
    expect(result.finishReason).toBe('tool-calls');
    expect(result.message).toEqual({
      role: 'assistant',
      content: '',
      toolCalls: [{ id: 'call_0', name: 'get_weather', arguments: { city: 'SF' } }],
    });
  });
});
