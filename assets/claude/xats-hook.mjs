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

const BASE = process.env.XATS_BASE || 'http://127.0.0.1:9100';
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

function identity(evt) {
  const jobDir = process.env.CLAUDE_JOB_DIR;
  if (jobDir) {
    const jobId = path.basename(jobDir);
    return {
      name: `claude-${host}-job-${jobId}`,
      tag: `job-${jobId}`,
      delivery: { kind: 'claude-job', job_id: jobId, job_dir: jobDir },
    };
  }
  const sid = evt.session_id || '';
  const label = process.env.XATS_LABEL;
  const name = label
    ? `claude-${host}-${label}`
    : sid
      ? `claude-${host}-${sid.slice(0, 8)}`
      : `claude-${host}-${evt.source || 'startup'}`;
  return { name, tag: sid || 'no-session', delivery: null };
}

async function start() {
  const evt = JSON.parse((await readStdin()) || '{}');
  const id = identity(evt);
  // NOTE: the daemon rejects `delivery: null` (invalid_delivery/unknown_kind) —
  // the key must be OMITTED for interactive sessions, present only for jobs.
  const body = { name: id.name, team: TEAM, agent_type: 'claude-code', device: host };
  if (id.delivery) body.delivery = id.delivery;
  const resp = await post('/api/register', body);
  const agentId = resp && resp.agent_id;
  if (!agentId) return; // daemon unreachable — silently continue

  fs.writeFileSync(idFileFor(id.tag), agentId);
}

async function end() {
  const evt = JSON.parse((await readStdin()) || '{}');
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
