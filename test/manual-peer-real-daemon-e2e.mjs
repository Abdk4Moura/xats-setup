// Manual end-to-end proof using the bundled patched daemon asset and the user-facing peer CLI.
// fastify/better-sqlite3/MCP dependencies are provided by the pinned devDependency.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { startPeerRuntime, callPeerControl } from '../lib/peer-runtime.mjs';
import { mainPeer } from '../lib/peer-cli.mjs';

function reachableIPv4() {
  for (const entries of Object.values(os.networkInterfaces())) {
    for (const item of entries || []) {
      const family = typeof item.family === 'string' ? item.family : item.family === 4 ? 'IPv4' : 'IPv6';
      if (family === 'IPv4' && !item.internal && net.isIP(item.address) === 4) return item.address;
    }
  }
  throw new Error('no_non_loopback_ipv4_interface');
}

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => server.once('error', reject).listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function waitFor(check, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try { const result = await check(); if (result) return result; }
    catch (error) { lastError = error; }
    await delay(100);
  }
  throw lastError || new Error('real_daemon_e2e_timeout');
}

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const daemonEntry = path.join(repoRoot, 'assets', 'daemon', 'cli.js');
if (!fs.existsSync(daemonEntry)) throw new Error(`bundled_daemon_missing: ${daemonEntry}`);
const address = reachableIPv4();
const base = fs.mkdtempSync(path.join(os.tmpdir(), 'xats-real-peer-e2e-'));
const daemons = [];
let leftPeer;
let rightPeer;

async function startDaemon(id) {
  const dir = path.join(base, `daemon-${id}`);
  fs.mkdirSync(dir, { recursive: true });
  const port = await freePort();
  const logs = [];
  const child = spawn(process.execPath, [daemonEntry, 'daemon', '--port', String(port), '--host', '127.0.0.1', '--db', path.join(dir, 'data.db'), '--pid-file', path.join(dir, 'daemon.pid'), '--device', id], {
    env: { ...process.env, CROSS_AGENT_TEAMS_MCP_HOME: dir },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (data) => logs.push(data.toString()));
  child.stderr.on('data', (data) => logs.push(data.toString()));
  try {
    await waitFor(async () => {
      if (child.exitCode !== null) throw new Error(logs.join(''));
      const response = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(1000) });
      return response.ok;
    });
  } catch (error) {
    if (child.exitCode === null) {
      child.kill('SIGTERM');
      await Promise.race([once(child, 'exit'), delay(3000)]);
      if (child.exitCode === null) child.kill('SIGKILL');
    }
    throw new Error(logs.join('') || error.message);
  }
  return {
    port,
    async close() {
      if (child.exitCode === null) {
        child.kill('SIGTERM');
        await Promise.race([once(child, 'exit'), delay(7000)]);
        if (child.exitCode === null) child.kill('SIGKILL');
      }
    },
  };
}
async function api(port, method, pathname, body) {
  const response = await fetch(`http://127.0.0.1:${port}${pathname}`, {
    method,
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(3000),
  });
  const data = await response.json();
  if (!response.ok) throw new Error(`${response.status} ${JSON.stringify(data)}`);
  return data;
}

try {
  const leftDaemon = await startDaemon('left');
  daemons.push(leftDaemon);
  const rightDaemon = await startDaemon('right');
  daemons.push(rightDaemon);
  await api(leftDaemon.port, 'POST', '/api/register', { name: 'alice', team: 'default', role: 'worker', agent_type: 'custom' });
  await api(rightDaemon.port, 'POST', '/api/register', { name: 'bob', team: 'default', role: 'worker', agent_type: 'custom' });

  const leftDir = path.join(base, 'peer-left');
  const rightDir = path.join(base, 'peer-right');
  leftPeer = await startPeerRuntime({ stateDir: leftDir, host: '::', port: 0, mdns: false, daemonPort: leftDaemon.port, onLog() {} });
  rightPeer = await startPeerRuntime({ stateDir: rightDir, host: '::', port: 0, mdns: false, daemonPort: rightDaemon.port, onLog() {} });
  const leftEndpoint = `https://${address}:${leftPeer.peerPort}`;
  const rightEndpoint = `https://${address}:${rightPeer.peerPort}`;
  const invitePath = path.join(base, 'peer.invite');

  await mainPeer(['invite', '--endpoint', leftEndpoint, '--out', invitePath], { stateDir: leftDir });
  const pairing = mainPeer(['pair', '--invite-file', invitePath, '--endpoint', rightEndpoint, '--label', 'left-instance'], { stateDir: rightDir });
  const pending = await waitFor(async () => (await callPeerControl({ stateDir: leftDir, endpoint: '/pending' })).pending[0]);
  await mainPeer(['approve', pending.pendingId, '--label', 'right-instance'], { stateDir: leftDir });
  await pairing;

  const shadow = await waitFor(async () => {
    await leftPeer.federation.syncOnce();
    const roster = await api(leftDaemon.port, 'GET', '/api/agents/all');
    return roster.agents.find((agent) => agent.agent_type_name === 'xats-peer-shadow' && agent.name.endsWith('_bob'));
  });
  await api(leftDaemon.port, 'POST', '/api/send', {
    from: { team: 'default', name: 'alice' },
    to: { team: 'default', name: shadow.name },
    subject: 'real daemon, user-facing invite flow',
    body: 'hello over a directly reachable peer interface',
  });
  const delivered = await waitFor(async () => {
    await leftPeer.federation.syncOnce();
    await rightPeer.federation.syncOnce();
    const inbox = await api(rightDaemon.port, 'GET', '/api/inbox?team=default&name=bob&since_event_id=0');
    return inbox.messages.find((message) => message.body === 'hello over a directly reachable peer interface');
  });
  assert.equal(delivered.body, 'hello over a directly reachable peer interface');
  console.log(JSON.stringify({
    ok: true,
    pairing: 'user-facing invite + explicit approval',
    interface: address,
    delivered: delivered.body,
    from: delivered.from_name,
    filament: false,
  }));
} finally {
  await leftPeer?.close();
  await rightPeer?.close();
  for (const daemon of daemons) await daemon.close();
  fs.rmSync(base, { recursive: true, force: true });
}
