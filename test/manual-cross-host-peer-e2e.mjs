// Physical two-host check for Stage 1 peer networking.
//
//   machine A: node test/manual-cross-host-peer-e2e.mjs host --advertise <A-ip>
//   machine B: node test/manual-cross-host-peer-e2e.mjs join --advertise <B-ip> --invite-file <file>
//
// Transfer only the short-lived invite file between machines, out of band. Approval stays an
// explicit human action through the real CLI: the host prints the pending id and waits.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { startPeerRuntime, callPeerControl } from '../lib/peer-runtime.mjs';
import { mainPeer } from '../lib/peer-cli.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const daemonEntry = path.join(repoRoot, 'daemon', 'dist', 'cli.js');
const localAgent = { host: 'alice', join: 'bob' };
const remoteAgent = { host: 'bob', join: 'alice' };

function parseArgs(argv) {
  const [role, ...rest] = argv;
  if (!['host', 'join'].includes(role)) {
    throw new Error('usage: node test/manual-cross-host-peer-e2e.mjs host|join --advertise <ip> [--peer-port N] [--invite-file PATH] [--run-id ID]');
  }
  const options = {};
  for (let i = 0; i < rest.length; i += 1) {
    if (!rest[i].startsWith('--')) throw new Error(`unexpected_argument:${rest[i]}`);
    const key = rest[i].slice(2);
    const value = rest[i + 1];
    if (value === undefined || value.startsWith('--')) throw new Error(`missing_value:${rest[i]}`);
    options[key] = value;
    i += 1;
  }
  return { role, options };
}

function firstExternalIPv4() {
  for (const entries of Object.values(os.networkInterfaces())) {
    for (const item of entries || []) {
      const family = typeof item.family === 'string' ? item.family : item.family === 4 ? 'IPv4' : 'IPv6';
      if (family === 'IPv4' && !item.internal && net.isIP(item.address) === 4) return item.address;
    }
  }
  return null;
}

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => server.once('error', reject).listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return port;
}

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function waitFor(check, label, timeoutMs = 300_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const value = await check();
      if (value) return value;
    } catch (error) { lastError = error; }
    await delay(500);
  }
  throw new Error(`${label}_timeout${lastError ? `: ${lastError.message}` : ''}`);
}

const { role, options } = parseArgs(process.argv.slice(2));
const useStubDaemon = options.daemon === 'stub';
const advertise = options.advertise || firstExternalIPv4();
if (!advertise || net.isIP(advertise) !== 4) throw new Error('pass --advertise <ipv4 reachable by the other machine>');
if (role === 'join' && !options['invite-file']) throw new Error('join_requires_--invite-file');
if (!fs.existsSync(daemonEntry) && !useStubDaemon) throw new Error(`bundled_daemon_missing:${daemonEntry}`);

const runId = options['run-id'] || randomUUID();
const base = fs.mkdtempSync(path.join(os.tmpdir(), `xats-cross-host-${role}-`));
const stateDir = process.env.XATS_CROSS_HOST_STATE_DIR
  ? path.resolve(process.env.XATS_CROSS_HOST_STATE_DIR)
  : path.join(base, 'peer');
const daemonHome = path.join(base, 'daemon');
const inviteFile = role === 'host'
  ? path.resolve(options['invite-file'] || path.join(base, 'peer.invite'))
  : path.resolve(options['invite-file']);
const message = `xats-cross-host:${runId}`;
const reply = `xats-cross-host-reply:${runId}`;
const ack = `xats-cross-host-ack:${runId}`;
let daemon = null;
let runtime = null;

async function startDaemon() {
  fs.mkdirSync(daemonHome, { recursive: true });
  const port = await freePort();
  const logs = [];
  const child = useStubDaemon
    ? spawn(process.execPath, [path.join(repoRoot, 'test', 'helpers', 'stub-daemon.mjs'), '--port', String(port)], {
      cwd: repoRoot, env: process.env, stdio: ['ignore', 'pipe', 'pipe'],
    })
    : spawn(process.execPath, [
      daemonEntry, 'daemon', '--port', String(port), '--host', '127.0.0.1',
      '--db', path.join(daemonHome, 'data.db'), '--pid-file', path.join(daemonHome, 'daemon.pid'),
      '--device', `cross-host-${role}`,
    ], { cwd: repoRoot, env: { ...process.env, CROSS_AGENT_TEAMS_MCP_HOME: daemonHome }, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.on('data', (data) => logs.push(data.toString()));
  child.stderr.on('data', (data) => logs.push(data.toString()));
  await waitFor(async () => {
    if (child.exitCode !== null) throw new Error(logs.join('').slice(-2000) || 'daemon_exited');
    const response = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(1000) });
    return response.ok;
  }, 'daemon_ready', 40_000);
  daemon = { port, child };
}

async function api(method, pathname, body = null) {
  const response = await fetch(`http://127.0.0.1:${daemon.port}${pathname}`, {
    method,
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(5000),
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || `daemon_http_${response.status}`);
  return data;
}

const cli = (args) => mainPeer(args, { stateDir });
const shadow = (suffix) => waitFor(async () => {
  await runtime.federation.syncOnce();
  const roster = await api('GET', '/api/agents/all');
  return roster.agents.find((agent) => agent.agent_type_name === 'xats-peer-shadow' && agent.name.endsWith(`_${suffix}`));
}, `shadow_${suffix}`);

try {
  await startDaemon();
  await api('POST', '/api/register', { name: localAgent[role], team: 'default', role: 'worker', agent_type: 'custom' });
  runtime = await startPeerRuntime({
    stateDir,
    host: '::',
    port: options['peer-port'] ? Number(options['peer-port']) : null,
    mdns: false,
    daemonPort: daemon.port,
    onLog: () => {},
  });
  const endpoint = `https://${advertise}:${runtime.peerPort}`;

  if (role === 'host') {
    await cli(['invite', '--endpoint', endpoint, '--out', inviteFile]);
    console.log(JSON.stringify({
      event: 'host-ready',
      runId,
      endpoint,
      inviteFile,
      hostDeviceId: runtime.identity.deviceId,
      instruction: 'Transfer the private invite file to the second machine over a secure out-of-band channel, then run the join command there.',
    }));
    await waitFor(async () => (await callPeerControl({ stateDir, endpoint: '/status' })).pending.length > 0, 'pending_pair_request');
    const pending = (await callPeerControl({ stateDir, endpoint: '/status' })).pending[0];
    console.log(JSON.stringify({
      event: 'approval-required',
      pendingId: pending.pendingId,
      deviceId: pending.deviceId,
      instruction: `Verify this device id out of band, then run: xats-setup peer approve ${pending.pendingId} --label remote-host`,
    }));
    const trusted = await waitFor(async () => (await callPeerControl({ stateDir, endpoint: '/status' })).peers[0], 'explicit_approval');
    console.log(JSON.stringify({ event: 'approved', remoteDeviceId: trusted.deviceId }));

    const remoteShadow = await shadow(remoteAgent[role]);
    await api('POST', '/api/send', {
      from: { team: 'default', name: localAgent[role] },
      to: { team: 'default', name: remoteShadow.name },
      subject: `cross-host:${runId}`,
      body: message,
    });
    const received = await waitFor(async () => {
      await runtime.federation.syncOnce();
      const inbox = await api('GET', `/api/inbox?team=default&name=${localAgent[role]}&since_event_id=0`);
      return inbox.messages.find((item) => item.body === reply);
    }, 'reply_delivery');
    assert.equal(received.body, reply);
    await api('POST', '/api/send', {
      from: { team: 'default', name: localAgent[role] },
      to: { team: 'default', name: remoteShadow.name },
      subject: `cross-host-ack:${runId}`,
      body: ack,
    });
    // Keep the host federation alive long enough to forward the final ack.
    for (let i = 0; i < 16; i += 1) {
      await runtime.federation.syncOnce().catch(() => {});
      await delay(250);
    }
    console.log(JSON.stringify({
      event: 'host-result',
      ok: true,
      runId,
      peerDeviceId: trusted.deviceId,
      endpoint,
      remotePeerReachable: true,
      sent: message,
      received: received.body,
      filament: false,
    }));
  } else {
    if (!fs.existsSync(inviteFile)) throw new Error(`invite_file_not_found:${inviteFile}`);
    await cli(['pair', '--invite-file', inviteFile, '--endpoint', endpoint, '--label', 'remote-host']);
    console.log(JSON.stringify({ event: 'join-paired', endpoint, joinDeviceId: runtime.identity.deviceId, runId }));
    const received = await waitFor(async () => {
      await runtime.federation.syncOnce();
      const inbox = await api('GET', `/api/inbox?team=default&name=${localAgent[role]}&since_event_id=0`);
      return inbox.messages.find((item) => item.body === message);
    }, 'message_delivery');
    const remoteShadow = await shadow(remoteAgent[role]);
    await api('POST', '/api/send', {
      from: { team: 'default', name: localAgent[role] },
      to: { team: 'default', name: remoteShadow.name },
      subject: `cross-host-reply:${runId}`,
      body: reply,
    });
    const acknowledged = await waitFor(async () => {
      await runtime.federation.syncOnce();
      const inbox = await api('GET', `/api/inbox?team=default&name=${localAgent[role]}&since_event_id=0`);
      return inbox.messages.find((item) => item.body === ack);
    }, 'ack_delivery');
    console.log(JSON.stringify({ event: 'join-result', ok: true, runId, endpoint, received: received.body, replied: reply, ack: acknowledged.body, filament: false }));
  }
} finally {
  await runtime?.close().catch(() => {});
  if (daemon && daemon.child.exitCode === null) {
    daemon.child.kill('SIGTERM');
    await Promise.race([once(daemon.child, 'exit').catch(() => {}), delay(7000)]);
    if (daemon.child.exitCode === null) daemon.child.kill('SIGKILL');
  }
  fs.rmSync(base, { recursive: true, force: true });
}
