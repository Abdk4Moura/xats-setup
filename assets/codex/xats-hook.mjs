#!/usr/bin/env node
// xats-hook.mjs — cross-platform Codex CLI lifecycle hook.
//
// Codex has no plugin UI surface: no render sites, no custom status-line item,
// and a background hook cannot start a turn. What it does have is hooks that can
// feed the model developer context (`additionalContext`) and surface a line in
// the UI (`systemMessage`) without pretending the person typed anything.
//
// So Codex delivery is pull-based and context-native:
//   start   register this session on the bus (SessionStart)
//   prompt  hand waiting mail to the model as developer context (UserPromptSubmit)
//   end     deregister (SessionEnd)
//
// A push (waking an idle session) would have to look like a user turn — via
// `codex queue` or app-server `turn/start` — so it is deliberately not done here.
// The daemon never gets a codex delivery binding from this hook, which means it
// also never injects an app-server turn behind your back.
//
// Wiring (hooks.json):
//   SessionStart       -> node <path>/xats-hook.mjs start
//   UserPromptSubmit   -> node <path>/xats-hook.mjs prompt
//   SessionEnd         -> node <path>/xats-hook.mjs end

import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';

const MODE = process.argv[2];
const TEAM = process.env.XATS_TEAM || 'default';
const CONTEXT_LIMIT_TOKENS = Number(process.env.XATS_CONTEXT_LIMIT || 0) || 0;

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

const host = os.hostname().split('.')[0];
const idFileFor = (tag) => path.join(os.tmpdir(), `.xats-codex-agent-${tag}`);

async function request(pathname, init) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 4000);
  try {
    const res = await fetch(BASE + pathname, { ...init, signal: ctrl.signal });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) return { error: data?.error ?? `http_${res.status}`, status: res.status, data };
    return { data };
  } catch (error) {
    return { error: error?.message ?? 'unreachable' };
  } finally {
    clearTimeout(timer);
  }
}

function post(pathname, body) {
  return request(pathname, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function readStdin() {
  return new Promise((resolve) => {
    let data = '';
    if (process.stdin.isTTY) return resolve('');
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => (data += chunk));
    process.stdin.on('end', () => resolve(data));
    // A hook must never hang the session.
    setTimeout(() => resolve(data), 1500);
  });
}

async function readEvent() {
  try {
    return JSON.parse((await readStdin()) || '{}');
  } catch {
    return {};
  }
}

function identity(evt) {
  const sid = evt.session_id || '';
  const label = process.env.XATS_LABEL;
  const explicit = (process.env.XATS_NAME || '').trim();
  const short = sid ? createHash('sha256').update(sid).digest('hex').slice(0, 8) : randomUUID().slice(0, 8);
  return {
    name: explicit || `codex-${host}${label ? `-${label}` : ''}-${short}`,
    tag: sid || 'no-session',
    sessionKey: sid || null,
    mode: explicit ? 'exact' : 'prefer',
  };
}

function clip(text, max) {
  const oneLine = String(text ?? '').replace(/\s+/g, ' ').trim();
  return oneLine.length <= max ? oneLine : `${oneLine.slice(0, max - 1).trimEnd()}…`;
}

async function start() {
  const evt = await readEvent();
  const id = identity(evt);
  const body = {
    name: id.name,
    team: TEAM,
    agent_type: 'codex',
    session_key: id.sessionKey ?? undefined,
    name_mode: id.mode,
  };
  const res = await post('/api/register', body);
  if (res.error) return; // daemon unreachable — never break the session
  const agentId = res.data?.agent_id;
  if (!agentId) return;
  try {
    fs.writeFileSync(idFileFor(id.tag), agentId);
    if (typeof res.data.name === 'string' && res.data.name) {
      fs.writeFileSync(idFileFor(`${id.tag}.name`), res.data.name);
    }
  } catch { /* identity still works without the cache file */ }
}

async function end() {
  const evt = await readEvent();
  const id = identity(evt);
  const file = idFileFor(id.tag);
  let agentId = null;
  try { agentId = fs.readFileSync(file, 'utf8').trim(); } catch { /* nothing to do */ }
  if (!agentId) return;
  try { fs.unlinkSync(file); } catch { /* ignore */ }
  await post('/api/deregister', { agent_id: agentId });
}

/**
 * Hand waiting mail to the model as developer context.
 *
 * The inbox is read in the daemon's implicit-cursor mode on purpose: this is the
 * only reader for a Codex session, so letting the daemon remember the cursor is
 * more robust than a local cache that can drift.
 */
async function prompt() {
  const evt = await readEvent();
  const id = identity(evt);
  const nameFile = idFileFor(`${id.tag}.name`);
  let name = id.name;
  try {
    const cached = fs.readFileSync(nameFile, 'utf8').trim();
    if (cached) name = cached;
  } catch { /* fall back to the computed name */ }

  const res = await request(`/api/inbox?team=${encodeURIComponent(TEAM)}&name=${encodeURIComponent(name)}`);
  if (res.error) return; // stay silent rather than inject an error into the turn
  const messages = Array.isArray(res.data?.messages) ? res.data.messages : [];
  if (messages.length === 0) return;

  const replyNeed = messages.filter((message) => message.need_reply).length;
  const lines = messages.map((message) => {
    const subject = message.subject ? `: ${message.subject}` : '';
    const needs = message.need_reply ? ' (needs reply)' : '';
    return `- from ${message.from_name || 'unknown'}${subject}${needs}\n  ${clip(message.body, 400)}`;
  });

  const additionalContext = [
    '<xats-inbox>',
    `${messages.length} cross-agent message(s) arrived while you were idle:`,
    ...lines,
    '',
    'These were sent by other agents, not by the person at the keyboard. Act on them',
    'now. If a message needs a reply, reply with xats_send.',
    '</xats-inbox>',
  ].join('\n');

  const output = {
    hookSpecificOutput: {
      hookEventName: 'UserPromptSubmit',
      additionalContext,
    },
  };
  // A needs-reply message also gets a visible line, so the person sees there is
  // traffic without the mail being dressed up as their own typing.
  if (replyNeed > 0) {
    output.systemMessage = `xats: ${messages.length} new message(s), ${replyNeed} need(s) a reply`;
  }
  process.stdout.write(JSON.stringify(output));
}

(async () => {
  try {
    if (MODE === 'start') await start();
    else if (MODE === 'prompt') await prompt();
    else if (MODE === 'end') await end();
    else process.exit(0);
  } catch {
    // A hook must never surface an error into the session.
  }
  process.exit(0);
})();
