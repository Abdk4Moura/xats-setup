#!/usr/bin/env node
// xats-hook.mjs — cross-platform Claude Code SessionStart/SessionEnd hook.
//
// Replaces the Linux-only bash hooks (curl+jq+setsid). Pure Node, uses the
// built-in global fetch (Node >=20), so it runs identically on Windows, macOS,
// and Linux.
//
// Wiring (settings.json):
//   SessionStart -> node <path>/xats-hook.mjs start
//   SessionEnd   -> node <path>/xats-hook.mjs end
// Claude passes event JSON on stdin ({ session_id, source, ... }).
//
// Modes:
//   start  register this session on the xats bus
//   end    deregister this session
//
// Liveness: the initial SessionStart registration sets last_seen. After that,
// the MCP-connected Claude Code agent is kept alive by touchIfRegistered on
// every MCP tool call, with no detached heartbeat pinger. An agent that stops
// interacting is reaped by the daemon TTL reaper within ~3 minutes and
// auto-re-registers on the next MCP interaction.

import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { randomUUID, createHash } from 'node:crypto';

// Resolve the daemon the same way the Pi adapter does: an explicit env
// override, else the port the daemon actually persisted, else 9100.
function resolveBase() {
  if (process.env.XATS_BASE) return process.env.XATS_BASE;
  try {
    const p = fs.readFileSync(path.join(os.homedir(), '.xats', 'port'), 'utf8').trim();
    const n = parseInt(p, 10);
    if (Number.isInteger(n) && n > 0 && n < 65536) return `http://127.0.0.1:${n}`;
  } catch { /* no port file */ }
  return 'http://127.0.0.1:9100';
}
const BASE = resolveBase();
const TEAM = process.env.XATS_TEAM || 'default';
const MODE = process.argv[2];

const host = os.hostname().split('.')[0];
const idFileFor = (tag) => path.join(os.tmpdir(), `.xats-agent-id-${tag}`);

async function post(pathname, body) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 4000);
  try {
    const res = await fetch(BASE + pathname, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    if (!res.ok) return null;
    return await res.json().catch(() => ({}));
  } catch {
    return null; // daemon down / unreachable — hooks must never break the session
  } finally {
    clearTimeout(t);
  }
}

function readStdin() {
  return new Promise((resolve) => {
    let data = '';
    if (process.stdin.isTTY) return resolve('');
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (c) => (data += c));
    process.stdin.on('end', () => resolve(data));
    // guard: if stdin never closes, don't hang the session
    setTimeout(() => resolve(data), 1500);
  });
}

// A malformed hook payload must never break the session, so parse defensively.
async function readEvent() {
  try {
    return JSON.parse((await readStdin()) || '{}');
  } catch {
    return {};
  }
}

function identity(evt) {
  const jobDir = process.env.CLAUDE_JOB_DIR;
  if (jobDir) {
    const jobId = path.basename(jobDir);
    return {
      name: `claude-${host}-job-${jobId}`,
      tag: `job-${jobId}`,
      sessionKey: `job-${jobId}`,
      mode: 'exact',
      delivery: { kind: 'claude-job', job_id: jobId, job_dir: jobDir },
    };
  }
  const sid = evt.session_id || '';
  const label = process.env.XATS_LABEL;
  const explicit = (process.env.XATS_NAME || '').trim();
  // The session id is the discriminator; the label is only a box-level prefix.
  // Without a session id two sessions cannot be told apart, so fall back to a
  // random suffix rather than a shared label-derived name (which would collapse
  // every concurrent session into one identity).
  const base = `claude-${host}${label ? `-${label}` : ''}`;
  const short = sid ? createHash('sha256').update(sid).digest('hex').slice(0, 8) : '';
  return {
    name: explicit || `${base}-${short || randomUUID().slice(0, 8)}`,
    tag: sid || 'no-session',
    sessionKey: sid || null,
    mode: explicit ? 'exact' : 'prefer',
    delivery: null,
  };
}

async function start() {
  const evt = await readEvent();
  const id = identity(evt);
  // NOTE: the daemon rejects `delivery: null` (invalid_delivery/unknown_kind) —
  // the key must be OMITTED for interactive sessions, present only for jobs.
  // Do NOT send `device`: the daemon owns its local device name (full hostname,
  // dots normalized to dashes). Sending the short hostname here makes the
  // daemon reject the register as device_spoofing_from_loopback on any dotted
  // hostname. Omitting it makes the daemon use its own local device, exactly
  // as the Pi and opencode adapters do.
  const body = { name: id.name, team: TEAM, agent_type: 'claude-code', session_key: id.sessionKey ?? undefined, name_mode: id.mode };
  if (id.delivery) body.delivery = id.delivery;
  const resp = await post('/api/register', body);
  const agentId = resp && resp.agent_id;
  if (!agentId) return; // daemon unreachable — silently continue

  fs.writeFileSync(idFileFor(id.tag), agentId);
  // The daemon is authoritative and may have disambiguated the name (name-2) or
  // returned the name this session already owned; record it for observability.
  if (resp && typeof resp.name === 'string' && resp.name) {
    try { fs.writeFileSync(idFileFor(`${id.tag}.name`), resp.name); } catch { /* ignore */ }
  }
}

async function end() {
  const evt = await readEvent();
  const id = identity(evt);
  const f = idFileFor(id.tag);
  let agentId = null;
  try { agentId = fs.readFileSync(f, 'utf8').trim(); } catch { /* nothing to do */ }
  if (agentId) {
    try { fs.unlinkSync(f); } catch { /* ignore */ }
    await post('/api/deregister', { agent_id: agentId });
  }
}

(async () => {
  try {
    if (MODE === 'start') await start();
    else if (MODE === 'end') await end();
    else process.exit(0);
  } catch {
    // A hook must never surface an error into the session.
  }
  process.exit(0);
})();
