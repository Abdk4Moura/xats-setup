#!/usr/bin/env node
// Local-first live acceptance without a real model or provider account.
//
// Starts an owned daemon, seeds one mailbox message, then runs the REAL Claude
// Code CLI against a local Anthropic-shaped stub whose "model" issues genuine
// MCP tool calls (get_inbox, send_message). The CLI performs the tool round
// trips; the stub only decides which tool to call. This exercises the wire,
// MCP handshake, tool schemas and daemon mailbox path, not model reasoning.
//
// Usage: node scripts/acceptance-local-first.mjs
// Requires: built daemon (npm run build:daemon) and a claude executable
// (XATS_CLAUDE or PATH). Linux/macOS only: tool-result capture relies on the
// stream-json event shape, not on Unix sockets.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const repo = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const daemonEntry = path.join(repo, 'daemon/dist/cli.js');
const claude = process.env.XATS_CLAUDE || which('claude');
assert.ok(fs.existsSync(daemonEntry), 'build the daemon first: npm run build:daemon');
assert.ok(claude, 'no claude executable found (set XATS_CLAUDE)');

function which(bin) {
  for (const dir of (process.env.PATH || '').split(path.delimiter)) {
    const full = path.join(dir, bin);
    try { fs.accessSync(full, fs.constants.X_OK); return full; } catch { /* keep looking */ }
  }
  return null;
}

const scratch = fs.mkdtempSync(path.join(process.env.RUNNER_TEMP || os.tmpdir(), 'xats-lf-accept-'));
const home = path.join(scratch, 'home');
fs.mkdirSync(home, { recursive: true, mode: 0o700 });
// Deliberate allowlist: no real credentials, provider keys, or user config.
const childEnv = {
  PATH: process.env.PATH || '/usr/local/bin:/usr/bin:/bin',
  HOME: home, USERPROFILE: home,
  TMPDIR: scratch,
  ANTHROPIC_BASE_URL: 'PENDING',
  ANTHROPIC_API_KEY: 'xats-local-acceptance-not-a-real-key',
  DISABLE_TELEMETRY: '1', DISABLE_ERROR_REPORTING: '1',
  CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
  CI: '1', NO_COLOR: '1', LANG: 'C.UTF-8',
  CROSS_AGENT_TEAMS_MCP_HOME: path.join(home, '.cross-agent-teams-mcp'),
};

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => { const { port } = server.address(); server.close(() => resolve(port)); });
  });
}

async function request(base, pathname, body) {
  const response = await fetch(base + pathname, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(5000),
  });
  return { status: response.status, data: await response.json().catch(() => ({})) };
}

async function startDaemon(t, port) {
  const proc = spawn(process.execPath, [daemonEntry, 'daemon', '--port', String(port), '--host', '127.0.0.1',
    '--db', path.join(scratch, 'data.db'), '--pid-file', path.join(scratch, 'daemon.pid'), '--no-loopback-companion'], {
    env: childEnv, cwd: scratch, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stderr = '';
  proc.stderr.on('data', (chunk) => { stderr += chunk; });
  const base = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (proc.exitCode !== null) throw new Error(`daemon exited ${proc.exitCode}: ${stderr.slice(-800)}`);
    try { if ((await fetch(`${base}/health`, { signal: AbortSignal.timeout(1000) })).ok) return { proc, base }; } catch { /* not up */ }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  proc.kill('SIGKILL');
  throw new Error(`daemon never became healthy: ${stderr.slice(-800)}`);
}

async function stopDaemon(proc) {
  if (!proc || proc.exitCode !== null) return;
  proc.kill('SIGTERM');
  await new Promise((resolve) => {
    const timer = setTimeout(() => { proc.kill('SIGKILL'); resolve(); }, 5000);
    proc.once('exit', () => { clearTimeout(timer); resolve(); });
  });
}

// Anthropic-shaped stub. Turn 1 asks for get_inbox, turn 2 asks for send_message
// (replying to the sender), turn 3 answers in text after both tool results.
function startModelStub(seed) {
  const calls = [];
  let turn = 0;
  let requests = 0;
  const seenTools = new Set();
  let seeded = false;
  const seededFor = [];
  const server = http.createServer(async (req, res) => {
    if (req.method === 'HEAD') { res.writeHead(200).end(); return; }
    let raw = '';
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', async () => {
      if (!req.url.includes('/chat/completions') && !req.url.split('?')[0].endsWith('/messages')) {
        res.writeHead(404).end('{}');
        return;
      }
      let body = {};
      try { body = JSON.parse(raw); } catch { /* keep empty */ }
      requests += 1;
      turn += 1;
      const tools = Array.isArray(body.tools) ? body.tools : [];
      const names = tools.map((tool) => tool?.name).filter(Boolean);
      for (const name of names) seenTools.add(name);
      const findTool = (suffix) => names.find((name) => name.endsWith(suffix));
      // Plan by how many tool results already exist, so the sequence does not
      // depend on turn numbering or on the host batching steps.
      const priorResults = (Array.isArray(body.messages) ? body.messages : [])
        .flatMap((message) => (Array.isArray(message?.content) ? message.content : []))
        .filter((part) => part?.type === 'tool_result')
        .map((part) => flattenContent(part.content));
      const done = priorResults.length;
      // The CLI creates its own identity via register_agent. Seed the mailbox
      // only after that, addressed to the identity it actually received, so the
      // read proves attribution rather than an empty inbox.
      if (done >= 1 && !seeded) {
        for (const raw of priorResults) {
          const start = raw.indexOf('{');
          if (start < 0) continue;
          try {
            const parsed = JSON.parse(raw.slice(start));
            if (typeof parsed?.agent_id === 'string') { seededFor.push(parsed.agent_id); await seed(parsed); seeded = true; break; }
          } catch { /* not the register result */ }
        }
      }
      const block = [];
      let stop = 'end_turn';
      const call = (suffix, id, input) => {
        const tool = findTool(suffix);
        if (!tool) return false;
        calls.push({ step: done, tool });
        stop = 'tool_use';
        block.push({ type: 'tool_use', id, name: tool, input });
        return true;
      };
      if (done === 0 && call('register_agent', 'toolu_register',
        { name: 'lf-receiver', team: 'default', role: 'worker', agent_type: 'custom', agent_type_name: 'Claude Code' })) {
        // register first: MCP tools resolve the caller from its own identity.
      } else if (done === 1 && call('get_inbox', 'toolu_inbox', {})) {
        // read the seeded mail
      } else if (done === 2 && call('send_message', 'toolu_reply',
        { to_agent_name: 'lf-sender', body: 'ack from receiver', auto_poke: false })) {
        // reply to the sender
      } else {
        block.push({ type: 'text', text: 'Owned acceptance finished.' });
      }
      const message = { id: `msg_${turn}`, type: 'message', role: 'assistant', model: body.model || 'stub',
        content: block, stop_reason: stop, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } };
      if (body.stream) {
        const events = [['message_start', { type: 'message_start', message: { ...message, content: [] } }]];
        block.forEach((part, index) => {
          const start = part.type === 'tool_use'
            ? { type: 'content_block_start', index, content_block: { ...part, input: {} } }
            : { type: 'content_block_start', index, content_block: { type: 'text', text: '' } };
          events.push([start.type, start]);
          const delta = part.type === 'tool_use'
            ? { type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: JSON.stringify(part.input) } }
            : { type: 'content_block_delta', index, delta: { type: 'text_delta', text: part.text } };
          events.push([delta.type, delta]);
          events.push(['content_block_stop', { type: 'content_block_stop', index }]);
        });
        events.push(['message_delta', { type: 'message_delta', delta: { stop_reason: stop, stop_sequence: null }, usage: { output_tokens: 1 } }]);
        events.push(['message_stop', { type: 'message_stop' }]);
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.end(events.map(([name, data]) => `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`).join(''));
      } else {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(message));
      }
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, calls, get requests() { return requests; }, get turns() { return turn; }, get seenTools() { return [...seenTools]; }, seededFor, port: server.address().port })));
}

function runClaude(base, modelPort) {
  // No --safe-mode: safe mode suppresses MCP servers entirely, which is exactly
  // what this acceptance must exercise. Isolation comes from the throwaway HOME,
  // empty setting sources, strict MCP config, and an allowlisted environment.
  const args = ['--setting-sources', '', '--strict-mcp-config',
    '--mcp-config', JSON.stringify({ mcpServers: { 'cross-agent-teams': { type: 'http', url: `${base}/mcp` } } }),
    '--allowedTools', 'mcp__cross-agent-teams__register_agent,mcp__cross-agent-teams__get_inbox,mcp__cross-agent-teams__send_message',
    '--no-session-persistence', '--model', 'sonnet', '--max-turns', '6',
    '--print', '--output-format', 'stream-json', '--verbose',
    'Register, read your xats inbox, reply to the sender, then stop.'];
  const env = { ...childEnv, ANTHROPIC_BASE_URL: `http://127.0.0.1:${modelPort}` };
  return new Promise((resolve) => {
    const proc = spawn(claude, args, { env, cwd: scratch, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (chunk) => { stdout += chunk; });
    proc.stderr.on('data', (chunk) => { stderr += chunk; });
    const timer = setTimeout(() => proc.kill('SIGKILL'), 90_000);
    proc.once('exit', (code) => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
  });
}

// tool_result content arrives either as a string or as an array of text parts.
function flattenContent(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map((part) => (typeof part === 'string' ? part : part?.text ?? '')).join('\n');
  }
  return content == null ? '' : JSON.stringify(content);
}

function toolResults(stdout) {
  const results = [];
  for (const line of stdout.split('\n')) {
    if (!line.trim().startsWith('{')) continue;
    let event;
    try { event = JSON.parse(line); } catch { continue; }
    const content = event?.message?.content;
    if (!Array.isArray(content)) continue;
    for (const part of content) if (part?.type === 'tool_result') results.push(flattenContent(part.content));
  }
  return results;
}

const started = Date.now();
const report = { cli: claude, realModel: false, toolRounds: [], assertions: [] };
let daemon;
let stub;
try {
  const port = await freePort();
  daemon = await startDaemon(null, port);
  const base = daemon.base;
  const sender = await request(base, '/api/register', { name: 'lf-sender', team: 'default', role: 'worker', agent_type: 'custom' });
  assert.equal(sender.status, 200);
  let receiverId;
  stub = await startModelStub(async (registration) => {
    receiverId = registration.agent_id;
    const seeded = await request(base, '/api/send', {
      from: { team: 'default', name: 'lf-sender' },
      to: { agent_id: receiverId },
      body: 'acceptance payload from lf-sender',
      auto_poke: false,
    });
    assert.equal(seeded.status, 200, 'seed message must be accepted after the CLI registers');
  });
  const run = await runClaude(base, stub.port);
  const results = toolResults(run.stdout);
  report.toolRounds = stub.calls;
  report.exitCode = run.code;
  report.stderrTail = run.stderr.slice(-400);

  assert.equal(run.code, 0, `claude exited ${run.code}: ${run.stderr.slice(-1200)}`);
  if (results.length < 2) {
    console.error(JSON.stringify({
      modelRequests: stub.requests, modelTurns: stub.turns, chosenTools: stub.calls, seenTools: stub.seenTools,
      stderr: run.stderr.slice(-2500),
      events: [...new Set(run.stdout.split('\n').filter((l) => l.trim().startsWith('{')).map((l) => { try { return JSON.parse(l).type; } catch { return 'unparsed'; } }))],
    }, null, 2));
  }
  assert.ok(results.length >= 3, `expected three MCP tool results, saw ${results.length}`);
  report.assertions.push('real CLI performed MCP tool rounds');

  // 1. Rendering/attribution: the model actually saw the seeded body and sender.
  if (!results[1]?.includes('acceptance payload from lf-sender')) {
    console.error(JSON.stringify({ receiverId, resultCount: results.length,
      results: results.map((value) => value.slice(0, 400)), chosen: stub.calls, seeded: stub.seededFor }, null, 2));
  }
  assert.ok(results[1].includes('acceptance payload from lf-sender'), 'get_inbox result must contain the seeded body');
  assert.ok(/lf-sender/.test(results[1]), 'inbox rows must attribute the sender');
  report.assertions.push('inbox body and sender attribution reached the model turn');

  // 2. Outbound tool actually wrote to the sender mailbox.
  assert.ok(/ack from receiver/.test(results[2]) || /success|sent/i.test(results[2]), 'send_message result must report success');
  // since_event_id=0 keeps these checks read-only; an implicit inbox read
  // advances the cursor and would make the post-restart check meaningless.
  const senderInbox = await request(base, `/api/inbox?team=default&name=lf-sender&since_event_id=0`);
  assert.equal(senderInbox.status, 200);
  const reply = senderInbox.data.messages.find((message) => message.body === 'ack from receiver');
  assert.ok(reply, 'the reply must be stored in the sender mailbox');
  assert.equal(reply.from_agent_id, receiverId, 'reply must be attributed to the receiver identity');
  report.assertions.push('send_message round trip stored the reply with correct attribution');

  // 3. Recovery: restart keeps identities, mail, and does not duplicate.
  await stopDaemon(daemon.proc);
  daemon = await startDaemon(null, port);
  const afterRestart = await request(base, `/api/inbox?team=default&name=lf-sender&since_event_id=0`);
  const replies = afterRestart.data.messages.filter((message) => message.body === 'ack from receiver');
  assert.equal(replies.length, 1, 'restart must not duplicate the stored reply');
  assert.equal(replies[0].from_agent_id, receiverId, 'restart must keep attribution');
  const roster = await request(base, `/api/agents?team=default`);
  for (const id of [sender.data.agent_id, receiverId]) {
    assert.ok(roster.data.agents.some((agent) => agent.agent_id === id), `registration ${id} must survive restart`);
  }
  report.assertions.push('daemon restart preserved identities and exactly one reply');

  console.log(JSON.stringify({ ...report, elapsedMs: Date.now() - started }, null, 2));
  console.log('Local-first acceptance passed: real CLI + real MCP tool calls + owned daemon. Mock model: no provider inference.');
} finally {
  await stopDaemon(daemon?.proc);
  if (stub) await new Promise((resolve) => stub.server.close(resolve));
  fs.rmSync(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
