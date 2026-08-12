#!/usr/bin/env node
/**
 * ModelHitch CLI.
 *
 *   modelhitch            print the logo, version, and command help
 *   modelhitch bridge     start the local OpenAI-compatible bridge server
 *   modelhitch --version  print the version
 *   modelhitch --help     print help
 *
 * Environment:
 *   MODELHITCH_PORT       bridge port (default 3939)
 *   MODELHITCH_HOST       bridge host (default 127.0.0.1)
 *   MODELHITCH_MAX_BODY_BYTES  max request body for the bridge (default 64 MiB)
 */
import { readFileSync } from 'node:fs';
import { printAsciiLogo } from './ascii.js';
import { createModelHitchServer } from './server/server.js';
import { OPENCODE_GO_MODELS, OPENCODE_ZEN_MODELS } from './providers/opencode.js';

const VERSION = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
).version as string;

function usage(): void {
  console.log(`ModelHitch v${VERSION} — plug-and-play BYOK integration layer.
  hitched at https://github.com/genoventures-labs/ModelHitch

Usage:
  modelhitch                print the logo, version, and this help
  modelhitch bridge         start the local OpenAI-compatible bridge server
  modelhitch --version      print the version
  modelhitch --help         print this help

Bridge environment:
  MODELHITCH_PORT           port (default 3939)
  MODELHITCH_HOST           host (default 127.0.0.1)
  MODELHITCH_MAX_BODY_BYTES max request body (default 64 MiB)
`);
}

async function runBridge(): Promise<void> {
  const port = Number(process.env.MODELHITCH_PORT ?? 3939);
  const host = process.env.MODELHITCH_HOST ?? '127.0.0.1';
  const maxBodyBytes = Number(process.env.MODELHITCH_MAX_BODY_BYTES ?? 64 * 1024 * 1024);

  const server = createModelHitchServer({
    defaultProviderId: 'opencode-zen',
    staticModels: {
      'opencode-zen': [...OPENCODE_ZEN_MODELS],
      'opencode-go': [...OPENCODE_GO_MODELS],
    },
    maxBodyBytes,
    autoMode: true,
    usagePersistence: true,
    logger: (line) => console.log(line),
    onFailover: (event) =>
      console.log(
        `[auto-mode] ${event.from.providerId}/${event.from.model} -> ${event.to.providerId}/${event.to.model} (${event.error.code}${event.error.status ? ` HTTP ${event.error.status}` : ''})`,
      ),
  });

  const { url } = await server.listen(port, host);
  console.log(`\nModelHitch bridge v${VERSION} listening on ${url}

Point any OpenAI-compatible client (Android Studio Agent Mode, JetBrains AI,
Cursor, Codex CLI, Claude Code, Gemini CLI, ...) at:

  Base URL:   ${url}/v1
  API key:    any value (keys are resolved locally, never sent out)

Models: providerId/modelId from the /v1/models catalog, e.g.
  opencode-zen/big-pickle        (requires OPENCODE_ZEN_API_KEY)
  opencode-go/deepseek-v4-flash  (requires OPENCODE_GO_API_KEY)
  mock/mock-model                (no key — deterministic demo)

auto-mode: ON — 429/5xx/network failures fail over to
  opencode-go/deepseek-v4-flash -> opencode-zen/big-pickle ->
  opencode-zen/deepseek-v4-flash-free -> opencode-zen/mimo-v2.5-free

Usage telemetry (persisted to ./modelhitch-usage.db):
  JSON:       curl ${url}/v1/usage
  Dashboard:  open ${url}/usage in a browser
  Reset:      curl -X POST ${url}/v1/usage/reset

Press Ctrl+C to stop.`);
}

async function main(): Promise<void> {
  printAsciiLogo();
  const [cmd] = process.argv.slice(2);
  switch (cmd) {
    case undefined:
    case '-h':
    case '--help':
      usage();
      break;
    case '-v':
    case '--version':
      console.log(VERSION);
      break;
    case 'bridge':
      await runBridge();
      break;
    default:
      console.log(`Unknown command: ${cmd}\n`);
      usage();
      process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
