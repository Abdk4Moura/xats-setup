import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { build } from 'esbuild'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const require = createRequire(import.meta.url)
const depDirs = [process.env.XATS_SETUP_TEST_DEPS, path.join(root, 'daemon', 'node_modules'),
  path.join(root, 'node_modules'), path.join(os.homedir(), '.xats', 'daemon', 'node_modules')].filter(Boolean)
const sqliteDir = depDirs.find(dir => fs.existsSync(path.join(dir, 'better-sqlite3', 'package.json')))

test('isolated durable local delivery store', { skip: !sqliteDir && 'better-sqlite3 missing (set XATS_SETUP_TEST_DEPS)' }, async t => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'xats-local-delivery-'))
  t.after(() => fs.rmSync(scratch, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }))
  await build({
    entryPoints: [path.join(root, 'daemon/src/storage/local-delivery.ts'), path.join(root, 'daemon/src/storage/schema.ts')],
    bundle: true, platform: 'node', format: 'esm', outdir: scratch, outExtension: { '.js': '.mjs' },
  })
  const { LocalDeliveryStore, initLocalDeliverySchema } = await import(pathToFileURL(path.join(scratch, 'local-delivery.mjs')).href)
  const { applySchema } = await import(pathToFileURL(path.join(scratch, 'schema.mjs')).href)
  const Database = require(path.join(sqliteDir, 'better-sqlite3'))
  function fixture(file = ':memory:') {
    const db = new Database(file)
    db.pragma('foreign_keys = ON')
    applySchema(db)
    initLocalDeliverySchema(db)
    initLocalDeliverySchema(db)
    const store = new LocalDeliveryStore(db)
    const addAgent = (id, session = `session-${id}`) => db.prepare(`INSERT OR IGNORE INTO agents
      (agent_id, device, team, role, name, registered_at, last_seen_at, session_key)
      VALUES (?, 'local', 'test', 'worker', ?, 'now', 'now', ?)`).run(id, id, session)
    addAgent('a'); addAgent('b')
    return { db, store, addAgent }
  }
  function lease(store, agentId = 'a', now = 10_000, ttlMs = 60_000) {
    return store.issueLease({ agentId, sessionKey: `session-${agentId}`, now, ttlMs })
  }
  function enqueue(store, messageId, eventId, agentId = 'a', now = 10_001) {
    return store.enqueue({ messageId, eventId, agentId, now })
  }
  const ack = (store, token, row, stage, now = 10_003) => store.acknowledge(token, { attemptId: row.attempt_id, stage, now })

  await t.test('32-byte opaque credentials persist only hashes and bind to a live agent session', () => {
    const file = path.join(scratch, 'secrets.db')
    const { db, store } = fixture(file)
    let plaintext
    try {
      const issued = lease(store)
      plaintext = issued.token
      assert.equal(Buffer.from(issued.token, 'base64url').length, 32)
      const stored = db.prepare('SELECT * FROM local_delivery_leases').get()
      assert.equal(stored.token_hash, createHash('sha256').update(issued.token).digest('hex'))
      assert.equal(Object.values(stored).includes(issued.token), false)
      const { token, ...identity } = issued
      assert.deepEqual(store.authenticate(token, 10_001), identity)
      assert.equal(store.authenticate(`${token.slice(0, -1)}!`, 10_001), null)
      assert.equal(store.authenticate('not-a-token', 10_001), null)
      assert.throws(() => store.issueLease({ agentId: 'b', sessionKey: 'session-a', now: 10_001 }), /binding/)
      db.prepare("UPDATE agents SET session_key = 'new-session' WHERE agent_id = 'a'").run()
      assert.equal(store.authenticate(token, 10_001), null)
      assert.equal(store.renew(token, { now: 10_001 }), null)
      assert.equal(store.expireLeases(10_001), 1)
      const dump = db.serialize()
      assert.equal(dump.includes(Buffer.from(token)), false)
    } finally { db.close() }
    assert.equal(fs.readFileSync(file).includes(Buffer.from(plaintext)), false)
  })

  await t.test('one ordered outstanding claim per recipient and receipt stages remain distinct', () => {
    const { db, store } = fixture()
    try {
      const a = lease(store); const b = lease(store, 'b')
      enqueue(store, 'first', 1); enqueue(store, 'second', 2); enqueue(store, 'other', 3, 'b')
      const [first] = store.claim(a.token, { now: 10_002, limit: 100 })
      assert.equal(first.message_id, 'first'); assert.equal(first.seq, 1)
      assert.equal(first.generation, a.generation)
      assert.equal('body' in first, false)
      assert.equal(store.claim(a.token, { now: 10_003 })[0].attempt_id, first.attempt_id,
        'a lost long-poll response replays the same body-free hint')
      assert.equal(store.claim(b.token, { now: 10_002 })[0].message_id, 'other')
      assert.equal(ack(store, b.token, first, 'host-queued'), false)
      assert.equal(ack(store, a.token, first, 'transport-written'), true)
      const [afterHint] = store.claim(a.token, { now: 10_004 })
      assert.equal(afterHint.message_id, 'second', 'hint handoff unblocks later hints without claiming host admission')
      assert.equal(store.listForMessage('first')[0].status, 'transport-written')
      assert.equal(ack(store, a.token, first, 'host-queued'), true)
      const [second] = store.claim(a.token, { now: 10_004 })
      assert.equal(second.message_id, 'second'); assert.equal(second.seq, 2)
      assert.equal(ack(store, a.token, first, 'inbox-consumed', 10_005), true)
      assert.equal(ack(store, a.token, first, 'model-turn-started', 10_006), true)
      assert.equal(ack(store, a.token, first, 'replied', 10_007), true)
      assert.equal(ack(store, a.token, first, 'transport-written', 10_008), true)
      assert.equal(store.listForMessage('first')[0].status, 'replied')
      assert.equal(ack(store, a.token, second, 'replied'), true) // No queue receipt is required for a reply fact.
      assert.equal(store.listForMessage('second')[0].status, 'replied')
      assert.equal(ack(store, a.token, first, 'claimed'), false)
      assert.equal(ack(store, a.token, first, 'invented-stage'), false)
    } finally { db.close() }
  })

  for (const coveringRead of [false, true]) await t.test(`a delayed refusal settles its original attempt after restart (covering read=${coveringRead})`, () => {
    const { db, store } = fixture()
    try {
      const first = lease(store)
      enqueue(store, 'late-refusal', 7)
      const [original] = store.claim(first.token, { now: 10002 })
      ack(store, first.token, original, 'transport-written')
      store.rearmAfterRestart(10004)
      const observer = lease(store, 'a', 10005)
      const foreign = lease(store, 'b', 10005)
      const [replacement] = store.claim(observer.token, { now: 10006 })
      ack(store, observer.token, replacement, 'transport-written', 10007)
      if (coveringRead) {
        db.prepare('UPDATE agents SET last_processed_event_id=7 WHERE agent_id=?').run('a')
        store.consumeThrough('a', 7, 10008)
      }
      const fact = { attemptId: original.attempt_id, generation: first.generation, stage: 'refused', now: 10009 }
      assert.equal(store.observe(first.token, fact), false, 'an expired observer token never regains authority')
      assert.equal(store.observe(foreign.token, fact), false, 'a different mailbox cannot report this receipt')
      assert.equal(store.observe(observer.token, { ...fact, generation: observer.generation }), false)
      assert.equal(ack(store, observer.token, original, 'refused', 10009), false, 'ordinary stale ACKs remain forbidden')
      assert.equal(store.observe(observer.token, fact), true)
      const row = store.listForMessage('late-refusal')[0]
      assert.equal(row.status, 'refused')
      assert.equal(row.attempt_id, original.attempt_id, 'do not fabricate a receipt for the replacement attempt')
      assert.equal(row.generation, first.generation)
      assert.equal(db.prepare('SELECT status FROM local_delivery_attempts WHERE attempt_id=?').get(original.attempt_id).status, 'refused')
      assert.equal(store.consumeThrough('a', 7, 10010), 0)
      assert.equal(store.listForMessage('late-refusal')[0].status, 'refused')
      assert.equal(store.observe(observer.token, { ...fact, stage: 'host-queued' }), false, 'refusal is terminal')
    } finally { db.close() }
  })

  await t.test('a new session cannot report receipts belonging to a previous session of the same mailbox', () => {
    const { db, store } = fixture()
    try {
      const first = lease(store)
      enqueue(store, 'old-session', 1)
      const [original] = store.claim(first.token, { now: 10002 })
      ack(store, first.token, original, 'transport-written')
      db.prepare('UPDATE agents SET session_key=? WHERE agent_id=?').run('new-session', 'a')
      const next = store.issueLease({ agentId: 'a', sessionKey: 'new-session', now: 10004 })
      assert.equal(store.observe(next.token, { attemptId: original.attempt_id, generation: first.generation,
        stage: 'refused', now: 10005 }), false)
    } finally { db.close() }
  })

  await t.test('an observed old held release reconciles only the actual original generation and stored MCP cursor', () => {
    const { db, store } = fixture()
    try {
      const first = lease(store)
      enqueue(store, 'held-release', 7)
      const [original] = store.claim(first.token, { now: 10002 })
      ack(store, first.token, original, 'held')
      store.rearmAfterRestart(10004)
      const observer = lease(store, 'a', 10005)
      assert.deepEqual(store.claim(observer.token, { now: 10006 }), [])
      db.prepare('UPDATE agents SET last_processed_event_id=7 WHERE agent_id=?').run('a')
      assert.equal(store.consumeThrough('a', 7, 10007), 0, 'a read is not permission to release a hold')
      assert.equal(store.observe(observer.token, { attemptId: original.attempt_id, generation: first.generation,
        stage: 'host-queued', now: 10008 }), true)
      const row = store.listForMessage('held-release')[0]
      assert.equal(row.status, 'inbox-consumed')
      assert.equal(row.attempt_id, original.attempt_id)
      assert.equal(row.generation, first.generation)
      assert.equal(ack(store, observer.token, original, 'inbox-consumed', 10009), false)
    } finally { db.close() }
  })

  await t.test('renew preserves generation and attempts; replacement and revocation reject stale ACKs', () => {
    const { db, store } = fixture()
    try {
      const old = lease(store, 'a', 10_000, 1_000)
      enqueue(store, 'm', 1)
      const [attempt] = store.claim(old.token, { now: 10_002 })
      const renewed = store.renew(old.token, { now: 10_500, ttlMs: 2_000 })
      assert.equal(renewed.generation, old.generation)
      assert.equal(renewed.expiresAt, 12_500)
      assert.equal(ack(store, old.token, attempt, 'transport-written', 11_500), true)
      const next = lease(store, 'a', 11_600)
      assert.equal(next.generation, old.generation + 1)
      assert.equal(store.authenticate(old.token, 11_601), null)
      assert.equal(ack(store, old.token, attempt, 'host-queued', 11_601), false)
      assert.equal(ack(store, next.token, attempt, 'host-queued', 11_601), false)
      const [replayed] = store.claim(next.token, { now: 11_602 })
      assert.equal(replayed.message_id, attempt.message_id)
      assert.notEqual(replayed.attempt_id, attempt.attempt_id)
      assert.equal(db.prepare('SELECT status FROM local_delivery_attempts WHERE attempt_id = ?').get(attempt.attempt_id).status, 'unknown')
      store.revokeAgent('a', 11_603)
      assert.equal(ack(store, next.token, replayed, 'host-queued', 11_604), false)
      assert.equal(store.renew(next.token, { now: 11_604 }), null)
      assert.equal(store.ownsDelivery('m', 'a'), true)
      assert.equal(lease(store, 'a', 11_605).generation, next.generation + 1)
    } finally { db.close() }
  })

  await t.test('enqueue is idempotent; nested transaction rolls mailbox and intent back together', () => {
    const { db, store } = fixture()
    try {
      lease(store)
      const first = enqueue(store, 'm', 1)
      assert.deepEqual(enqueue(store, 'm', 1), first)
      assert.throws(() => enqueue(store, 'm', 2), /Conflicting/)
      assert.equal(db.prepare('SELECT count(*) AS n FROM local_delivery_outbox').get().n, 1)
      assert.throws(() => db.transaction(() => {
        db.prepare(`INSERT INTO events (from_team, to_team, event_type, payload, created_at)
          VALUES ('test', 'test', 'message', '{}', 'now')`).run()
        db.prepare(`INSERT INTO messages
          (id, event_id, from_team, to_team, from_agent_id, to_agent_id, body, sent_at)
          VALUES ('rollback', 1, 'test', 'test', 'b', 'a', 'durable body', 'now')`).run()
        enqueue(store, 'rollback', 1)
        assert.equal(store.ownsDelivery('rollback', 'a'), true)
        throw Error('rollback-test')
      })(), /rollback-test/)
      assert.equal(db.prepare("SELECT count(*) AS n FROM messages WHERE id = 'rollback'").get().n, 0)
      assert.deepEqual(store.listForMessage('rollback'), [])
      assert.equal(enqueue(store, 'next', 2).seq, 2)
      db.transaction(() => {
        db.prepare(`INSERT INTO events (from_team, to_team, event_type, payload, created_at)
          VALUES ('test', 'test', 'message', '{}', 'now')`).run()
        db.prepare(`INSERT INTO messages
          (id, event_id, from_team, to_team, from_agent_id, to_agent_id, body, sent_at)
          VALUES ('committed', 1, 'test', 'test', 'b', 'a', 'durable body', 'now')`).run()
        enqueue(store, 'committed', 1)
      })()
      assert.equal(db.prepare("SELECT body FROM messages WHERE id = 'committed'").get().body, 'durable body')
      assert.equal(store.listForMessage('committed')[0].status, 'stored')
      // Mailbox retention can remove content without deleting delivery history.
      db.prepare("DELETE FROM messages WHERE id = 'committed'").run()
      assert.equal(store.listForMessage('committed').length, 1)
      assert.equal(store.claim(lease(store, 'a', 10_002).token, { now: 10_003 })[0].message_id, 'm')
    } finally { db.close() }
  })

  await t.test('restart and lost ACK replay the same hint; a new generation fences the old attempt', () => {
    const file = path.join(scratch, 'restart.db')
    let { db, store } = fixture(file)
    const issued = lease(store, 'a', 10_000, 1_000)
    enqueue(store, 'm', 1); enqueue(store, 'later', 2)
    const [first] = store.claim(issued.token, { now: 10_002 })
    // Simulate losing the HTTP response or ACK, not a confirmed host receipt.
    db.close()
    ;({ db, store } = fixture(file))
    try {
      assert.equal(store.claim(issued.token, { now: 10_500 })[0].attempt_id, first.attempt_id)
      assert.equal(store.expireLeases(11_000), 1)
      assert.equal(store.expireLeases(11_001), 0)
      assert.equal(store.listForMessage('m')[0].status, 'unknown')
      assert.equal(ack(store, issued.token, first, 'host-queued', 11_001), false)
      const current = lease(store, 'a', 11_002)
      const [again] = store.claim(current.token, { now: 11_003 })
      assert.equal(again.message_id, 'm'); assert.notEqual(again.attempt_id, first.attempt_id)
      assert.equal(ack(store, current.token, again, 'host-queued', 11_004), true)
      const [later] = store.claim(current.token, { now: 11_005 })
      assert.equal(later.message_id, 'later')
      assert.equal(ack(store, current.token, later, 'host-queued', 11_006), true)
      const facts = db.prepare('SELECT stage FROM local_delivery_facts WHERE attempt_id = ? ORDER BY stage').all(first.attempt_id)
      assert.deepEqual(facts.map(f => f.stage), ['claimed', 'unknown'])
      db.close()
      ;({ db, store } = fixture(file))
      const restarted = lease(store, 'a', 11_007)
      assert.deepEqual(store.claim(restarted.token, { now: 11_008 }), [])
    } finally { db.close() }
  })

  await t.test('explicit inbox consumption reconciles unknown hints without repeating host delivery', () => {
    const { db, store } = fixture()
    try {
      const a = lease(store); const b = lease(store, 'b')
      enqueue(store, 'm', 1); enqueue(store, 'next', 2); enqueue(store, 'other', 1, 'b')
      const [uncertain] = store.claim(a.token, { now: 10002 })
      assert.equal(ack(store, a.token, uncertain, 'unknown'), true)
      assert.deepEqual(store.claim(a.token, { now: 10004 }), [])
      assert.equal(store.consumeThrough('a', 1, 10005), 1)
      assert.equal(store.listForMessage('m')[0].status, 'inbox-consumed')
      assert.equal(store.claim(a.token, { now: 10006 })[0].message_id, 'next')
      assert.equal(store.claim(b.token, { now: 10006 })[0].message_id, 'other')
      assert.equal(ack(store, a.token, uncertain, 'unknown', 10007), true)
      assert.equal(store.listForMessage('m')[0].status, 'inbox-consumed')
    } finally { db.close() }
  })

  await t.test('a refused delivery is never reconciled as consumed by a later read', () => {
    const { db, store } = fixture()
    try {
      const a = lease(store)
      enqueue(store, 'refused-message', 1)
      const [refused] = store.claim(a.token, { now: 10002 })
      assert.equal(ack(store, a.token, refused, 'refused'), true)
      assert.equal(store.listForMessage('refused-message')[0].status, 'refused')
      // The person reads the mailbox by other means: the refusal must survive.
      assert.equal(store.consumeThrough('a', 1, 10003), 0)
      assert.equal(store.listForMessage('refused-message')[0].status, 'refused')
      const facts = db.prepare('SELECT stage FROM local_delivery_facts WHERE attempt_id=?').all(refused.attempt_id).map(r => r.stage)
      assert.deepEqual(facts.sort(), ['claimed', 'refused'])
    } finally { db.close() }
  })

  await t.test('a held delivery is never reconciled as consumed by a later read', () => {
    const { db, store } = fixture()
    try {
      const a = lease(store)
      enqueue(store, 'held-message', 1)
      const [held] = store.claim(a.token, { now: 10002 })
      assert.equal(ack(store, a.token, held, 'held'), true)
      assert.equal(store.consumeThrough('a', 1, 10003), 0)
      assert.equal(store.listForMessage('held-message')[0].status, 'held')
    } finally { db.close() }
  })

  await t.test('schema reinitialization never consumes an unread zero mailbox cursor', () => {
    const { db } = fixture()
    try {
      db.prepare(`INSERT INTO events (from_team, to_team, event_type, payload, created_at)
        VALUES ('test', 'test', 'message_sent', '{}', 'now')`).run()
      assert.equal(db.prepare("SELECT last_processed_event_id AS cursor FROM agents WHERE agent_id='a'").get().cursor, 0)
      applySchema(db)
      assert.equal(db.prepare("SELECT last_processed_event_id AS cursor FROM agents WHERE agent_id='a'").get().cursor, 0)
    } finally { db.close() }
  })

  await t.test('TTL is bounded, expiration is exact, malformed time fails closed', () => {
    const { db, store } = fixture()
    try {
      const short = lease(store, 'a', 10_000, -100)
      assert.equal(short.expiresAt, 11_000)
      assert.ok(store.authenticate(short.token, 10_999))
      assert.equal(store.authenticate(short.token, 11_000), null)
      assert.equal(store.renew(short.token, { now: 11_000 }), null)
      const long = lease(store, 'a', 11_000, 999_999_999)
      assert.equal(long.expiresAt, 311_000)
      assert.throws(() => lease(store, 'a', 11_001, Infinity), /TTL/)
      assert.throws(() => store.authenticate(long.token, NaN), /time/)
      assert.throws(() => lease(store, 'a', -1), /time/)
      assert.deepEqual(store.claim(long.token, { now: 11_001, limit: 0 }), [])
    } finally { db.close() }
  })

  await t.test('holds block order, approval can resolve, refusal and explicit expiry never fall back', () => {
    const { db, store } = fixture()
    try {
      const issued = lease(store)
      enqueue(store, 'held', 1); enqueue(store, 'refused', 2); enqueue(store, 'expired', 3); enqueue(store, 'last', 4)
      const [held] = store.claim(issued.token, { now: 10_002 })
      assert.equal(ack(store, issued.token, held, 'held'), true)
      assert.equal(ack(store, issued.token, held, 'transport-written'), true)
      assert.equal(store.listForMessage('held')[0].status, 'held')
      assert.deepEqual(store.claim(issued.token, { now: 10_004 }), [])
      assert.equal(ack(store, issued.token, held, 'host-queued', 10_005), true)
      const [refused] = store.claim(issued.token, { now: 10_006 })
      assert.equal(ack(store, issued.token, refused, 'refused', 10_007), true)
      assert.equal(ack(store, issued.token, refused, 'host-queued', 10_008), false)
      const [expired] = store.claim(issued.token, { now: 10_009 })
      assert.equal(ack(store, issued.token, expired, 'held', 10_010), true)
      assert.equal(ack(store, issued.token, expired, 'expired', 10_011), true)
      assert.equal(store.claim(issued.token, { now: 10_012 })[0].message_id, 'last')
      for (const id of ['held', 'refused', 'expired']) assert.equal(store.ownsDelivery(id, 'a'), true)
      lease(store, 'a', 10_013)
      assert.equal(store.listForMessage('refused')[0].status, 'refused')
      assert.equal(store.listForMessage('expired')[0].status, 'expired')
    } finally { db.close() }
  })

  await t.test('held request survives endpoint replacement without timer-driven fallback', () => {
    const { db, store } = fixture()
    try {
      const issued = lease(store, 'a', 10_000, 1_000)
      enqueue(store, 'approval', 1); enqueue(store, 'later', 2)
      const [held] = store.claim(issued.token, { now: 10_002 })
      ack(store, issued.token, held, 'held')
      store.expireLeases(11_000)
      const replacement = lease(store, 'a', 11_001)
      assert.deepEqual(store.claim(replacement.token, { now: 11_002 }), [])
      assert.equal(ack(store, replacement.token, held, 'host-queued', 11_003), false)
      assert.equal(store.listForMessage('approval')[0].status, 'held')
      assert.equal(store.ownsDelivery('approval', 'a'), true)
    } finally { db.close() }
  })

  await t.test('explicit unknown blocks same generation; failed stays terminal; legacy ownership is not stolen', () => {
    const { db, store } = fixture()
    try {
      enqueue(store, 'legacy', 1)
      assert.equal(store.ownsDelivery('legacy', 'a'), false)
      const issued = lease(store)
      const b = lease(store, 'b')
      enqueue(store, 'reconciled', 4, 'b')
      const [reconciled] = store.claim(b.token, { now: 10_002 })
      assert.equal(ack(store, b.token, reconciled, 'unknown'), true)
      assert.equal(ack(store, b.token, reconciled, 'transport-written'), false)
      assert.equal(ack(store, b.token, reconciled, 'inbox-consumed', 10_004), true)
      assert.equal(store.listForMessage('reconciled')[0].status, 'inbox-consumed')
      enqueue(store, 'unknown', 2); enqueue(store, 'failed', 3)
      assert.equal(store.ownsDelivery('legacy', 'a'), false)
      const [uncertain] = store.claim(issued.token, { now: 10_002 })
      assert.equal(uncertain.message_id, 'unknown')
      assert.equal(ack(store, issued.token, uncertain, 'unknown'), true)
      assert.deepEqual(store.claim(issued.token, { now: 10_004 }), [])
      const replacement = lease(store, 'a', 10_005)
      const [hint] = store.claim(replacement.token, { now: 10_006 })
      ack(store, replacement.token, hint, 'inbox-consumed', 10_007)
      const [failed] = store.claim(replacement.token, { now: 10_008 })
      ack(store, replacement.token, failed, 'failed', 10_009)
      const third = lease(store, 'a', 10_010)
      assert.deepEqual(store.claim(third.token, { now: 10_011 }), [])
      assert.equal(store.ownsDelivery('failed', 'a'), true)
      assert.equal(store.listForMessage('legacy')[0].status, 'stored')
      db.prepare("DELETE FROM agents WHERE agent_id = 'a'").run()
      assert.deepEqual(store.listForMessage('failed'), [])
      assert.equal(db.prepare("SELECT count(*) AS n FROM local_delivery_attempts WHERE agent_id = 'a'").get().n, 0)
      assert.equal(db.prepare('SELECT count(*) AS n FROM local_delivery_facts').get().n, 3)
      assert.deepEqual(db.pragma('foreign_key_check'), [])
    } finally { db.close() }
  })
})
