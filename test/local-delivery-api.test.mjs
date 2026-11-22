import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import { buildSync } from 'esbuild'
import { spawn } from 'node:child_process'
import { __internals as mod } from '../assets/claude/mod/hooks/register.js'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const require = createRequire(path.join(root, 'package.json'))
let deps = true
try { require.resolve('fastify'); require.resolve('better-sqlite3') } catch { deps = false }

async function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xats-local-api-'))
  const bundle = path.join(dir, 'server.mjs')
  fs.symlinkSync(path.join(root, 'node_modules'), path.join(dir, 'node_modules'), 'junction')
  buildSync({ stdin: { contents: `
    export { buildServer } from './daemon/src/daemon/server.ts';
    export { BroadcastToRoleService } from './daemon/src/mcp/broadcast-to-role.ts';
    export { AgentsRepo } from './daemon/src/storage/agents-repo.ts';
    export { EventsOutbox } from './daemon/src/storage/events-outbox.ts';
    export { GetDeliveryStatusService } from './daemon/src/mcp/delivery-status.ts';
    export { GetInboxService } from './daemon/src/mcp/get-inbox.ts';
  `, resolveDir: root, loader: 'ts' }, outfile: bundle, bundle: true, platform: 'node', format: 'esm', packages: 'external', logLevel: 'silent' })
  const services = await import(pathToFileURL(bundle).href)
  const { buildServer } = services
  const app = await buildServer({ dbPath: path.join(dir, 'data.db'), localDevice: 'local-test' })
  await app.ready()
  t.after(async () => { await app.close(); fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }) })
  const post = async (url, payload, token) => {
    const res = await app.inject({ method: 'POST', url, payload, headers: token ? { 'x-xats-delivery-token': token } : {} })
    return { status: res.statusCode, data: res.json() }
  }
  const wait = (token, ms = 0) => app.inject({ method: 'GET', url: `/api/local-delivery/wait?timeout_ms=${ms}`, headers: { 'x-xats-delivery-token': token } })
  const recipient = await post('/api/register', { name: 'claude-local', team: 'default', agent_type: 'claude-code', session_key: 'owned-session', bind_mcp: true, local_delivery: true })
  assert.equal(recipient.status, 200)
  const token = recipient.data.local_delivery.token
  await post('/api/register', { name: 'sender', agent_type: 'custom' })
  const send = (body, notify = true) => post('/api/send', { from: { name: 'sender', team: 'default' }, to: { agent_id: recipient.data.agent_id }, body, auto_poke: notify })
  const withDb = async fn => {
    const Database = require('better-sqlite3')
    const db = new Database(path.join(dir, 'data.db'))
    db.pragma('foreign_keys = ON')
    try { return await fn(db, services) } finally { db.close() }
  }
  return { app, post, wait, send, token, recipient: recipient.data, withDb }
}

test('default hook and mod deliver through the real daemon without a feature flag', { skip: !deps, timeout: 30000 }, async t => {
  const f = await fixture(t)
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'xats-default-home-'))
  mod.reset()
  t.after(() => { mod.reset(); fs.rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }) })
  const base = await f.app.listen({ port: 0, host: '127.0.0.1' })
  const env = { ...process.env, HOME: home, USERPROFILE: home, XATS_BASE: base,
    XATS_NAME: 'claude-default', XATS_TEAM: 'default', CLAUDE_JOB_DIR: '' }
  delete env.XATS_LOCAL_DELIVERY
  const runHook = flag => new Promise((resolve, reject) => {
    const hookEnv = { ...env }
    if (flag !== undefined) hookEnv.XATS_LOCAL_DELIVERY = flag
    const child = spawn(process.execPath, [path.join(root, 'assets/claude/xats-hook.mjs'), 'start'], {
      env: hookEnv, stdio: ['pipe', 'pipe', 'pipe'],
    })
    let output = ''
    child.stdout.on('data', chunk => { output += chunk })
    child.stderr.on('data', chunk => { output += chunk })
    child.once('error', reject)
    child.once('exit', code => code === 0 ? resolve(output) : reject(new Error(`hook exited ${code}`)))
    child.stdin.end(JSON.stringify({ session_id: 'default-session' }))
  })
  const output = await runHook()
  const leaseFile = path.join(home, '.xats/sessions/default-session.delivery.json')
  const lease = JSON.parse(fs.readFileSync(leaseFile, 'utf8'))
  assert.ok(!output.includes(lease.token), 'default capability stays out of model context')
  const submits = []
  const $ = {
    env: { get: async key => env[key] },
    session: { id: async () => 'default-session' },
    fs: { read: async file => fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : undefined,
      write: async (file, value) => fs.writeFileSync(file, value) },
    clock: { after: () => {}, every: () => {} },
    ui: { invalidate: () => {} },
    prompt: { submit: async value => { submits.push(value); return { text: value.text } } },
    http: { fetch: async (url, init) => {
      const response = await fetch(url, init)
      return { ok: response.ok, status: response.status, text: await response.text() }
    } },
  }
  await mod.poll($)
  assert.equal(mod.state().localOwned, true)
  const sent = await f.post('/api/send', { from: { name: 'sender', team: 'default' },
    to: { agent_id: lease.agent_id }, body: 'default-path-message', auto_poke: false })
  assert.equal(sent.status, 200)
  assert.equal(sent.data.poked, false)
  await mod.localTick($)
  await mod.poll($)
  await mod.deliver($)
  assert.equal(submits.length, 1)
  assert.equal(submits[0].asUser, undefined)
  await f.withDb(db => {
    const attempts = db.prepare('SELECT status FROM local_delivery_attempts WHERE message_id = ?').all(sent.data.message_id)
    assert.deepEqual(attempts, [{ status: 'host-queued' }])
  })
  await runHook('0')
  assert.equal(fs.existsSync(leaseFile), false)
  await f.withDb(db => {
    assert.equal(db.prepare('SELECT count(*) AS n FROM local_delivery_leases WHERE agent_id = ? AND revoked_at IS NULL').get(lease.agent_id).n, 0)
  })
})

test('explicit native receipt observations preserve original identity without authorizing stale ACKs', { skip: !deps, timeout: 20000 }, async t => {
  const f = await fixture(t)
  assert.equal((await f.post('/api/local-delivery/renew', {}, f.token)).data.receipt_observations, 1)
  const sent = await f.send('late native refusal', false)
  const original = (await f.wait(f.token)).json().hints[0]
  assert.equal((await f.post('/api/local-delivery/ack', { attempt_id: original.attempt_id,
    stage: 'transport-written' }, f.token)).status, 200)
  const rebound = await f.post('/api/register', { name: 'claude-local', team: 'default', agent_type: 'claude-code',
    session_key: 'owned-session', bind_mcp: true, local_delivery: true })
  assert.equal(rebound.data.agent_id, f.recipient.agent_id)
  const token = rebound.data.local_delivery.token
  const replacement = (await f.wait(token)).json().hints[0]
  assert.notEqual(replacement.attempt_id, original.attempt_id)
  const body = { attempt_id: original.attempt_id, stage: 'refused' }
  assert.equal((await f.post('/api/local-delivery/ack', body, token)).status, 409)
  assert.equal((await f.post('/api/local-delivery/ack', { ...body, observed_generation: replacement.generation }, token)).status, 409)
  assert.equal((await f.post('/api/local-delivery/ack', { ...body, stage: 'inbox-consumed',
    observed_generation: original.generation }, token)).status, 409, 'observations are not generic old-epoch write authority')
  assert.equal((await f.post('/api/local-delivery/ack', { ...body, observed_generation: original.generation }, token)).status, 200)
  await f.withDb((db, { GetInboxService, AgentsRepo }) => {
    const read = new GetInboxService(db, new AgentsRepo(db)).get({ caller: f.recipient.agent_id })
    assert.ok(read.messages.some(m => m.body === 'late native refusal'))
    const row = db.prepare('SELECT status,attempt_id,generation FROM local_delivery_outbox WHERE message_id=?').get(sent.data.message_id)
    assert.equal(row.status, 'refused')
    assert.equal(row.attempt_id, original.attempt_id)
    assert.equal(row.generation, original.generation)
  })
  await f.send('expired native notice', false)
  const expiring = (await f.wait(token)).json().hints[0]
  assert.equal((await f.post('/api/local-delivery/ack', { attempt_id: expiring.attempt_id, stage: 'expired' }, token)).status, 200)
})

test('a non-Claude harness can own local delivery with only a session key', { skip: !deps, timeout: 20000 }, async t => {
  const f = await fixture(t)
  const missingKey = await f.post('/api/register', { name: 'pi-no-key', team: 'default',
    agent_type: 'custom', agent_type_name: 'pi', local_delivery: true })
  assert.equal(missingKey.status, 400)
  assert.equal(missingKey.data.error, 'local_delivery_requires_session_key')
  const pi = await f.post('/api/register', { name: 'pi-lease', team: 'default', agent_type: 'custom',
    agent_type_name: 'pi', session_key: 'pi-session-1', local_delivery: true })
  assert.equal(pi.status, 200)
  assert.ok(pi.data.local_delivery?.token, 'a lease token is issued')
  assert.equal(pi.data.bind_token, undefined, 'MCP bind tokens stay Claude-only')
  const wait = await f.app.inject({ method: 'GET', url: '/api/local-delivery/wait?timeout_ms=0',
    headers: { 'x-xats-delivery-token': pi.data.local_delivery.token } })
  assert.equal(wait.statusCode, 200)
  assert.equal(Number(wait.json().generation), Number(pi.data.local_delivery.generation))
})

test('local adapter wakes from a commit, remains scoped, and prevents legacy poke', { skip: !deps, timeout: 20000 }, async t => {
  const f = await fixture(t)
  const pending = f.wait(f.token, 10000)
  await new Promise(resolve => setImmediate(resolve))
  const sent = await f.send('local event')
  assert.equal(sent.status, 200)
  assert.equal(sent.data.poked, false)
  assert.ok(sent.data.poke_skip_reasons.some(r => r.reason === 'local_adapter'))
  const response = await pending
  assert.equal(response.statusCode, 200)
  const hint = response.json().hints[0]
  assert.equal(hint.message_id, sent.data.message_id)
  assert.equal(hint.event_id, sent.data.event_id)
  assert.equal(hint.body, undefined, 'arrival hints must not carry message bodies')
  const ack = await f.post('/api/local-delivery/ack', { attempt_id: hint.attempt_id, stage: 'host-queued' }, f.token)
  assert.equal(ack.status, 200)
  assert.deepEqual((await f.wait(f.token)).json().hints, [])
  const unauthenticated = await f.wait('0'.repeat(64))
  assert.equal(unauthenticated.statusCode, 401)
  const roster = (await f.app.inject('/api/agents/all')).body
  assert.ok(!roster.includes(f.token), 'adapter capability must not leak into roster')
})

test('local delivery lease replacement fences stale waiters and acknowledgements', { skip: !deps, timeout: 20000 }, async t => {
  const f = await fixture(t)
  await f.send('first')
  const hint = (await f.wait(f.token)).json().hints[0]
  const renewed = await f.post('/api/local-delivery/renew', {}, f.token)
  assert.equal(renewed.status, 200)
  assert.equal(renewed.data.generation, f.recipient.local_delivery.generation)
  const replacement = await f.post('/api/register', { name: 'claude-local', team: 'default', agent_type: 'claude-code', session_key: 'owned-session', bind_mcp: true, local_delivery: true })
  assert.equal(replacement.status, 200)
  assert.notEqual(replacement.data.local_delivery.generation, hint.generation)
  assert.equal((await f.wait(f.token)).statusCode, 401)
  const stale = await f.post('/api/local-delivery/ack', { attempt_id: hint.attempt_id, stage: 'host-queued' }, replacement.data.local_delivery.token)
  assert.notEqual(stale.status, 200)
})

test('explicit auto_poke false still has exactly one delivery owner', { skip: !deps, timeout: 20000 }, async t => {
  const f = await fixture(t)
  assert.equal((await f.send('quiet message', false)).status, 200)
  // A live lease owns delivery even when the tmux wake is suppressed, so the
  // message is not left with zero owners.
  const hints = (await f.wait(f.token)).json().hints
  assert.equal(hints.length, 1, 'the local owner claims the quiet message')
  const rows = await f.withDb((db) => db.prepare('SELECT status FROM local_delivery_outbox').all())
  assert.equal(rows.length, 1, 'exactly one owner acted')
})

test('large role broadcasts expose only the actual recipient row, even behind quiet backlog', { skip: !deps, timeout: 20000 }, async t => {
  const f = await fixture(t)
  const plain = []
  for (let i = 0; i < 60; i++) {
    const row = await f.post('/api/register', { name: `reviewer-${i}`, role: 'reviewer', agent_type: 'custom' })
    plain.push(row.data.agent_id)
  }
  const local = await f.post('/api/register', { name: 'last-reviewer', role: 'reviewer', agent_type: 'claude-code', session_key: 'last-reviewer-session', bind_mcp: true, local_delivery: true })
  // Quiet backlog lives in a mailbox with no local lease, so it creates no outbox
  // rows and cannot shadow the broadcast row this test is about.
  for (let i = 0; i < 60; i++) await f.post('/api/send', {
    from: { name: 'sender', team: 'default' }, to: { agent_id: plain[0] }, body: `quiet-${i}`, auto_poke: false,
  })
  const broadcast = await f.withDb((db, { BroadcastToRoleService, AgentsRepo, EventsOutbox }) => {
    const agents = new AgentsRepo(db)
    const sender = db.prepare("SELECT agent_id FROM agents WHERE name='sender'").get()
    return new BroadcastToRoleService(db, agents, new EventsOutbox(db)).broadcast({ from: sender.agent_id, to_role: 'reviewer', body: 'review this' })
  })
  assert.equal(broadcast.recipients.length, 61)
  const hint = (await f.wait(local.data.local_delivery.token)).json().hints[0]
  assert.ok(hint, 'the broadcast row must be claimable after the quiet backlog')
  assert.equal(hint.event_id, broadcast.event_id)
  assert.notEqual(hint.message_id, broadcast.message_id, 'common broadcast send ID is not this recipient row ID')
  const preview = await f.app.inject(`/api/inbox?team=default&name=last-reviewer&since_event_id=${hint.event_id - 1}`)
  assert.equal(preview.json().messages.length, 1, 'targeted role copies must not leak into sibling mailboxes')
  assert.equal(preview.json().messages[0].id, hint.message_id)
  assert.equal(preview.json().messages[0].body, 'review this')
})

test('actual inbox consumption unblocks uncertain delivery; previews do not', { skip: !deps, timeout: 20000 }, async t => {
  const f = await fixture(t)
  const sent = await f.send('first')
  await f.send('second')
  const hint = (await f.wait(f.token)).json().hints[0]
  assert.equal((await f.post('/api/local-delivery/ack', { attempt_id: hint.attempt_id, stage: 'unknown' }, f.token)).status, 200)
  await f.app.inject('/api/inbox?team=default&name=claude-local&since_event_id=0')
  assert.deepEqual((await f.wait(f.token)).json().hints, [])
  await f.withDb((db, { GetInboxService, AgentsRepo, GetDeliveryStatusService }) => {
    const agents = new AgentsRepo(db)
    const result = new GetInboxService(db, agents).get({ caller: f.recipient.agent_id, limit: 1 })
    assert.equal(result.messages.length, 1)
    const sender = db.prepare("SELECT agent_id FROM agents WHERE name='sender'").get()
    const status = new GetDeliveryStatusService(db).get({ caller: sender.agent_id, message_id: sent.data.message_id })
    assert.equal(status.local_delivery[0].status, 'inbox-consumed')
    assert.equal(new GetDeliveryStatusService(db).get({ caller: f.recipient.agent_id, message_id: sent.data.message_id }).error, 'unknown_message')
  })
  assert.equal((await f.wait(f.token)).json().hints.length, 1)
})

test('local lease registration rejects arbitrary kinds and unkeyed identities', { skip: !deps, timeout: 20000 }, async t => {
  const f = await fixture(t)
  const invalid = await f.post('/api/register', { name: 'other', agent_type: 'custom', session_key: 'another-session', bind_mcp: true, local_delivery: true })
  assert.equal(invalid.status, 400)
  const missing = await f.post('/api/register', { name: 'unkeyed', agent_type: 'claude-code', local_delivery: true })
  assert.equal(missing.status, 400)
})
