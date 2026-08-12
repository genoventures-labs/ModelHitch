import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  clearPid,
  daemonStatus,
  isRunning,
  logFilePath,
  pidFilePath,
  readPid,
  writePid,
} from '../src/daemon.js';

let home: string;
const originalHome = process.env.MODELHITCH_HOME;

beforeAll(() => {
  home = mkdtempSync(join(tmpdir(), 'mh-daemon-test-'));
  process.env.MODELHITCH_HOME = home;
});

afterAll(() => {
  rmSync(home, { recursive: true, force: true });
  if (originalHome === undefined) delete process.env.MODELHITCH_HOME;
  else process.env.MODELHITCH_HOME = originalHome;
});

describe('daemon pid file', () => {
  it('round-trips the pid file', () => {
    expect(readPid()).toBeNull();
    writePid(4242);
    expect(readPid()).toBe(4242);
    expect(pidFilePath()).toBe(join(home, 'bridge.pid'));
    expect(logFilePath()).toBe(join(home, 'bridge.log'));
    clearPid();
    expect(readPid()).toBeNull();
  });

  it('treats a garbage pid file as null', () => {
    writeFileSync(pidFilePath(), 'not-a-number');
    expect(readPid()).toBeNull();
    clearPid();
  });

  it('ignores non-positive pids', () => {
    writePid(-1);
    expect(readPid()).toBeNull();
    clearPid();
  });
});

describe('daemon liveness', () => {
  it('reports the current process as running', () => {
    expect(isRunning(process.pid)).toBe(true);
  });

  it('reports a bogus pid as not running', () => {
    expect(isRunning(999999999)).toBe(false);
  });
});

describe('daemon status', () => {
  it('reports not running with no pid file', () => {
    clearPid();
    const status = daemonStatus();
    expect(status.running).toBe(false);
    expect(status.pid).toBeNull();
    expect(status.pidPath).toBe(join(home, 'bridge.pid'));
    expect(status.logPath).toBe(join(home, 'bridge.log'));
  });
});
