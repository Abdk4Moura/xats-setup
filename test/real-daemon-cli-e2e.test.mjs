import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import net from 'node:net';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

function hasReachableIPv4() {
  for (const entries of Object.values(os.networkInterfaces())) {
    for (const item of entries || []) {
      const family = typeof item.family === 'string' ? item.family : item.family === 4 ? 'IPv4' : 'IPv6';
      if (family === 'IPv4' && !item.internal && net.isIP(item.address) === 4) return true;
    }
  }
  return false;
}

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('bundled daemon E2E: user-facing invite/approval CLI delivers between two real daemon processes', { timeout: 120_000 }, async (t) => {
  if (!hasReachableIPv4()) return t.skip('no non-loopback IPv4 interface available for direct peer E2E');
  const child = spawn(process.execPath, [path.join(repoRoot, 'test', 'manual-peer-real-daemon-e2e.mjs')], {
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
  assert.equal(result.code, 0, `real daemon E2E exited ${result.signal || result.code}:\n${output}\n${stderr.join('')}`);
  const proofLine = output.split(/\r?\n/).find((line) => line.trim().startsWith('{') && line.includes('"ok"'));
  assert.ok(proofLine, `expected machine-readable E2E proof in output:\n${output}`);
  const proof = JSON.parse(proofLine);
  assert.equal(proof.ok, true);
  assert.equal(proof.filament, false);
  assert.notEqual(proof.interface, '127.0.0.1');
  assert.equal(proof.pairing, 'user-facing invite + explicit approval');
  assert.equal(proof.delivered, 'hello over a directly reachable peer interface');
});
