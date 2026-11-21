// Criterion 3, data plane: a row that is STORED when the daemon dies must still
// be claimable (gain a lease generation) after a real process restart, and a real
// inbox read must then reconcile it to inbox-consumed with the cursor advanced.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const repo = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const require = createRequire(path.join(repo, 'package.json'))
let Database
try { Database = require('better-sqlite3') } catch { /* CI installs native deps */ }
const CLI = path.join(repo, 'daemon', 'dist', 'cli.js')

const freePort = () => new Promise((resolve, reject) => {
  const server = net.createServer()
  server.once('error', reject)
  server.listen(0, '127.0.0.1', () => { const { port } = server.address(); server.close(() => resolve(port)) })
})

async function startDaemon(t, dir, port) {
  const proc = spawn(process.execPath, [CLI, 'daemon', '--port', String(port), '--host', '127.0.0.1',
    '--db', path.join(dir, 'data.db'), '--pid-file', path.join(dir, 'daemon.pid'), '--no-loopback-companion'], {
    env: { ...process.env, CROSS_AGENT_TEAMS_MCP_HOME: dir, XATS_LOCAL_DELIVERY: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let stderr = ''
  proc.stderr.on('data', (b) => { stderr += b })
  const base = `http://127.0.0.1:${port}`
  const deadline = Date.now() + 20_000
  while (Date.now() < deadline) {
    if (proc.exitCode !== null) throw new Error(`daemon exited ${proc.exitCode}: ${stderr.slice(-600)}`)
    try { if ((await fetch(`${base}/health`, { signal: AbortSignal.timeout(1000) })).ok) return { proc, base } } catch { /* not up */ }
    await new Promise((r) => setTimeout(r, 100))
  }
  throw new Error(`daemon never became healthy: ${stderr.slice(-600)}`)
}

async function stopDaemon(proc, signal = 'SIGKILL') {
  if (!proc || proc.exitCode !== null) return
  proc.kill(signal)
  await new Promise((resolve) => { const timer = setTimeout(resolve, 5000); proc.once('exit', () => { clearTimeout(timer); resolve() }) })
}

const post = async (base, pathname, body, token) => {
  const res = await fetch(base + pathname, { method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(token ? { 'X-Xats-Delivery-Token': token } : {}) },
    body: JSON.stringify(body ?? {}) })
  return { status: res.status, data: await res.json().catch(() => ({})) }
}

test('a stored row survives a daemon restart, gains a generation, and a real read consumes it', { skip: !Database || !fs.existsSync(CLI), timeout: 120000 }, async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xats-restart-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }))
  const port = await freePort()
  let daemon = await startDaemon(t, dir, port)
  const db = () => new Database(path.join(dir, 'data.db'), { readonly: false })
  const outbox = (conn, messageId) => conn.prepare('SELECT status, generation FROM local_delivery_outbox WHERE message_id=?').get(messageId)

  try {
    const recipient = await post(daemon.base, '/api/register', {
      name: 'restart-agent', team: 'default', agent_type: 'claude-code',
      session_key: 'sess-restart', name_mode: 'exact', bind_mcp: true, local_delivery: true,
    })
    assert.equal(recipient.status, 200, JSON.stringify(recipient.data))
    const token = recipient.data.local_delivery?.token
    assert.match(String(token), /^[A-Za-z0-9_-]{43}$/, 'registration must mint a delivery lease')

    const sender = await post(daemon.base, '/api/register', { name: 'restart-sender', team: 'default', agent_type: 'custom' })
    assert.equal(sender.status, 200)

    const sent = await post(daemon.base, '/api/send', {
      from: { team: 'default', name: 'restart-sender' },
      to: { agent_id: recipient.data.agent_id },
      body: 'pending across restart',
    })
    assert.equal(sent.status, 200, JSON.stringify(sent.data))

    let conn = db()
    const before = outbox(conn, sent.data.message_id)
    conn.close()
    assert.deepEqual(before, { status: 'stored', generation: null },
      'the row must be genuinely stored and unclaimed when the daemon dies')

    await stopDaemon(daemon.proc, 'SIGKILL')
    daemon = await startDaemon(t, dir, port)

    await post(daemon.base, '/api/local-delivery/renew', {}, token)
    const waited = await fetch(`${daemon.base}/api/local-delivery/wait?timeout_ms=2000`, {
      headers: { 'X-Xats-Delivery-Token': token }, signal: AbortSignal.timeout(5000),
    })
    assert.equal(waited.status, 200)
    const hint = (await waited.json()).hints?.[0]
    assert.ok(hint, 'the surviving row must be claimable after the restart')
    assert.ok(Number.isInteger(hint.generation) && hint.generation >= 1, 'the claim assigns a lease generation')

    conn = db()
    const claimed = outbox(conn, sent.data.message_id)
    conn.close()
    assert.equal(claimed.status, 'claimed')
    assert.equal(claimed.generation, hint.generation)

    const acked = await post(daemon.base, '/api/local-delivery/ack', { attempt_id: hint.attempt_id, stage: 'host-queued' }, token)
    assert.equal(acked.status, 200)

    const inbox = await fetch(`${daemon.base}/api/inbox?team=default&name=restart-agent`)
    assert.equal(inbox.status, 200)
    const messages = (await inbox.json()).messages
    assert.equal(messages.length, 1)
    assert.equal(messages[0].body, 'pending across restart')

    conn = db()
    const consumed = outbox(conn, sent.data.message_id)
    const cursor = conn.prepare("SELECT last_processed_event_id AS c FROM agents WHERE name='restart-agent'").get().c
    conn.close()
    assert.equal(consumed.status, 'inbox-consumed')
    assert.ok(cursor >= sent.data.event_id, 'the cursor advanced to the new message')
  } finally {
    await stopDaemon(daemon?.proc)
  }
})
