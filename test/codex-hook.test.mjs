import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dir = path.dirname(fileURLToPath(import.meta.url));
const HOOK = path.join(__dir, '..', 'assets', 'codex', 'xats-hook.mjs');

/**
 * A stub bus that records what the hook sends and answers like the daemon.
 * The hook always exits 0 and swallows errors (a hook must never break a
 * session), so tests assert on the recorded requests and on stdout, not on
 * exit codes.
 */
async function stubBus({ inbox = { messages: [] } } = {}) {
  const calls = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      calls.push({ method: req.method, url: req.url, body: body ? JSON.parse(body) : null });
      res.setHeader('content-type', 'application/json');
      if (req.url?.startsWith('/api/register')) {
        res.end(JSON.stringify({ agent_id: 'agt_codex_1', name: 'codex-test-abc12345', team: 'default' }));
      } else if (req.url?.startsWith('/api/inbox')) {
        res.end(JSON.stringify(inbox));
      } else {
        res.end(JSON.stringify({ ok: true }));
      }
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return {
    calls,
    base: `http://127.0.0.1:${port}`,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

function runHook(mode, event, base) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [HOOK, mode], {
      env: { ...process.env, XATS_BASE: base, XATS_TEAM: 'default', XATS_LABEL: '' },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    child.stdout.on('data', (chunk) => (stdout += chunk));
    child.stderr.on('data', () => {});
    child.on('close', (code) => resolve({ code, stdout }));
    child.stdin.end(JSON.stringify(event));
  });
}

function sessionID() {
  return `sess-${Math.random().toString(36).slice(2, 10)}`;
}

test('SessionStart registers the session as a codex agent with its session key', async (t) => {
  const bus = await stubBus();
  t.after(() => bus.close());
  const sid = sessionID();

  await runHook('start', { session_id: sid, hook_event_name: 'SessionStart' }, bus.base);

  const register = bus.calls.find((call) => call.url?.startsWith('/api/register'));
  assert.ok(register, 'register was called');
  assert.equal(register.body.agent_type, 'codex');
  assert.equal(register.body.session_key, sid);
  // A delivery binding would let the daemon inject an app-server turn; the hook
  // must never request one.
  assert.equal(register.body.delivery, undefined);
});

test('UserPromptSubmit hands mail to the model as developer context', async (t) => {
  const sid = sessionID();
  const bus = await stubBus({
    inbox: {
      messages: [
        { event_id: 1, from_name: 'pi-host', subject: 'deploy window', body: 'Take 14:00?', need_reply: 1 },
      ],
    },
  });
  t.after(() => bus.close());

  await runHook('start', { session_id: sid }, bus.base);
  const { stdout } = await runHook('prompt', { session_id: sid, hook_event_name: 'UserPromptSubmit' }, bus.base);

  const output = JSON.parse(stdout);
  const context = output.hookSpecificOutput.additionalContext;
  assert.equal(output.hookSpecificOutput.hookEventName, 'UserPromptSubmit');
  assert.match(context, /<xats-inbox>/);
  assert.match(context, /from pi-host: deploy window \(needs reply\)/);
  assert.match(context, /Take 14:00\?/);
  assert.match(context, /not by the person at the keyboard/);
  // A needs-reply message also shows a native-UI line.
  assert.match(output.systemMessage, /1 new message\(s\), 1 need\(s\) a reply/);
});

test('an empty inbox adds no context and no turn', async (t) => {
  const sid = sessionID();
  const bus = await stubBus();
  t.after(() => bus.close());

  await runHook('start', { session_id: sid }, bus.base);
  const { stdout, code } = await runHook('prompt', { session_id: sid }, bus.base);

  assert.equal(code, 0);
  assert.equal(stdout.trim(), '');
});

test('SessionEnd deregisters the agent it registered', async (t) => {
  const sid = sessionID();
  const bus = await stubBus();
  t.after(() => bus.close());

  await runHook('start', { session_id: sid }, bus.base);
  await runHook('end', { session_id: sid }, bus.base);

  const deregister = bus.calls.find((call) => call.url?.startsWith('/api/deregister'));
  assert.ok(deregister, 'deregister was called');
  assert.equal(deregister.body.agent_id, 'agt_codex_1');
});

test('a dead daemon never breaks the session', async () => {
  const sid = sessionID();
  // Nothing is listening on port 9.
  const started = await runHook('start', { session_id: sid }, 'http://127.0.0.1:9');
  const prompted = await runHook('prompt', { session_id: sid }, 'http://127.0.0.1:9');
  assert.equal(started.code, 0);
  assert.equal(prompted.code, 0);
  assert.equal(prompted.stdout.trim(), '');
});

test('the hook file has no Windows-hostile shebang assumptions', () => {
  // Codex runs hooks as `node <path> <mode>`, so the file must not depend on
  // being executable or on a POSIX shebang being honoured.
  const source = fs.readFileSync(HOOK, 'utf8');
  assert.match(source, /process\.argv\[2\]/);
  assert.ok(fs.existsSync(HOOK));
  assert.ok(os.tmpdir().length > 0);
});

test('the installer merges hooks.json idempotently and is Windows-safe', async (t) => {
  const { installCodex, codexPaths } = await import('../lib/codex.mjs');
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'xats-codex-home-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  fs.mkdirSync(path.join(home, '.codex'), { recursive: true });
  fs.mkdirSync(path.join(home, '.xats'), { recursive: true });

  const paths = { home, xatsRoot: path.join(home, '.xats') };
  const lay = codexPaths(paths);
  assert.equal(lay.hooksFile, path.join(home, '.codex', 'hooks.json'));

  installCodex(paths);
  const first = JSON.parse(fs.readFileSync(lay.hooksFile, 'utf8'));
  assert.ok(first.hooks.SessionStart, 'SessionStart wired');
  assert.ok(first.hooks.UserPromptSubmit, 'UserPromptSubmit wired');
  assert.ok(first.hooks.SessionEnd, 'SessionEnd wired');

  const handler = first.hooks.UserPromptSubmit[0].hooks[0];
  assert.match(handler.command, /codex-hook\.mjs" prompt$/);
  // Codex runs hooks through cmd on Windows; the explicit override keeps the
  // same absolute node path working there.
  assert.equal(handler.commandWindows, handler.command);

  // Re-running must not duplicate handlers.
  installCodex(paths);
  const second = JSON.parse(fs.readFileSync(lay.hooksFile, 'utf8'));
  assert.equal(second.hooks.UserPromptSubmit.length, 1);
  assert.equal(second.hooks.UserPromptSubmit[0].hooks.length, 1);
  assert.ok(fs.existsSync(lay.hookDest), 'hook copied to a stable path');
});
