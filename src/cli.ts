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
  isRunning,
  probeBridge,
  readPid,
  spawnBackground,
  stopBackground,
  waitForReady,
} from './daemon.js';
import {
  createCatalogSource,
  type CatalogSource,
} from './catalog/source.js';
import {
  buildCatalogOptions,
  buildCooldownFromConfig,
  isMaskedSecret,
  policyFromConfig,
  serializeConfig,
  validateConfigWithSource,
} from './config.js';
import {
  defaultConfigPath,
  defaultConfigTemplate,
  initConfigFile,
  readConfigFile,
  writeConfigFile,
} from './config-file.js';
import type { ModelHitchConfig } from './config.js';
import { MemoryKeyStore } from './storage/memory.js';
import { CircuitBreaker } from './core/circuit-breaker.js';
import type { LaneCooldown } from './core/failover.js';
import type { Provider } from './providers/types.js';
import { defaultProviders } from './registry.js';

const VERSION = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
).version as string;

/** Read the value of `--flag` from the process args, or undefined. */
function flagValue(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  if (i === -1) return undefined;
  const value = process.argv[i + 1];
  return value && !value.startsWith('--') ? value : undefined;
}

/** Read the value of `--flag` from a local args array, or undefined. */
function argValue(args: string[], flag: string): string | undefined {
  const i = args.indexOf(flag);
  if (i === -1) return undefined;
  const value = args[i + 1];
  return value && !value.startsWith('--') ? value : undefined;
}

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
  const configPath = flagValue('--config') ?? defaultConfigPath();

  const loaded = readConfigFile(configPath); // null when none exists yet
  if (loaded) {
    const { errors } = validateConfigWithSource(loaded);
    if (errors.length) {
      console.error(`Config ${configPath} is invalid:\n  - ${errors.join('\n  - ')}`);
      process.exitCode = 1;
      return;
    }
  }
  const config: ModelHitchConfig = loaded ?? defaultConfigTemplate();

  // Catalog mode: warm the models.dev source, build the executable provider set.
  let catalogSource: CatalogSource | undefined;
  let providers: Provider[] = defaultProviders;
  let keystore = new MemoryKeyStore();
  const cooldown: LaneCooldown | undefined = buildCooldownFromConfig(config);
  const configCatalog = buildCatalogOptions(config);
  if (configCatalog || config.catalog !== undefined) {
    const src = createCatalogSource({ ...configCatalog, registry: defaultProviders });
    try {
      await src.warm();
      catalogSource = src;
      providers = src.providers();
    } catch (err) {
      console.error(`Failed to load the models.dev catalog: ${(err as Error).message}`);
      process.exitCode = 1;
      return;
    }
  }

  const server = createModelHitchServer({
    providers,
    defaultProviderId: config.defaultProviderId ?? 'opencode-zen',
    defaultModel: config.defaultModel,
    staticModels: {
      'opencode-zen': [...OPENCODE_ZEN_MODELS],
      'opencode-go': [...OPENCODE_GO_MODELS],
    },
    maxBodyBytes,
    policy: policyFromConfig(config),
    cooldown,
    catalogSource,
    keystore,
    // Keys from the config file are available from the very first request —
    // no Apply needed for keys already stored locally.
    apiKeys: config.keys,
    usagePersistence: true,
    logger: (line) => console.log(line),
    onFailover: (event) =>
      console.log(
        `[failover] ${event.from.providerId}/${event.from.model} -> ${event.to.providerId}/${event.to.model} (${event.error.code}${event.error.status ? ` HTTP ${event.error.status}` : ''})`,
      ),
    // Settings surface: read the (masked) document, validate + persist + apply.
    configBridge: {
      getConfig: () => serializeConfig(config, { maskSecrets: true }),
      updateConfig: async (next: unknown) => {
        const asConfig = next as ModelHitchConfig;
        const { errors } = validateConfigWithSource(asConfig, catalogSource);
        if (errors.length) return { ok: false, errors };
        // Never persist a masked placeholder back as a real key (a client that
        // echoes the masked value we handed out would otherwise silently
        // overwrite the user's real key). Plaintext is accepted; masked blobs
        // fall back to the previously-stored value.
        const keys = asConfig.keys ?? {};
        for (const [providerId, value] of Object.entries(keys)) {
          if (isMaskedSecret(value)) {
            delete keys[providerId];
            const prev = (config.keys ?? {})[providerId];
            if (prev && !isMaskedSecret(prev)) keys[providerId] = prev;
          }
        }
        // Persist the full document (keys included) to the config file.
        try {
          writeConfigFile(configPath, asConfig);
        } catch (err) {
          return { ok: false, errors: [`Failed to write ${configPath}: ${(err as Error).message}`] };
        }
        // Apply immediately — hot reload.
        Object.assign(config, asConfig);
        try {
          const nextCatalog = buildCatalogOptions(config);
          const wantsCatalog = config.catalog !== undefined;
          if (wantsCatalog && !catalogSource) {
            const src = createCatalogSource({ ...nextCatalog, registry: defaultProviders });
            await src.warm();
            catalogSource = src;
            server.reconfigure({
              providers: src.providers(),
              policy: policyFromConfig(config),
              cooldown: buildCooldownFromConfig(config) ?? (catalogSource ? new CircuitBreaker() : undefined),
              catalogSource: src,
              apiKeys: config.keys,
              defaultProviderId: config.defaultProviderId,
              defaultModel: config.defaultModel,
            });
          } else {
            server.reconfigure({
              providers: catalogSource ? catalogSource.providers() : providers,
              policy: policyFromConfig(config),
              cooldown: buildCooldownFromConfig(config) ?? (catalogSource ? new CircuitBreaker() : undefined),
              apiKeys: config.keys,
              baseUrls: config.catalog?.baseUrls,
              defaultProviderId: config.defaultProviderId,
              defaultModel: config.defaultModel,
            });
          }
        } catch (err) {
          return { ok: false, errors: [`Failed to apply config: ${(err as Error).message}`] };
        }
        return { ok: true };
      },
    },
  });

  const { url } = await server.listen(port, host);
  console.log(`\nModelHitch bridge v${VERSION} listening on ${url}

Point any OpenAI-compatible client (Android Studio Agent Mode, JetBrains AI,
Cursor, Codex CLI, Claude Code, Gemini CLI, ...) at:

  Base URL:   ${url}/v1
  API key:    any value (keys are resolved locally, never sent out)

Settings (local — no env digging):
  ${configPath}
  open ${url}/settings in a browser

Usage telemetry (persisted to ./modelhitch-usage.db):
  JSON:       curl ${url}/v1/usage
  Dashboard:  open ${url}/usage in a browser

Press Ctrl+C to stop.`);
}

async function runBackgroundBridge(): Promise<void> {
  const port = Number(process.env.MODELHITCH_PORT ?? 3939);
  const host = process.env.MODELHITCH_HOST ?? '127.0.0.1';
  const tracked = daemonStatus();

  if (!tracked.running) {
    const existing = await probeBridge(port, host);
    if (existing.responding) {
      console.log(`A bridge is already responding on ${existing.url}, but it is not tracked by this CLI.`);
      console.log('  Leave it running, or stop that process before starting a managed background bridge.');
      return;
    }
  }

  const spawned = spawnBackground(['bridge']);

  if (spawned.alreadyRunning) {
    console.log(`A background bridge is already running (pid ${spawned.pid}).`);
    console.log(`  status:  modelhitch status`);
    console.log(`  front:   modelhitch front  (stop it and run it here)`);
    console.log(`  stop:    modelhitch stop`);
    return;
  }

  console.log(`Launched the bridge in the background (pid ${spawned.pid}).`);
  const ready = await waitForReady(port, host, 8000, spawned.pid);
  if (!ready && !isRunning(spawned.pid)) clearPid();
  console.log(
    ready
      ? `  responding on http://${host}:${port} — your terminal is free.`
      : !isRunning(spawned.pid)
        ? `  process exited before becoming ready — check the log:`
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
    const existing = await probeBridge(port, host);
    if (readPid() !== null) {
      clearPid();
      console.log('modelhitch status: tracked process stopped (stale pid file cleaned up)');
    }
    if (existing.responding) {
      console.log('modelhitch status: responding (untracked process)');
      console.log(`  healthz:  yes — responding on ${existing.url}`);
      console.log('  stop:     stop the owning process; this CLI will not kill an untracked PID');
      return;
    }
    console.log('modelhitch status: not running');
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

async function runConfig(args: string[]): Promise<void> {
  const path = argValue(args, '--path') ?? defaultConfigPath();
  if (args.includes('init')) {
    const { created } = initConfigFile(path);
    console.log(created ? `Created ${path}` : `Already exists: ${path}`);
    return;
  }
  // Default: print the masked config path + contents.
  console.log(`config: ${path}`);
  const existing = readConfigFile(path);
  if (!existing) {
    console.log('  (none yet — run `modelhitch config init` or open the settings page)');
    return;
  }
  console.log(JSON.stringify(serializeConfig(existing, { maskSecrets: true }), null, 2));
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
    case 'config':
      await runConfig(args.slice(1));
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
