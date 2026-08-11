import type { StreamChunk, ToolCall, Usage } from '../core/types.js';
import { safeJsonParse } from '../core/json.js';

/**
 * Framework-free stream accumulation for the React hooks. `useStream` and
 * `useChat` feed raw `StreamChunk`s through `reduceStreamChunk` and hold the
 * result in state; keeping this pure makes it testable without a React
 * renderer and lets non-React UIs reuse the same logic.
 */

export interface StreamState {
  text: string;
  toolCalls: ToolCall[];
  finishReason: string | null;
  usage: Usage | null;
}

export const initialStreamState: StreamState = {
  text: '',
  toolCalls: [],
  finishReason: null,
  usage: null,
};

/** Internal partial-args buffers, keyed by tool call id. */
export interface StreamReduction {
  state: StreamState;
  /** tool call id → args JSON string accumulated so far. */
  argsJson: Map<string, string>;
}

export function startReduction(initial: StreamState = initialStreamState): StreamReduction {
  return { state: { ...initial, toolCalls: [...initial.toolCalls] }, argsJson: new Map() };
}

/** Fold one StreamChunk into the reduction. Returns the updated reduction. */
export function reduceStreamChunk(red: StreamReduction, chunk: StreamChunk): StreamReduction {
  const state = { ...red.state, toolCalls: [...red.state.toolCalls] };
  switch (chunk.type) {
    case 'text-delta':
      state.text += chunk.text;
      break;
    case 'tool-call-start': {
      const call: ToolCall = { id: chunk.id, name: chunk.name, arguments: {} };
      state.toolCalls.push(call);
      red.argsJson.set(chunk.id, '');
      break;
    }
    case 'tool-call-args-delta': {
      const prev = red.argsJson.get(chunk.id) ?? '';
      red.argsJson.set(chunk.id, prev + chunk.argsDelta);
      const idx = state.toolCalls.findIndex((c) => c.id === chunk.id);
      if (idx >= 0) {
        state.toolCalls[idx] = {
          ...state.toolCalls[idx]!,
          arguments: safeJsonParse<Record<string, unknown>>(red.argsJson.get(chunk.id)!, {}),
        };
      }
      break;
    }
    case 'tool-call-end':
      // args are finalized by the trailing args-delta.
      break;
    case 'finish':
      state.finishReason = chunk.finishReason;
      state.usage = chunk.usage ?? null;
      break;
  }
  red.state = state;
  return red;
}

/** Fold a whole chunk list (convenience for tests / non-hook callers). */
export function reduceChunks(chunks: Iterable<StreamChunk>, initial?: StreamState): StreamState {
  const red = startReduction(initial);
  for (const chunk of chunks) reduceStreamChunk(red, chunk);
  return red.state;
}
