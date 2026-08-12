/**
 * ModelHitch quickstart — no real API key needed.
 *
 * Defaults to the built-in `mock` provider so this runs anywhere.
 * Set OPENCODE_ZEN_API_KEY or OPENCODE_GO_API_KEY to talk to real gateways:
 *
 *   OPENCODE_ZEN_API_KEY=sk-... npx tsx examples/quickstart.ts
 *   OPENCODE_GO_API_KEY=sk-... npx tsx examples/quickstart.ts
 */
import {
  ModelHitch,
  ModelHitchError,
  OPENCODE_GO_MODELS,
  OPENCODE_ZEN_MODELS,
  printAsciiLogo,
} from '../src/index.js';

const ZEN_KEY = process.env.OPENCODE_ZEN_API_KEY;
const GO_KEY = process.env.OPENCODE_GO_API_KEY;

const mh = new ModelHitch();

printAsciiLogo();

async function main() {
  // Pick a provider: mock (default) > OpenCode Zen > OpenCode Go > fail.
  const provider = ZEN_KEY
    ? { id: 'opencode-zen', model: ZEN_MODEL() }
    : GO_KEY
      ? { id: 'opencode-go', model: GO_MODEL() }
      : { id: 'mock', model: undefined as string | undefined };

  console.log(`\n=== ModelHitch — provider: ${provider.id} ===\n`);

  // 1) Non-streaming chat
  const result = await mh.chat({
    provider: provider.id,
    model: provider.model,
    messages: [{ role: 'user', content: 'What is a hitch, in one sentence?' }],
  });
  console.log('[chat]', JSON.stringify(result.message.content));

  // 2) Streaming chat
  console.log('\n[stream]');
  const stream = await mh.stream({
    provider: provider.id,
    model: provider.model,
    messages: [{ role: 'user', content: 'Count from 1 to 5, one per line.' }],
  });
  let text = '';
  for await (const chunk of stream) {
    if (chunk.type === 'text-delta') {
      process.stdout.write(chunk.text);
      text += chunk.text;
    }
    if (chunk.type === 'finish') {
      console.log(`\n[finish] reason=${chunk.finishReason} usage=${JSON.stringify(chunk.usage)}`);
    }
  }

  // 3) Capability detection
  const caps = mh.capabilities(provider.id);
  console.log(
    `\n[capabilities] ${provider.id}: streaming=${caps.streaming} tools=${caps.toolCalling} vision=${caps.vision}`,
  );

  // 4) Error handling is normalized
  try {
    await mh.chat({
      provider: provider.id,
      model: 'definitely-not-a-real-model-xyz',
      messages: [{ role: 'user', content: 'hi' }],
    });
  } catch (err) {
    if (err instanceof ModelHitchError) {
      console.log(`\n[error] code=${err.code} message=${err.message.slice(0, 120)}`);
    } else {
      throw err;
    }
  }

  // 5) Model discovery on the real gateways
  if (ZEN_KEY || GO_KEY) {
    const listProvider = ZEN_KEY ? 'opencode-zen' : 'opencode-go';
    console.log(`\n[models] ${listProvider} offers discovery at GET /models`);
    try {
      const models = await mh.listModels(listProvider);
      console.log(`  (live) ${models.length} models — first 5: ${models.slice(0, 5).map((m) => m.id).join(', ')}`);
    } catch {
      console.log('  (live list unavailable — using curated list)');
    }
    console.log(`  (curated) ${ZEN_KEY ? OPENCODE_ZEN_MODELS.length : OPENCODE_GO_MODELS.length} curated models`);
  }

  console.log('\nDone. To use a real provider, set OPENCODE_ZEN_API_KEY or OPENCODE_GO_API_KEY.\n');
}

function ZEN_MODEL(): string {
  return 'big-pickle'; // free on Zen — zero cost for testing
}

function GO_MODEL(): string {
  return 'deepseek-v4-flash'; // largest included allowance on Go
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
