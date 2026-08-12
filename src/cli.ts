#!/usr/bin/env node
/**
 * ModelHitch CLI.
 *
 *   modelhitch            print the logo, version, and command help
 *   modelhitch bridge     start the local OpenAI-compatible bridge server
 *   modelhitch bridge --background  start it as a background process (pid in ~/.modelhitch)
 *   modelhitch status     is a background bridge running?
 *   modelhitch front      stop the background one and run the bridge in this terminal
 *   modelhitch stop       stop the background bridge
 *   modelhitch setup codex  install the ModelHitch skill for Codex
 *   modelhitch --version  print the version
 *   modelhitch --help     print help
 *
 * Environment:
 *   MODELHITCH_PORT       bridge port (default 3939)
 *   MODELHITCH_HOST       bridge host (default 127.0.0.1)
 *   MODELHITCH_MAX_BODY_BYTES  max request body for the bridge (default 64 MiB)
 *   MODELHITCH_HOME       directory for the background pid/log (default ~/.modelhitch)
 */
import { readFileSync } from 'node:fs';
import { printAsciiLogo } from './ascii.js';
import { createModelHitchServer } from './server/server.js';
import { OPENCODE_GO_MODELS, OPENCODE_ZEN_MODELS } from './providers/opencode.js';
import { installSkills, SETUP_TARGETS, type SetupTarget } from './skill-installer.js';
import {
  clearPid,
  daemonStatus,
  readPid,
  spawnBackground,
  stopBackground,
  waitForReady,
} from './daemon.js';

const VERSION = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
).version as string;

function usage(): void {
  console.log(`ModelHitch v${VERSION} — plug-and-play BYOK integration layer.
  hitched at https://github.com/genoventures-labs/ModelHitch

Usage:
  modelhitch                print the logo, version, and this help
  modelhitch bridge         start the local OpenAI-compatible bridge server
  modelhitch bridge --background   start it in the background (terminal stays free)
  modelhitch status         is a background bridge running?
  modelhitch front          stop the background one, run the bridge in this terminal
  modelhitch stop           stop the background bridge
  modelhitch setup <agent>  install skills for codex, claude, cursor, vscode, or all
  modelhitch --version      print the version
  modelhitch --help         print this help

Background process:
  tracked in ~/.modelhitch (bridge.pid + bridge.log, override with MODELHITCH_HOME)

Skill setup:
  modelhitch setup codex            install to the agent's user skill directory
  modelhitch setup all --project    install project skills for all four agents
  --project                         install in the current project instead
  --dry-run                         show destinations without writing
  --force                           update files in existing skill directories

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

async function runBackgroundBridge(): Promise<void> {
  const spawned = spawnBackground(['bridge']);
  const port = Number(process.env.MODELHITCH_PORT ?? 3939);
  const host = process.env.MODELHITCH_HOST ?? '127.0.0.1';

  if (spawned.alreadyRunning) {
    console.log(`A background bridge is already running (pid ${spawned.pid}).`);
    console.log(`  status:  modelhitch status`);
    console.log(`  front:   modelhitch front  (stop it and run it here)`);
    console.log(`  stop:    modelhitch stop`);
    return;
  }

  console.log(`Launched the bridge in the background (pid ${spawned.pid}).`);
  const ready = await waitForReady(port, host, 8000);
  console.log(
    ready
      ? `  responding on http://${host}:${port} — your terminal is free.`
      : `  not responding yet — check the log:`,
  );
  console.log(`  log:     ${spawned.logPath}`);
  console.log(`  status:  modelhitch status`);
  console.log(`  stop:    modelhitch stop`);
  console.log(`  front:   modelhitch front  (stop it and run it here)`);
}

async function runStatus(): Promise<void> {
  const status = daemonStatus();
  const port = Number(process.env.MODELHITCH_PORT ?? 3939);
  const host = process.env.MODELHITCH_HOST ?? '127.0.0.1';

  if (!status.running || status.pid === null) {
    if (readPid() !== null) {
      clearPid();
      console.log('modelhitch status: not running (stale pid file cleaned up)');
    } else {
      console.log('modelhitch status: not running');
    }
    console.log('  start it with:  modelhitch bridge --background');
    return;
  }

  let health = 'no';
  try {
    const res = await fetch(`http://${host}:${port}/healthz`, { signal: AbortSignal.timeout(1200) });
    health = res.ok ? `yes — responding on http://${host}:${port}` : 'no';
  } catch {
    /* not responding */
  }
  console.log('modelhitch status: running');
  console.log(`  pid:      ${status.pid}`);
  console.log(`  healthz:  ${health}`);
  console.log(`  log:      ${status.logPath}`);
}

async function runFront(): Promise<void> {
  const status = daemonStatus();
  if (status.running && status.pid !== null) {
    await stopBackground();
    console.log(`Stopped the background bridge (pid ${status.pid}) — running it here instead.\n`);
  } else if (readPid() !== null) {
    clearPid();
  }
  await runBridge();
}

async function runStop(): Promise<void> {
  const status = daemonStatus();
  if (status.running && status.pid !== null) {
    await stopBackground();
    console.log(`Stopped the background bridge (pid ${status.pid}).`);
  } else if (readPid() !== null) {
    clearPid();
    console.log('No background bridge was running (stale pid file cleaned up).');
  } else {
    console.log('No background bridge is running.');
  }
}

function runSetup(args: string[]): void {
  const target = args[0];
  if (!target || !SETUP_TARGETS.includes(target as SetupTarget)) {
    throw new Error('Choose an agent: codex, claude, cursor, vscode, or all.');
  }
  const known = new Set(['--project', '--dry-run', '--force']);
  const unknown = args.slice(1).filter((arg) => !known.has(arg));
  if (unknown.length > 0) throw new Error(`Unknown setup option: ${unknown[0]}`);

  const dryRun = args.includes('--dry-run');
  const installed = installSkills({
    target: target as SetupTarget,
    scope: args.includes('--project') ? 'project' : 'user',
    force: args.includes('--force'),
    dryRun,
  });
  console.log(dryRun ? 'ModelHitch would install:' : 'ModelHitch skills installed:');
  for (const skill of installed) console.log(`  ${skill.agent.padEnd(7)} ${skill.path}`);
  if (!dryRun) console.log('\nRestart the agent or open a new session so it discovers the skill.');
}

async function main(): Promise<void> {
  printAsciiLogo();
  const args = process.argv.slice(2);
  const [cmd] = args;
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
      if (args.includes('--background') || args.includes('-b')) {
        await runBackgroundBridge();
      } else {
        await runBridge();
      }
      break;
    case 'status':
      await runStatus();
      break;
    case 'front':
      await runFront();
      break;
    case 'stop':
      await runStop();
      break;
    case 'setup':
      runSetup(args.slice(1));
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
