import { useState } from 'react';
import { useChat, type UseChatOptions } from 'modelhitch/react';
import type { ToolDefinition, ModelMessage } from 'modelhitch';

/**
 * BYOK chat UI. Points at a local ModelHitch bridge (see `server.ts` in this
 * folder — run it with `npm run server`), which holds the keys and speaks
 * OpenAI-compatible /v1/chat/completions. The hooks then stream replies and
 * drive multi-turn tool calls automatically.
 *
 * Swap `model` for any provider/model the bridge routes, e.g.
 * "opencode-zen/big-pickle" with a real bridge + keys.
 */

const BRIDGE_URL = import.meta.env.VITE_BRIDGE_URL ?? 'http://127.0.0.1:3939/v1';
const MODEL = import.meta.env.VITE_BRIDGE_MODEL ?? 'mock-model';

const weatherTool: ToolDefinition = {
  name: 'get_weather',
  description: 'Get the current weather for a city.',
  parameters: {
    type: 'object',
    properties: {
      q: { type: 'string', description: 'City name, e.g. "london"' },
    },
    required: ['q'],
  },
};

const chatOptions: UseChatOptions = {
  baseUrl: BRIDGE_URL,
  model: MODEL,
  systemPrompt: 'You are a helpful assistant. Use the get_weather tool when the user asks about weather.',
  tools: [weatherTool],
  executeTool: async (name, args) => {
    // In a real app this would call your own backend — never put keys in the
    // browser. For the demo we fake a forecast.
    if (name === 'get_weather') {
      const city = (args as { q?: string }).q ?? 'somewhere';
      return JSON.stringify({ city, temp_c: 18, condition: 'Sunny' });
    }
    return JSON.stringify({ error: `unknown tool ${name}` });
  },
};

export function App() {
  const { messages, pending, activeTool, isThinking, error, usage, send, reset, cancel } = useChat(chatOptions);
  const [draft, setDraft] = useState('');

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    void send(draft);
    setDraft('');
  };

  return (
    <main>
      <h1>ModelHitch BYOK UI</h1>
      <p className="status">
        bridge: {BRIDGE_URL} · model: {MODEL} · {usage ? `tokens: ${usage.totalTokens ?? '?'}` : 'no usage yet'}
      </p>

      <div style={{ display: 'flex', flexDirection: 'column' }}>
        {messages.map((m, i) => <Message key={i} m={m} />)}
        {pending !== null && (
          <div className="msg assistant">
            {pending || (isThinking ? '…' : '')}
          </div>
        )}
        {activeTool && <div className="tool">⚙ calling {activeTool}…</div>}
      </div>

      {error && <p className="status" style={{ color: '#dc2626' }}>⚠ {error.message}</p>}

      <form onSubmit={submit}>
        <input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder='Try: "What is the weather in london?"'
          disabled={isThinking}
        />
        <button type="submit" disabled={isThinking || !draft.trim()}>
          {isThinking ? '…' : 'Send'}
        </button>
        <button type="button" onClick={cancel} disabled={!isThinking}>Stop</button>
        <button type="button" onClick={reset}>Clear</button>
      </form>
    </main>
  );
}

function Message({ m }: { m: ModelMessage }) {
  if (m.role === 'system') return <div className="tool">system: {m.content as string}</div>;
  if (m.role === 'tool') return <div className="tool">tool {m.toolCallId}: {m.content as string}</div>;
  if (m.role === 'assistant') {
    return (
      <>
        <div className="msg assistant">{m.content as string}</div>
        {m.toolCalls?.map((tc) => (
          <div className="tool" key={tc.id}>⚙ {tc.name}({JSON.stringify(tc.arguments)})</div>
        ))}
      </>
    );
  }
  return <div className="msg user">{m.content as string}</div>;
}
