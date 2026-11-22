#!/usr/bin/env node
// Real Claude native tools and IPC, an isolated xats daemon, deterministic model.
// No provider credentials, production bus, fake Claude registry, or paid model.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import net from 'node:net';
import { spawn, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const repo = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const require = createRequire(path.join(repo, 'package.json'));
const Database = require('better-sqlite3');
const cli = process.env.XATS_NATIVE_CLAUDE;
assert.ok(cli && fs.existsSync(cli), 'Set XATS_NATIVE_CLAUDE to the existing pinned CLI');
assert.equal(process.platform, 'linux');
const scratch = fs.mkdtempSync(path.join(process.env.RUNNER_TEMP || os.tmpdir(), 'xnp-'));
fs.chmodSync(scratch, 0o700);
const home = path.join(scratch, 'h');
const work = path.join(scratch, 'w');
const runtime = path.join(scratch, 'r');
for (const p of [home, work, runtime]) fs.mkdirSync(p, { mode: 0o700 });
const dbPath = path.join(scratch, 'data.db');
const modelCalls = [];
const failures = [];
const payload = 'native-claude-to-pi-fixture';
const replyPayload = 'native-pi-to-claude-fixture';
const policy = process.env.XATS_NATIVE_POLICY || 'accept';
assert.ok(['accept', 'hold', 'refuse'].includes(policy));
const userSettings = path.join(home, '.claude/settings.json');
fs.mkdirSync(path.dirname(userSettings), { recursive: true, mode: 0o700 });
fs.writeFileSync(userSettings, JSON.stringify({ crossSessionInbound: policy }), { mode: 0o600 });
const env = { PATH: process.env.PATH || '/usr/local/bin:/usr/bin:/bin', HOME: home, USERPROFILE: home,
  XDG_RUNTIME_DIR: runtime, TMPDIR: scratch, LANG: 'C.UTF-8', CI: '1',
  CROSS_AGENT_TEAMS_MCP_HOME: path.join(scratch, 'state'), ENABLE_TOOL_SEARCH: 'false',
  ANTHROPIC_API_KEY: 'native-local-fixture-not-a-real-key',
  DISABLE_TELEMETRY: '1', DISABLE_ERROR_REPORTING: '1', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1' };
let daemon;
let claude;
let model;
let base;
let piId;
let replyId;
let sawNativeNotice = false;
let sawReplyBody = false;
let forceInboxRead = false;
let requestCount = 0;
let stdout = '';
let stderr = '';

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}
async function request(url, body) {
  const r = await fetch(base + url, { method: body === undefined ? 'GET' : 'POST',
    headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(4000) });
  assert.equal(r.status, 200, `${url}: HTTP ${r.status}`);
  return r.json();
}
async function until(check, ms = 30000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (failures.length) throw new Error(failures[0]);
    const value = await check();
    if (value) return value;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error('native acceptance condition timed out');
}
async function startDaemon(port) {
  const proc = spawn(process.execPath, [path.join(repo, 'daemon/dist/cli.js'), 'daemon', '--port', String(port),
    '--host', '127.0.0.1', '--db', dbPath, '--pid-file', path.join(scratch, 'daemon.pid'), '--no-loopback-companion'],
  { cwd: work, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = '';
  proc.stderr.on('data', b => { log += b; });
  proc.stdout.on('data', () => {});
  await until(async () => {
    if (proc.exitCode !== null) throw new Error(`fixture daemon exited: ${log.slice(-500)}`);
    try { return (await fetch(base + '/health', { signal: AbortSignal.timeout(500) })).ok; } catch { return false; }
  }, 10000);
  return proc;
}
function text(value) {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map(v => typeof v === 'string' ? v : v?.text || '').join('\n');
  return JSON.stringify(value ?? '');
}
function respond(res, body, block) {
  const isTool = block.type === 'tool_use';
  const message = { id: 'msg_native_' + requestCount, type: 'message', role: 'assistant', model: body.model || 'fixture',
    content: [block], stop_reason: isTool ? 'tool_use' : 'end_turn', stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } };
  if (!body.stream) { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(message)); return; }
  const start = isTool ? { ...block, input: {} } : { type: 'text', text: '' };
  const delta = isTool ? { type: 'input_json_delta', partial_json: JSON.stringify(block.input) } : { type: 'text_delta', text: block.text };
  const events = [
    ['message_start', { type: 'message_start', message: { ...message, content: [], stop_reason: null } }],
    ['content_block_start', { type: 'content_block_start', index: 0, content_block: start }],
    ['content_block_delta', { type: 'content_block_delta', index: 0, delta }],
    ['content_block_stop', { type: 'content_block_stop', index: 0 }],
    ['message_delta', { type: 'message_delta', delta: { stop_reason: message.stop_reason, stop_sequence: null }, usage: { output_tokens: 1 } }],
    ['message_stop', { type: 'message_stop' }],
  ];
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  res.end(events.map(([event, data]) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`).join(''));
}
async function modelResponse(body) {
  requestCount++;
  assert.ok(requestCount <= 12, 'unexpected model loop');
  const tools = body.tools || [];
  const messages = body.messages || [];
  const results = messages.flatMap(m => Array.isArray(m.content) ? m.content : [])
    .filter(b => b.type === 'tool_result').map(b => text(b.content));
  const priorNames = new Set(messages.flatMap(m => Array.isArray(m.content) ? m.content : [])
    .filter(b => b.type === 'tool_use').map(b => b.name));
  const lastUser = [...messages].reverse().find(m => m.role === 'user');
  const lastText = text(lastUser?.content);
  if (lastText.includes('<xats-inbox>')) sawNativeNotice = true;
  if (results.some(r => r.includes(replyPayload))) sawReplyBody = true;
  const call = (name, input) => {
    assert.ok(tools.some(t => t.name === name), `required real tool not offered: ${name}`);
    modelCalls.push(name);
    return { type: 'tool_use', id: 'toolu_native_' + requestCount, name, input };
  };
  const bind = tools.find(t => t.name.endsWith('__xats_bind'))?.name;
  if (!priorNames.has(bind)) {
    const code = JSON.stringify(body).match(/with code ([A-Z0-9]{4}-[A-Z0-9]{4})/i)?.[1];
    assert.ok(code && bind, 'real SessionStart binding context/tool unavailable');
    return call(bind, { code });
  }
  if (!priorNames.has('ListAgents')) return call('ListAgents', {});
  if (!priorNames.has('SendMessage')) {
    assert.ok(results.some(r => r.includes(`xats:${piId}`)), 'native ListAgents did not discover the Pi mailbox endpoint');
    return call('SendMessage', { to: `xats:${piId}`, message: payload, summary: 'Native xats interoperability fixture' });
  }
  if (!replyId) {
    const inbox = await until(async () => {
      const rows = (await request('/api/inbox?team=default&name=pi-native-fixture&since_event_id=0')).messages;
      return rows?.find(m => m.body.includes(payload));
    }, 8000);
    const recipient = (await request('/api/agents/all')).agents.find(a => a.agent_type === 'claude-code');
    assert.ok(recipient && inbox.from_agent_id === recipient.agent_id, 'native send lost sender attribution');
    const reply = await request('/api/send', { from: { name: 'pi-native-fixture', team: 'default' },
      to: { agent_id: recipient.agent_id }, body: replyPayload, auto_poke: false });
    replyId = reply.message_id;
    return { type: 'text', text: 'Native send completed; waiting for the mailbox reply notice.' };
  }
  if ((sawNativeNotice || forceInboxRead) && !sawReplyBody) {
    const name = tools.find(t => t.name.endsWith('__get_inbox'))?.name;
    assert.ok(name, 'real inbox tool unavailable');
    return call(name, {});
  }
  return { type: 'text', text: sawReplyBody ? 'Native round trip complete.' : 'Waiting for the native notice.' };
}
async function stop(proc) {
  if (!proc || proc.exitCode !== null || proc.signalCode !== null) return;
  proc.kill('SIGTERM');
  await new Promise(resolve => {
    const timer = setTimeout(() => { proc.kill('SIGKILL'); resolve(); }, 3000);
    proc.once('exit', () => { clearTimeout(timer); resolve(); });
  });
}

try {
  const versionResult = spawnSync(cli, ['--version'], { env, encoding: 'utf8', timeout: 5000, maxBuffer: 32768 });
  assert.equal(versionResult.status, 0, 'pinned Claude must report its actual version');
  const cliVersion = versionResult.stdout.trim().split(' ')[0];
  if (process.env.XATS_NATIVE_EXPECT_VERSION) assert.equal(cliVersion, process.env.XATS_NATIVE_EXPECT_VERSION);
  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  env.XATS_BASE = base;
  daemon = await startDaemon(port);
  piId = (await request('/api/register', { name: 'pi-native-fixture', team: 'default', agent_type: 'pi' })).agent_id;
  assert.ok(piId);
  model = http.createServer(async (req, res) => {
    if (req.method === 'HEAD') { res.writeHead(200).end(); return; }
    let raw = '';
    for await (const chunk of req) raw += chunk;
    try {
      if (req.url.includes('count_tokens')) { res.writeHead(200, { 'content-type': 'application/json' }).end('{"input_tokens":1}'); return; }
      assert.ok(req.url.split('?')[0].endsWith('/messages'), 'unexpected provider endpoint');
      const body = JSON.parse(raw);
      respond(res, body, await modelResponse(body));
    } catch (error) {
      failures.push(error.message);
      res.writeHead(500, { 'content-type': 'application/json' }).end(JSON.stringify({ error: { type: 'fixture_error', message: error.message } }));
    }
  });
  await new Promise(resolve => model.listen(0, '127.0.0.1', resolve));
  env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${model.address().port}`;
  const settings = { hooks: { SessionStart: [{ hooks: [{ type: 'command',
    command: `"${process.execPath}" "${path.join(repo, 'assets/claude/xats-hook.mjs')}" start` }] }] } };
  const args = ['--setting-sources', 'user', '--settings', JSON.stringify(settings), '--plugin-dir', path.join(repo, 'assets/claude/mod'),
    '--strict-mcp-config', '--mcp-config', JSON.stringify({ mcpServers: { 'cross-agent-teams': { type: 'http', url: base + '/mcp' } } }),
    '--tools', 'ListAgents,SendMessage', '--allowedTools', 'ListAgents,SendMessage,mcp__cross-agent-teams__*',
    '--permission-mode', 'dontAsk', '--no-session-persistence', '--model', 'sonnet', '--max-turns', '8',
    '--print', '--verbose', '--input-format', 'stream-json', '--output-format', 'stream-json'];
  claude = spawn(cli, args, { env, cwd: work, stdio: ['pipe', 'pipe', 'pipe'] });
  claude.stdout.on('data', b => { stdout = (stdout + b).slice(-1024 * 1024); });
  claude.stderr.on('data', b => { stderr = (stderr + b).slice(-32768); });
  claude.stdin.write(JSON.stringify({ type: 'user', message: { role: 'user', content: [
    { type: 'text', text: 'Use the real native ListAgents and SendMessage tools to contact Pi, then read its reply notice.' },
  ] } }) + '\n');
  const alive = () => {
    if (claude.exitCode !== null) throw new Error(`Claude exited ${claude.exitCode} before native round trip: ${stderr.slice(-500)}`);
    return true;
  };
  await until(() => alive() && replyId);
  const db = new Database(dbPath, { readonly: true });
  const row = () => db.prepare('SELECT status,attempt_id,generation FROM local_delivery_outbox WHERE message_id=?').get(replyId);
  const nativeDirs = fs.readdirSync(path.join(home, '.xats/native'));
  assert.equal(nativeDirs.length, 1, 'one helper scope per real session');
  const journal = new Database(path.join(home, '.xats/native', nativeDirs[0], 'journal.db'), { readonly: true });
  const nativeFact = () => journal.prepare('SELECT state,wire_status,admission_source FROM outgoing WHERE message=?').get(replyId);
  if (policy !== 'accept') {
    const expected = policy === 'refuse' ? 'refused' : 'held';
    await until(() => alive() && row()?.status === expected, 10000);
    assert.equal(nativeFact()?.state, expected, 'real native refusal/hold must reach the durable journal');
    assert.equal(nativeFact()?.admission_source, null, 'an undelivered held/refused message must not have a positive admission witness');
    assert.equal(sawNativeNotice, false, 'held/refused traffic must not fall back to a prompt');
    assert.equal(sawReplyBody, false);
    if (policy === 'hold') {
      // The fixture's trusted user settings are watched by the real host.
      // Actual host policy release, never an adapter timer, admits this message.
      fs.writeFileSync(userSettings, JSON.stringify({ crossSessionInbound: 'accept' }));
    } else {
      // An explicit test-user inbox read can cover a refused event without
      // rewriting its terminal native attempt as consumed.
      forceInboxRead = true;
      claude.stdin.write(JSON.stringify({ type: 'user', message: { role: 'user', content: [
        { type: 'text', text: 'Explicitly read my xats inbox now. Do not submit or resend any message.' },
      ] } }) + '\n');
    }
  }
  await until(() => alive() && sawReplyBody, 45000);
  const expectedFinal = policy === 'refuse' ? 'refused' : 'inbox-consumed';
  await until(() => row()?.status === expectedFinal, 5000);
  assert.equal(row()?.status, expectedFinal);
  assert.equal(db.prepare('SELECT count(*) AS n FROM local_delivery_outbox WHERE message_id=?').get(replyId).n, 1);
  const attempts = db.prepare('SELECT count(*) AS n FROM local_delivery_attempts WHERE message_id=?').get(replyId).n;
  assert.equal(attempts, 1, 'native and plugin polling must not both own the same message');
  const nativeReply = await until(() => {
    const fact = nativeFact();
    return fact?.state === (policy === 'refuse' ? 'refused' : 'host-queued') && fact;
  }, 5000);
  if (policy !== 'refuse') assert.ok(nativeReply.admission_source === 'session.receive' || nativeReply.wire_status === 'delivered',
    'a real queued host callback or native wire receipt, not a socket write, must prove admission');
  else {
    const facts = db.prepare('SELECT f.stage FROM local_delivery_facts f JOIN local_delivery_attempts a USING(attempt_id) WHERE a.message_id=?').all(replyId);
    assert.ok(!facts.some(f => f.stage === 'inbox-consumed' || f.stage === 'host-queued'));
    assert.equal(sawNativeNotice, false);
  }
  assert.equal(journal.prepare("SELECT count(*) AS n FROM incoming WHERE state='stored'").get().n, 1);
  const finalStatus = row()?.status;
  journal.close();
  db.close();
  await stop(claude);
  claude = null;
  await stop(daemon);
  daemon = await startDaemon(port);
  const after = await request('/api/inbox?team=default&name=pi-native-fixture&since_event_id=0');
  assert.equal(after.messages.filter(m => m.body.includes(payload)).length, 1, 'native mailbox commit survives daemon restart exactly once');
  console.log(JSON.stringify({ realCli: true, syntheticModel: true, nativeListAgentsDiscoveredPi: true,
    nativeSendMessageCommittedPiMailbox: true, cliVersion, policy, nativeReplyObservation: nativeReply,
    replyBodyReadByRealMcp: sawReplyBody, terminalRefusalPreserved: policy === 'refuse' ? finalStatus === 'refused' : undefined,
    attempts, daemonRestartPreservedMail: true,
    featureFlagSpecified: false, calls: modelCalls, modelRequests: requestCount }, null, 2));
} catch (error) {
  const nativeDiagnostics = [];
  const nativeRoot = path.join(home, '.xats/native');
  for (const name of fs.existsSync(nativeRoot) ? fs.readdirSync(nativeRoot) : []) {
    const folder = path.join(nativeRoot, name);
    try {
      const j = new Database(path.join(folder, 'journal.db'), { readonly: true });
      const observed = path.join(folder, 'receive-observed.json');
      nativeDiagnostics.push({ outgoing: j.prepare('SELECT attempt,generation,event,state,wire_status,admission_source FROM outgoing').all(),
        hostCallback: fs.existsSync(observed) ? JSON.parse(fs.readFileSync(observed, 'utf8')) : null });
      j.close();
    } catch { /* startup may not have created a journal */ }
  }
  console.error(JSON.stringify({ error: error.message, policy, calls: modelCalls, modelRequests: requestCount,
    failures, nativeDiagnostics, stderrTail: stderr.slice(-1200), stdoutTail: stdout.slice(-2000) }, null, 2));
  throw error;
} finally {
  await stop(claude);
  await stop(daemon);
  if (model) { model.closeAllConnections(); await new Promise(resolve => model.close(resolve)); }
  fs.rmSync(scratch, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}
