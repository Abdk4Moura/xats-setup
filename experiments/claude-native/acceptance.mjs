#!/usr/bin/env node
// Linux-only experimental protocol acceptance. No real model/provider account.
// Actual CLI + local model stub + owned ephemeral xats backend, never a live bus.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '../..');
assert.equal(process.platform, 'linux', 'Experimental native acceptance currently requires Linux SO_PEERCRED');
const pins = JSON.parse(fs.readFileSync(path.join(repo, 'scripts/ci-host-versions.json'), 'utf8'));
assert.equal(pins.claude.version, '2.1.295', 'Review protocol fixtures before changing the native CLI pin');
const tools = process.env.XATS_CI_HOST_TOOLS;
const cli = process.env.XATS_NATIVE_CLAUDE || (tools && path.join(tools, `claude-${pins.claude.version}`, 'node_modules/.bin/claude'));
assert.ok(cli && fs.existsSync(cli), 'Set XATS_NATIVE_CLAUDE or provision pinned tools first');
const daemon = path.join(repo, 'daemon/dist/cli.js');
assert.ok(fs.existsSync(daemon), 'Build current daemon source before native acceptance');
const scratch = fs.mkdtempSync(path.join(process.env.RUNNER_TEMP || os.tmpdir(), 'xn-'));
fs.chmodSync(scratch, 0o700);
const env = {
  PATH: process.env.PATH || '/usr/local/bin:/usr/bin:/bin',
  HOME: scratch, TMPDIR: scratch, CI: '1', LANG: 'C.UTF-8',
  XATS_NATIVE_CLAUDE: path.resolve(cli),
  XATS_NATIVE_RESULTS: path.join(scratch, 'results'),
  XATS_NATIVE_DAEMON_ENTRY: daemon,
};
function run(args) {
  const r = spawnSync('python3', ['-I', '-B', ...args], {
    cwd: repo, env, encoding: 'utf8', timeout: 90000, maxBuffer: 2 * 1024 * 1024,
  });
  if (r.stdout) process.stdout.write(r.stdout);
  if (r.stderr) process.stderr.write(r.stderr);
  if (r.error) throw r.error;
  assert.equal(r.status, 0, 'Native experiment command failed; do not silently skip unsupported capabilities');
  return `${r.stdout || ''}\n${r.stderr || ''}`;
}
function probe(file, args = []) {
  const launcher = 'import runpy,sys;from pathlib import Path;p=sys.argv[1];sys.path.insert(0,str(Path(p).resolve().parent));sys.argv=sys.argv[1:];runpy.run_path(p,run_name="__main__")';
  return run(['-c', launcher, path.join(here, file), ...args]);
}
try {
  const unit = run(['-m', 'unittest', 'discover', '-s', here, '-p', 'test_*.py', '-v']);
  assert.match(unit, /Ran [1-9]\d* tests? in/);
  assert.doesNotMatch(unit, /skipped|expected failure|unexpected success/i);
  const adapterUnit = run(['-m', 'unittest', 'discover', '-s', path.join(repo, 'test/native-peer'), '-p', 'test_*.py', '-v']);
  assert.match(adapterUnit, /Ran [1-9]\d* tests? in/);
  assert.doesNotMatch(adapterUnit, /skipped|expected failure|unexpected success/i);
  probe('policy_probe.py', ['--policy', 'refuse']);
  probe('policy_probe.py', ['--policy', 'hold']);
  probe('outbound_probe.py');
  const reports = fs.readdirSync(env.XATS_NATIVE_RESULTS).filter(name => name.endsWith('.json'))
    .map(name => JSON.parse(fs.readFileSync(path.join(env.XATS_NATIVE_RESULTS, name), 'utf8')));
  assert.equal(reports.length, 3);
  const outbound = reports.find(report => report.synthetic_model);
  assert.equal(outbound?.xats_restart_and_duplicate_checks, true);
  assert.equal(outbound?.native_receipt_sent, 'delivered');
  assert.equal(outbound?.exit, 0);
  assert.equal(outbound?.real_model_inference, false);
  assert.equal(outbound?.external_registry_records_written, 0);
  assert.equal(outbound?.private_key_files_read_by_probe, 0);
  for (const policy of ['hold', 'refuse']) {
    const report = reports.find(report => report.policy === policy);
    assert.equal(report?.model_requests, 0);
    assert.equal(report?.private_key_files_read_by_probe, 0);
    assert.ok(report?.receipts.some(receipt => receipt.status === (policy === 'hold' ? 'held' : 'refused')
      && receipt.correlated && receipt.process_start_matches));
  }
  const nativeAdapter = spawnSync(process.execPath, [path.join(repo, 'scripts/acceptance-native-peers.mjs')], {
    cwd: repo, env, encoding: 'utf8', timeout: 90000, maxBuffer: 2 * 1024 * 1024,
  });
  if (nativeAdapter.stdout) process.stdout.write(nativeAdapter.stdout);
  if (nativeAdapter.stderr) process.stderr.write(nativeAdapter.stderr);
  if (nativeAdapter.error) throw nativeAdapter.error;
  assert.equal(nativeAdapter.status, 0, 'Actual default native peer adapter acceptance failed');
  console.log('Experimental Linux native protocol acceptance passed: refusal, hold, actual native SendMessage, xats mailbox commit, duplicate fencing, and backend restart. Synthetic model only; no production transport enabled.');
} finally {
  fs.rmSync(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
