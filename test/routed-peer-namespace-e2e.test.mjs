import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function namespaceCapability() {
  if (process.platform !== 'linux' || typeof process.getuid !== 'function' || process.getuid() !== 0) return 'requires Linux root with network namespace capability';
  const probe = `xptest${process.pid.toString(36).slice(-6)}`;
  const added = spawnSync('ip', ['netns', 'add', probe], { encoding: 'utf8' });
  if (added.status !== 0) return (added.stderr || added.error?.message || 'ip netns add failed').trim();
  spawnSync('ip', ['netns', 'del', probe], { encoding: 'utf8' });
  return null;
}

test('routed invite E2E: isolated peer subnets pair and federate through a router namespace', { timeout: 120_000 }, async (t) => {
  const unavailable = namespaceCapability();
  if (unavailable) return t.skip(unavailable);
  const child = spawn(process.execPath, [path.join(repoRoot, 'test', 'manual-routed-peer-e2e.mjs')], {
    cwd: repoRoot,
    env: process.env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  t.after(() => {
    if (child.exitCode === null) child.kill('SIGTERM');
  });
  const stdout = [];
  const stderr = [];
  child.stdout.on('data', (data) => stdout.push(data.toString()));
  child.stderr.on('data', (data) => stderr.push(data.toString()));
  const result = await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code, signal) => resolve({ code, signal }));
  });
  const output = stdout.join('');
  assert.equal(result.code, 0, `routed E2E exited ${result.signal || result.code}:\n${output}\n${stderr.join('')}`);
  const proofLine = output.split(/\r?\n/).find((line) => line.trim().startsWith('{') && line.includes('"ok"'));
  assert.ok(proofLine, `expected machine-readable routed E2E proof:\n${output}`);
  const proof = JSON.parse(proofLine);
  assert.equal(proof.ok, true);
  assert.match(proof.topology, /distinct subnets via a forwarding router/);
  assert.match(proof.topology, /own hostname and PID namespace/);
  assert.match(proof.routeAtoB, /via 10\.245\./);
  assert.match(proof.routeBtoA, /via 10\.246\./);
  assert.deepEqual(proof.hostNames, ['xats-peer-left', 'xats-peer-right']);
  for (const url of proof.peerEndpoints) {
    assert.doesNotMatch(url, /127\.0\.0\.1|\[::1\]/, `peer endpoint must be a routed address: ${url}`);
  }
  for (const [leg, bytes] of Object.entries(proof.routerTransitBytes)) {
    assert.ok(bytes > 0, `router leg ${leg} must carry transit bytes, saw ${bytes}`);
  }
  assert.equal(proof.delivery, 'message across two routed namespaces');
  assert.equal(proof.filament, false);
});
