#!/usr/bin/env node
// Deterministic test entry point.
//
// Depending on shell globbing silently breaks on Windows (`cmd` does not expand
// globs), and depending on Node's own `**` glob produced a different test count
// in CI than locally (47 vs 90) — which would have let most of the suite go
// uncovered while reporting green. So: enumerate the files ourselves and pass
// explicit paths to `node --test`.
import { readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const testDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'test');

const files = readdirSync(testDir)
  .filter((name) => name.endsWith('.test.mjs'))
  .sort()
  .map((name) => path.join(testDir, name));

if (files.length === 0) {
  console.error('no test files found in test/');
  process.exit(1);
}

const result = spawnSync(process.execPath, ['--test', ...files], { stdio: 'inherit' });
// Propagate the runner's exit status; default to failure if it did not report one.
process.exit(result.status ?? 1);
