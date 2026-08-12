// Creates (or skips) the GitHub release for the current package.json version.
// Usage: node scripts/gh-release.mjs
//
// Part of the `npm run release*` chain — runs after `npm version <type>` bumped
// the version and the tag v<version> exists. Uses gh's --generate-notes so the
// notes are auto-built from commits/PRs; edit on the GitHub page if desired.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const { version } = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const tag = `v${version}`;

// Idempotent: skip if the release already exists.
try {
  execFileSync('gh', ['release', 'view', tag], { stdio: 'pipe' });
  console.log(`Release ${tag} already exists — skipping.`);
  process.exit(0);
} catch {
  // not created yet — fall through
}

execFileSync('gh', ['release', 'create', tag, '--title', tag, '--generate-notes'], {
  stdio: 'inherit',
});
console.log(`Created GitHub release ${tag}.`);
