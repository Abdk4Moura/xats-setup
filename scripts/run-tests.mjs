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

// Default to one worker on developer machines. CI explicitly requests bounded
// per-file parallelism; each file still gets its own isolated Node process.
const concurrency = Number(process.env.XATS_TEST_CONCURRENCY ?? '1');
if (!Number.isSafeInteger(concurrency) || concurrency < 1 || concurrency > 8) {
  console.error('XATS_TEST_CONCURRENCY must be an integer from 1 to 8');
  process.exit(1);
}
console.log('# xats-test-files: ' + JSON.stringify(files.map(file => path.basename(file))));
const result = spawnSync(process.execPath, ['--test', '--test-reporter=tap', `--test-concurrency=${concurrency}`, ...files], { stdio: 'inherit' });
// Propagate the runner's exit status; default to failure if it did not report one.
process.exit(result.status ?? 1);
