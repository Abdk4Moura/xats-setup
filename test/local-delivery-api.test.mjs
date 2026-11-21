import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import { buildSync } from 'esbuild'

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
  const rows = f.withDb((db) => db.prepare('SELECT status FROM local_delivery_outbox').all())
  assert.equal(rows.length, 1, 'exactly one owner acted')
})

test('large role broadcasts expose only the actual recipient row, even behind quiet backlog', { skip: !deps, timeout: 20000 }, async t => {
  const f = await fixture(t)
  for (let i = 0; i < 60; i++) await f.post('/api/register', { name: `reviewer-${i}`, role: 'reviewer', agent_type: 'custom' })
  const local = await f.post('/api/register', { name: 'last-reviewer', role: 'reviewer', agent_type: 'claude-code', session_key: 'last-reviewer-session', bind_mcp: true, local_delivery: true })
  for (let i = 0; i < 60; i++) await f.post('/api/send', {
    from: { name: 'sender', team: 'default' }, to: { agent_id: local.data.agent_id }, body: `quiet-${i}`, auto_poke: false,
  })
  const broadcast = await f.withDb((db, { BroadcastToRoleService, AgentsRepo, EventsOutbox }) => {
    const agents = new AgentsRepo(db)
    const sender = db.prepare("SELECT agent_id FROM agents WHERE name='sender'").get()
    return new BroadcastToRoleService(db, agents, new EventsOutbox(db)).broadcast({ from: sender.agent_id, to_role: 'reviewer', body: 'review this' })
  })
  assert.equal(broadcast.recipients.length, 61)
  let hint
  for (let i = 0; i <= 61; i++) {
    const next = (await f.wait(local.data.local_delivery.token)).json().hints[0]
    if (!next) break
    if (next.event_id === broadcast.event_id) { hint = next; break }
  }
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
