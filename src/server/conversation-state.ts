import type { ModelMessage } from '../core/types.js';

/**
 * Stateful Responses continuations — conversation memory for the bridge.
 *
 * The VS Code Copilot extension (and Codex CLI, when `previous_response_id`
 * is used) keeps conversation state SERVER-side: it slices prior turns out of
 * the request and references them via `previous_response_id`, expecting the
 * server to resolve the delta against its own state.
 *
 * zen's /responses endpoint rejects `previous_response_id` outright
 * (`invalid_prompt: Invalid Responses API request`), so the bridge IS the
 * state holder: it caches the normalized conversation per response id it
 * issued, and expands incoming deltas against that cache before forwarding a
 * full (stateless) request upstream.
 *
 * The cache is keyed by the id returned in the response body — the same id the
 * client sends back as `previous_response_id`. Losing it (bridge restart)
 * makes the conversation unresolvable, which callers surface as a clear error
 * telling the user to start a new chat.
 */

const conversations = new Map<string, ModelMessage[]>();

/** Hard cap so a long-lived bridge can't grow without bound. */
const MAX_CONVERSATIONS = 64;

/** Look up the full conversation for a response id issued by this bridge. */
export function conversationFor(responseId: string): ModelMessage[] | undefined {
  return conversations.get(responseId);
}

/**
 * Record the full conversation (all messages up to and including the
 * response's own assistant output) under the response id the client received.
 */
export function rememberConversation(responseId: string, conversation: ModelMessage[]): void {
  // Map preserves insertion order — evict the oldest entry when full.
  if (conversations.size >= MAX_CONVERSATIONS && !conversations.has(responseId)) {
    const oldest = conversations.keys().next().value;
    if (oldest !== undefined) conversations.delete(oldest);
  }
  conversations.set(responseId, conversation);
}

/** Number of tracked conversations (test/diagnostic hook). */
export function conversationCount(): number {
  return conversations.size;
}

/** Drop all tracked state (server shutdown / tests). */
export function clearConversations(): void {
  conversations.clear();
}
