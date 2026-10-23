#!/usr/bin/env node
// xats demo — prove the bus works, in one command.
//
// Starts two agents on the local bus, sends from one to the other, waits for the
// message to arrive in the recipient's inbox, and reports timings. It exists
// because "our agents can talk to each other" is a claim, and a claim should be
// runnable by anyone in one line — including in CI, where it doubles as a smoke
// test on every platform.
//
//   node scripts/demo.mjs            # uses the running daemon (or starts one)
//   node scripts/demo.mjs --json     # machine-readable summary
//
// Exit codes: 0 delivered, 1 not delivered, 2 daemon unavailable.
import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const asJson = args.includes('--json');
const keep = args.includes('--keep');
// --private ignores any running bus and starts its own, so CI and demos never
// depend on (or pollute) a real one.
const forcePrivate = args.includes('--private');

const say = (line) => {
  if (!asJson) console.log(line);
};

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

async function daemonPort() {
  // Prefer the running bus; fall back to a private one we start and stop.
  if (!forcePrivate) try {
    const port = Number.parseInt(fs.readFileSync(path.join(os.homedir(), '.xats', 'port'), 'utf8'), 10);
    if (Number.isInteger(port)) {
      const res = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(1000) });
      if (res.ok) return { port, owned: false };
    }
  } catch {
    /* no bus yet */
  }

  const cli = path.join(root, 'daemon', 'dist', 'cli.js');
  if (!fs.existsSync(cli)) {
    console.error('daemon/dist/cli.js is missing — run `npm run build:daemon` first');
    process.exit(2);
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xats-demo-'));
  const port = await freePort();
  const proc = spawn(
    process.execPath,
    [cli, 'daemon', '--device', 'demo-host', '--port', String(port), '--db', path.join(dir, 'data.db')],
    { env: { ...process.env, CROSS_AGENT_TEAMS_MCP_HOME: path.join(dir, 'home') }, stdio: 'ignore', detached: false },
  );
  for (let i = 0; i < 100; i += 1) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(500) });
      if (res.ok) return { port, owned: true, proc, dir };
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  console.error('daemon did not become healthy');
  process.exit(2);
}

const api = (port, method, pathname, body) =>
  fetch(`http://127.0.0.1:${port}${pathname}`, {
    method,
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(5000),
  }).then(async (res) => {
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`${method} ${pathname} -> ${res.status} ${JSON.stringify(data)}`);
    return data;
  });

const bus = await daemonPort();
say(`bus        http://127.0.0.1:${bus.port}${bus.owned ? ' (private, started for this demo)' : ' (running)'}`);

const cleanup = () => {
  if (bus.owned && bus.proc && !keep) {
    try {
      bus.proc.kill('SIGKILL');
    } catch {
      /* gone */
    }
    try {
      fs.rmSync(bus.dir, { recursive: true, force: true });
    } catch {
      /* keep */
    }
  }
};

try {
  const alice = await api(bus.port, 'POST', '/api/register', {
    name: 'demo-alice',
    team: 'demo',
    role: 'worker',
    session_key: 'demo-alice-session',
    agent_type: 'custom',
  });
  const bob = await api(bus.port, 'POST', '/api/register', {
    name: 'demo-bob',
    team: 'demo',
    role: 'worker',
    session_key: 'demo-bob-session',
    agent_type: 'custom',
  });
  say(`agents     demo-alice (${alice.name}), demo-bob (${bob.name})`);

  const roster = await api(bus.port, 'GET', `/api/agents?team=demo`);
  const visible = (roster.agents ?? []).map((a) => a.name).sort();
  say(`roster     ${visible.join(', ')}`);

  const started = Date.now();
  await api(bus.port, 'POST', '/api/send', {
    from: { team: 'demo', name: alice.name },
    to: { name: bob.name, team: 'demo' },
    subject: 'demo',
    body: 'hello from demo-alice',
    need_reply: false,
  });

  let received = null;
  for (let i = 0; i < 100; i += 1) {
    const inbox = await api(bus.port, 'GET', `/api/inbox?team=demo&name=${encodeURIComponent(bob.name)}&since_event_id=0`);
    const hit = (inbox.messages ?? []).find((m) => m.body === 'hello from demo-alice');
    if (hit) {
      received = hit;
      break;
    }
    await new Promise((r) => setTimeout(r, 100));
  }

  if (!received) {
    console.error('message was not delivered');
    process.exitCode = 1;
  } else {
    const ms = Date.now() - started;
    say(`delivered  ${received.from_name} -> ${bob.name} in ${ms} ms`);
    say('');
    say('In a real session the recipient agent sees this as a native notice');
    say('(Claude band, OpenCode badge, pi card) and replies with xats_send.');
    if (asJson) {
      console.log(JSON.stringify({
        ok: true,
        port: bus.port,
        owned: bus.owned,
        from: received.from_name,
        to: bob.name,
        latencyMs: ms,
        roster,
      }));
    }
  }
} finally {
  cleanup();
}
