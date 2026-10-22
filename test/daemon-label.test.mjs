import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.join(HERE, '..', 'assets', 'daemon', 'cli.js');

function findDeps() {
  for (const dir of [process.env.XATS_SETUP_TEST_DEPS, path.join(os.homedir(), '.xats', 'daemon', 'node_modules')].filter(Boolean)) {
    try { if (fs.statSync(path.join(dir, 'fastify')).isDirectory()) return dir; } catch { /* next */ }
  }
  return null;
}

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.on('error', reject);
    s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
  });
}

async function startDaemon({ device = null, timeoutMs = 20_000 } = {}) {
  const deps = findDeps();
  if (!deps) return { skip: 'daemon dependencies not installed (set XATS_SETUP_TEST_DEPS)' };
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xats-label-'));
  fs.symlinkSync(deps, path.join(root, 'node_modules'), 'dir');
  const cli = path.join(root, 'cli.js');
  fs.copyFileSync(CLI, cli);
  const home = path.join(root, 'home');
  fs.mkdirSync(home, { recursive: true });
  const port = await freePort();
  const args = [cli, 'daemon', '--port', String(port), '--db', path.join(root, 'data.db')];
  if (device !== null) args.push('--device', device);
  const proc = spawn(process.execPath, args, {
    env: { ...process.env, CROSS_AGENT_TEAMS_MCP_HOME: home },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stderr = '';
  proc.stderr.on('data', (c) => { stderr += String(c); });
  const base = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (proc.exitCode !== null) {
      throw new Error(`daemon exited early (code ${proc.exitCode})\n--- stderr ---\n${stderr.slice(-1500)}`);
    }
    try { const res = await fetch(`${base}/health`); if (res.ok) return { proc, base, stderr }; } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 150));
  }
  proc.kill('SIGKILL');
  throw new Error(`daemon never became healthy\n--- stderr ---\n${stderr.slice(-1500)}`);
}

test('the daemon starts from the hostname alone, whatever the host is called', { timeout: 60_000 }, async (t) => {
  // Regression: a 67-character macOS runner hostname made resolveLocalDeviceLabel
  // throw invalid_device_label, so the daemon exited before serving anything. A
  // hostname is not a contract; it must never prevent startup.
  const started = await startDaemon();
  if (started.skip) return t.skip(started.skip);
  t.after(() => started.proc.kill('SIGKILL'));
  const health = await fetch(`${started.base}/health`).then((r) => r.json());
  assert.equal(health.ok, true);
  assert.ok(health.uptime_seconds !== undefined);
});

test('an explicit unusable device label is still refused', { timeout: 60_000 }, async (t) => {
  // Explicit labels remain a contract: the caller asked for this name, so a
  // silent rename would be worse than a clear failure.
  const deps = findDeps();
  if (!deps) return t.skip('daemon dependencies not installed (set XATS_SETUP_TEST_DEPS)');
  await assert.rejects(() => startDaemon({ device: 'x'.repeat(80), timeoutMs: 15_000 }), /invalid_device_label|exited early/);
});
