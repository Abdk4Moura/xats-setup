#!/usr/bin/env node
// Missing or silently skipped critical tests must not look like a green run.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const criticalTests = [
  'same preferred name from two sessions stays two distinct identities',
  'every REST endpoint the adapters rely on exists and answers',
  'invalid last-selected agy config prevents all earlier component writes',
  'native process/socket ownership keeps a healthy nondefault port and unchanged daemon PID',
  'daemon schema restart preserves zero unread cursors until an actual inbox read',
  'presence expiry marks every agent offline without destroying identity',
  'send_message addresses by name [ref] and never guesses on ambiguity',
];

export function assertCoverage(log, { files, platform = process.platform }) {
  const manifest = log.match(/^# xats-test-files: (.+)$/m);
  assert.ok(manifest, 'test runner did not publish its file manifest');
  assert.deepEqual(JSON.parse(manifest[1]), [...files].sort(), 'test-file selection was truncated');
  const failures = [...log.matchAll(/^# fail (\d+)\s*$/gm)].map(match => Number(match[1]));
  assert.ok(failures.length && failures.every(count => count === 0), 'suite did not report zero failures');
  for (const name of criticalTests) {
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    assert.match(log, new RegExp(`^ok \\d+ - ${escaped}\\s*$`, 'm'), `Critical test missing, failed, or skipped: ${name}`);
  }
  const skips = [];
  for (const line of log.split(/\r?\n/)) {
    const match = line.match(/^\s*ok \d+ - (.*?)\s+# SKIP(?:\s|$)/);
    if (!match) continue;
    const name = match[1];
    const namespace = name === 'routed invite E2E: isolated peer subnets pair and federate through a router namespace';
    const platformOnly = platform !== 'linux' && name === 'custom supervisor rejection happens before daemon or earlier agent files change';
    assert.ok(namespace || platformOnly, `Unexpected skipped test: ${name}`);
    skips.push(name);
  }
  return { fileCount: files.length, skips };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const repo = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
  assert.ok(process.argv[2], 'Pass the captured npm test log');
  const files = fs.readdirSync(path.join(repo, 'test')).filter(name => name.endsWith('.test.mjs')).sort();
  const result = assertCoverage(fs.readFileSync(process.argv[2], 'utf8'), { files });
  for (const name of result.skips) console.log(`Explicit platform/capability skip: ${name}`);
  console.log(`All ${result.fileCount} test files selected; critical tests ran; no unexpected skips.`);
}
