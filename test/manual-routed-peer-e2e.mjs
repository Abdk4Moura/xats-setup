// Linux network-namespace E2E: two isolated peer stacks on different subnets, routed
// by a third namespace. The bundled daemons remain loopback-bound in their own stacks.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

if (process.platform !== 'linux' || typeof process.getuid !== 'function' || process.getuid() !== 0) {
  throw new Error('routed_namespace_e2e_requires_linux_root');
}

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const daemonEntry = path.join(repoRoot, 'daemon', 'dist', 'cli.js');
const workerEntry = path.join(repoRoot, 'test', 'helpers', 'routed-peer-worker.mjs');
const cliRunner = path.join(repoRoot, 'test', 'helpers', 'peer-cli-runner.mjs');
const suffix = `${process.pid.toString(36).slice(-4)}${Math.floor(Math.random() * 36).toString(36)}`;
const nsA = `xa${suffix}a`;
const nsB = `xa${suffix}b`;
const nsRouter = `xa${suffix}r`;
const vA = `va${suffix}`;
const rA = `ra${suffix}`;
const vB = `vb${suffix}`;
const rB = `rb${suffix}`;
const octet = (process.pid % 200) + 20;
const ipA = `10.245.${octet}.2`;
const gwA = `10.245.${octet}.1`;
const ipB = `10.246.${octet}.2`;
const gwB = `10.246.${octet}.1`;
const daemonPort = 9237;
const daemonChildren = [];
const cliChildren = [];
const namespaceNames = [];
let workerA;
let workerB;
const base = fs.mkdtempSync(path.join(os.tmpdir(), 'xats-routed-peer-e2e-'));

function ip(args) {
  return execFileSync('ip', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function waitFor(check, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const value = await check();
      if (value) return value;
    } catch (error) { lastError = error; }
    await delay(100);
  }
  throw lastError || new Error('routed_peer_e2e_timeout');
}

function spawnInNamespace(namespace, args, { env = process.env, stdin = 'ignore', hostName = null } = {}) {
  const isolated = hostName
    ? ['unshare', '--uts', '--ipc', '--pid', '--fork', '--mount', '--mount-proc', '--', 'sh', '-c', 'hostname "$XATS_NS_HOSTNAME"; exec "$@"', 'sh', process.execPath, ...args]
    : [process.execPath, ...args];
  const child = spawn('ip', ['netns', 'exec', namespace, ...isolated], {
    cwd: repoRoot,
    env: hostName ? { ...env, XATS_NS_HOSTNAME: hostName } : env,
    stdio: [stdin, 'pipe', 'pipe'],
  });
  const stdout = [];
  const stderr = [];
  child.stdout.on('data', (data) => stdout.push(data.toString()));
  child.stderr.on('data', (data) => stderr.push(data.toString()));
  const done = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code, signal) => resolve({ code, signal, stdout: stdout.join(''), stderr: stderr.join('') }));
  });
  return { child, done, stdout, stderr };
}

async function stopChild(child) {
  if (!child || child.exitCode !== null) return;
  child.kill('SIGTERM');
  await Promise.race([once(child, 'exit').catch(() => {}), delay(5000)]);
  if (child.exitCode === null) {
    child.kill('SIGKILL');
    await Promise.race([once(child, 'exit').catch(() => {}), delay(2000)]);
  }
}

async function daemonHealth(namespace) {
  const js = `try { const r = await fetch('http://127.0.0.1:${daemonPort}/health', { signal: AbortSignal.timeout(500) }); process.stdout.write(r.ok ? 'ready' : 'not-ready'); } catch { process.exit(1); }`;
  const output = execFileSync('ip', ['netns', 'exec', namespace, process.execPath, '--input-type=module', '-e', js], {
    encoding: 'utf8',
    timeout: 1500,
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  return output.trim() === 'ready';
}

async function startDaemon(namespace, id, dir) {
  fs.mkdirSync(dir, { recursive: true });
  const started = spawnInNamespace(namespace, [
    daemonEntry, 'daemon', '--port', String(daemonPort), '--host', '127.0.0.1',
    '--db', path.join(dir, 'data.db'), '--pid-file', path.join(dir, 'daemon.pid'), '--device', id,
  ], { env: { ...process.env, CROSS_AGENT_TEAMS_MCP_HOME: dir } });
  daemonChildren.push(started.child);
  await waitFor(async () => {
    if (started.child.exitCode !== null) throw new Error(started.stderr.join('') || `daemon_${id}_exited`);
    try { return await daemonHealth(namespace); }
    catch { return false; }
  });
  return started;
}

function linkBytes(namespace, interfaceName) {
  const read = (counter) => Number(execFileSync(
    'ip',
    ['netns', 'exec', namespace, 'cat', `/sys/class/net/${interfaceName}/statistics/${counter}`],
    { encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] },
  ).trim());
  const rx = read('rx_bytes');
  const tx = read('tx_bytes');
  if (!Number.isFinite(rx) || !Number.isFinite(tx)) throw new Error(`link_counters_unavailable:${namespace}:${interfaceName}`);
  return { rx, tx };
}

function routerTransit(before) {
  return {
    legAToRouter: linkBytes(nsRouter, rA).rx - before[rA].rx,
    legRouterToB: linkBytes(nsRouter, rB).tx - before[rB].tx,
    legBToRouter: linkBytes(nsRouter, rB).rx - before[rB].rx,
    legRouterToA: linkBytes(nsRouter, rA).tx - before[rA].tx,
  };
}

function startWorker(namespace, stateDir, host, hostName) {
  fs.mkdirSync(stateDir, { recursive: true });
  const { child } = spawnInNamespace(namespace, [workerEntry, stateDir, String(daemonPort), host], { stdin: 'pipe', hostName });
  let stderrText = '';
  child.stderr.on('data', (data) => { stderrText += data.toString(); });
  const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
  const iterator = lines[Symbol.asyncIterator]();
  let requestId = 0;
  async function nextMessage() {
    const { value, done } = await iterator.next();
    if (done) throw new Error(stderrText || 'peer_worker_exited');
    try { return JSON.parse(value); }
    catch { throw new Error(`peer_worker_invalid_output: ${value}`); }
  }
  const exited = once(child, 'close');
  const worker = {
    child,
    async request(op, fields = {}) {
      const id = ++requestId;
      child.stdin.write(`${JSON.stringify({ id, op, ...fields })}\n`);
      const response = await nextMessage();
      if (response.id !== id) throw new Error(`peer_worker_response_mismatch: ${JSON.stringify(response)}`);
      if (!response.ok) throw new Error(response.error || 'peer_worker_request_failed');
      return response.result;
    },
    async stop() {
      if (child.exitCode !== null) return;
      try { await worker.request('stop'); } catch { child.kill('SIGTERM'); }
      child.stdin.end();
      await Promise.race([exited, delay(5000)]);
      if (child.exitCode === null) await stopChild(child);
      lines.close();
    },
  };
  worker.ready = nextMessage();
  return worker;
}

function startCli(namespace, stateDir, args) {
  const result = spawnInNamespace(namespace, [cliRunner, stateDir, ...args]);
  cliChildren.push(result.child);
  return result;
}
async function runCli(namespace, stateDir, args) {
  const result = await startCli(namespace, stateDir, args).done;
  if (result.code !== 0) throw new Error(`peer_cli_failed (${result.signal || result.code}): ${result.stderr || result.stdout}`);
  return result.stdout;
}
function pendingId(output) {
  const line = output.split(/\r?\n/).map((value) => value.trim()).find((value) => /^[a-f0-9]{32}\s/.test(value));
  return line?.split(/\s+/)[0] || null;
}

async function configureNetwork() {
  for (const namespace of [nsA, nsB, nsRouter]) {
    ip(['netns', 'add', namespace]);
    namespaceNames.push(namespace);
    ip(['-n', namespace, 'link', 'set', 'lo', 'up']);
  }
  ip(['link', 'add', vA, 'type', 'veth', 'peer', 'name', rA]);
  ip(['link', 'set', vA, 'netns', nsA]);
  ip(['link', 'set', rA, 'netns', nsRouter]);
  ip(['link', 'add', vB, 'type', 'veth', 'peer', 'name', rB]);
  ip(['link', 'set', vB, 'netns', nsB]);
  ip(['link', 'set', rB, 'netns', nsRouter]);

  ip(['-n', nsA, 'addr', 'add', `${ipA}/24`, 'dev', vA]);
  ip(['-n', nsA, 'link', 'set', vA, 'up']);
  ip(['-n', nsA, 'route', 'add', 'default', 'via', gwA]);
  ip(['-n', nsB, 'addr', 'add', `${ipB}/24`, 'dev', vB]);
  ip(['-n', nsB, 'link', 'set', vB, 'up']);
  ip(['-n', nsB, 'route', 'add', 'default', 'via', gwB]);
  ip(['-n', nsRouter, 'addr', 'add', `${gwA}/24`, 'dev', rA]);
  ip(['-n', nsRouter, 'link', 'set', rA, 'up']);
  ip(['-n', nsRouter, 'addr', 'add', `${gwB}/24`, 'dev', rB]);
  ip(['-n', nsRouter, 'link', 'set', rB, 'up']);
  ip(['netns', 'exec', nsRouter, 'sysctl', '-q', '-w', 'net.ipv4.ip_forward=1']);
  for (const namespace of [nsA, nsB, nsRouter]) {
    ip(['netns', 'exec', namespace, 'sysctl', '-q', '-w', 'net.ipv4.conf.all.rp_filter=0']);
  }
  const routeBtoA = ip(['-n', nsB, 'route', 'get', ipA]).trim();
  const routeAtoB = ip(['-n', nsA, 'route', 'get', ipB]).trim();
  assert.match(routeBtoA, new RegExp(`via ${gwB}\\b`), `B must route to A through router: ${routeBtoA}`);
  assert.match(routeAtoB, new RegExp(`via ${gwA}\\b`), `A must route to B through router: ${routeAtoB}`);
  return { routeAtoB, routeBtoA };
}

let networkRoutes;
try {
  networkRoutes = await configureNetwork();
  const daemonA = await startDaemon(nsA, 'routed-left', path.join(base, 'daemon-a'));
  const daemonB = await startDaemon(nsB, 'routed-right', path.join(base, 'daemon-b'));
  const stateA = path.join(base, 'peer-a');
  const stateB = path.join(base, 'peer-b');
  workerA = startWorker(nsA, stateA, ipA, 'xats-peer-left');
  workerB = startWorker(nsB, stateB, ipB, 'xats-peer-right');
  const readyA = await workerA.ready;
  const readyB = await workerB.ready;
  assert.ok(readyA.peerPort > 0 && readyB.peerPort > 0);
  assert.equal(readyA.hostName, 'xats-peer-left', 'left peer runs in its own host-namespace identity');
  assert.equal(readyB.hostName, 'xats-peer-right', 'right peer runs in its own host-namespace identity');
  assert.notEqual(readyA.hostName, readyB.hostName, 'the two peers are separate OS views, not one process pair');
  assert.ok(readyA.endpoints.every((url) => !/127\.0\.0\.1|\[::1\]/.test(url)), `left peer exposes no loopback endpoint: ${readyA.endpoints}`);
  assert.ok(readyB.endpoints.every((url) => !/127\.0\.0\.1|\[::1\]/.test(url)), `right peer exposes no loopback endpoint: ${readyB.endpoints}`);
  const routerBefore = { [rA]: linkBytes(nsRouter, rA), [rB]: linkBytes(nsRouter, rB) };

  await workerA.request('api', { method: 'POST', path: '/api/register', body: { name: 'alice', team: 'default', role: 'worker', agent_type: 'custom' } });
  await workerB.request('api', { method: 'POST', path: '/api/register', body: { name: 'bob', team: 'default', role: 'worker', agent_type: 'custom' } });

  const endpointA = `https://${ipA}:${readyA.peerPort}`;
  const endpointB = `https://${ipB}:${readyB.peerPort}`;
  const invitePath = path.join(base, 'routed.invite');
  await runCli(nsA, stateA, ['invite', '--endpoint', endpointA, '--out', invitePath]);
  const pairing = startCli(nsB, stateB, ['pair', '--invite-file', invitePath, '--endpoint', endpointB, '--label', 'routed-left']);
  const id = await waitFor(async () => pendingId(await runCli(nsA, stateA, ['pending'])));
  await runCli(nsA, stateA, ['approve', id, '--label', 'routed-right']);
  const paired = await pairing.done;
  if (paired.code !== 0) throw new Error(`routed_pair_cli_failed: ${paired.stderr || paired.stdout}`);

  const statusA = await workerA.request('status');
  const statusB = await workerB.request('status');
  assert.ok(statusA.peers.some((peer) => peer.deviceId === readyB.deviceId), 'A trusts B only after explicit approval');
  assert.ok(statusB.peers.some((peer) => peer.deviceId === readyA.deviceId), 'B trusts A only after explicit approval');

  const shadow = await waitFor(async () => {
    await workerA.request('sync');
    const roster = await workerA.request('api', { path: '/api/agents/all' });
    return roster.agents.find((agent) => agent.agent_type_name === 'xats-peer-shadow' && agent.name.endsWith('_bob'));
  });
  await workerA.request('api', {
    method: 'POST',
    path: '/api/send',
    body: { from: { team: 'default', name: 'alice' }, to: { team: 'default', name: shadow.name }, subject: 'routed peer E2E', body: 'message across two routed namespaces' },
  });
  const delivered = await waitFor(async () => {
    await workerA.request('sync');
    await workerB.request('sync');
    const inbox = await workerB.request('api', { path: '/api/inbox?team=default&name=bob&since_event_id=0' });
    return inbox.messages.find((message) => message.body === 'message across two routed namespaces');
  });
  assert.equal(delivered.body, 'message across two routed namespaces');
  const transit = routerTransit(routerBefore);
  for (const [leg, bytes] of Object.entries(transit)) {
    assert.ok(bytes > 0, `router leg ${leg} must carry the peer traffic (saw ${bytes} bytes)`);
  }
  console.log(JSON.stringify({
    ok: true,
    topology: 'two isolated peer network namespaces, each with its own hostname and PID namespace, on distinct subnets via a forwarding router namespace',
    routeAtoB: networkRoutes.routeAtoB,
    routeBtoA: networkRoutes.routeBtoA,
    hostNames: [readyA.hostName, readyB.hostName],
    peerEndpoints: [readyA.endpoints[0], readyB.endpoints[0]],
    routerTransitBytes: transit,
    inviteEndpoint: endpointA,
    delivery: delivered.body,
    filament: false,
  }));
} finally {
  await workerA?.stop().catch(() => {});
  await workerB?.stop().catch(() => {});
  for (const child of cliChildren) await stopChild(child);
  for (const child of daemonChildren) await stopChild(child);
  for (const namespace of namespaceNames.reverse()) {
    try { ip(['netns', 'del', namespace]); } catch { /* best effort */ }
  }
  for (const interfaceName of [vA, rA, vB, rB]) {
    try { ip(['link', 'del', interfaceName]); } catch { /* already removed with namespace */ }
  }
  fs.rmSync(base, { recursive: true, force: true });
}
