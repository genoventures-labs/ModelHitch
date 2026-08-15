import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import * as browser from '../src/browser.js';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Parse static `import`/`export ... from` statements. Type-only imports
 * (`import type { X } from ...`, `export type { X } from ...`) are flagged —
 * they are erased at compile time and contribute no runtime dependency, so the
 * graph walker skips them.
 */
function collectImportSpecifiers(source: string): Array<{ specifier: string; typeOnly: boolean }> {
  const out: Array<{ specifier: string; typeOnly: boolean }> = [];
  const re = /(import|export)\s+(type\s+)?(?:[^'";]+?)?from\s+['"]([^'"]+)['"]/g;
  for (const m of source.matchAll(re)) {
    out.push({ specifier: m[3] as string, typeOnly: m[2] !== undefined });
  }
  return out;
}

function resolveImport(fromFile: string, specifier: string): string {
  const base = resolve(dirname(fromFile), specifier);
  // Source uses `.js` specifiers that resolve to `.ts` files (NodeNext style).
  const candidates = base.endsWith('.js')
    ? [base.replace(/\.js$/, '.ts'), base]
    : [base, `${base}.ts`, `${base}/index.ts`];
  const found = candidates.find((c) => existsSync(c));
  if (!found) {
    throw new Error(`Could not resolve import "${specifier}" from "${fromFile}"`);
  }
  return found as string;
}

/**
 * BFS over the runtime import graph of an entry file: follows relative
 * imports, skips type-only imports, dedupes via visited absolute paths, and
 * caps the depth to stay deterministic.
 */
function reachableFiles(entry: string): string[] {
  const visited = new Set<string>();
  const files: string[] = [];
  const queue: string[] = [resolve(entry)];
  const MAX_DEPTH = 100;
  let depth = 0;
  while (queue.length > 0 && depth < MAX_DEPTH) {
    depth += 1;
    const file = queue.shift() as string;
    const abs = resolve(file);
    if (visited.has(abs)) continue;
    visited.add(abs);
    files.push(abs);
    const source = readFileSync(abs, 'utf8');
    for (const { specifier, typeOnly } of collectImportSpecifiers(source)) {
      if (typeOnly) continue; // erased at compile time — no runtime dependency
      if (!specifier.startsWith('./') && !specifier.startsWith('../')) continue; // bare package / node: specifier
      queue.push(resolveImport(abs, specifier));
    }
  }
  return files;
}

describe('browser entry (src/browser.ts)', () => {
  it('exports the browser-safe library surface', () => {
    expect(typeof browser.ModelHitch).toBe('function');
    expect(typeof browser.LocalStorageKeyStore).toBe('function');
    expect(typeof browser.MemoryKeyStore).toBe('function');
    expect(Array.isArray(browser.defaultProviders)).toBe(true);
    expect(typeof browser.runToolLoop).toBe('function');
    expect(typeof browser.UsageTracker).toBe('function');
    expect(typeof browser.usageDashboardHtml).toBe('function');
    expect(typeof browser.aggregateStream).toBe('function');
    expect(typeof browser.parseSSE).toBe('function');
  });

  it('does not export Node-only surfaces', () => {
    const exports_ = browser as unknown as Record<string, unknown>;
    expect(exports_['OpenAICompatibleServer']).toBeUndefined();
    expect(exports_['createModelHitchServer']).toBeUndefined();
    expect(exports_['SqliteUsageStorage']).toBeUndefined();
  });

  it('reaches only browser-safe files: no `node:` imports in the graph', () => {
    const files = reachableFiles(resolve(repoRoot, 'src/browser.ts'));
    expect(files.length).toBeGreaterThan(0);

    const rel = files.map((f) => f.replace(repoRoot + sep, ''));
    expect(rel).not.toContain('src/server/server.ts');
    expect(rel).not.toContain('src/core/usage-storage.ts');

    const offenders = files.filter((f) => /from\s+['"]node:/.test(readFileSync(f, 'utf8')));
    expect(offenders).toEqual([]);
  });
});
