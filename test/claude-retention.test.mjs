import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { transform } from 'esbuild'

const require = createRequire(new URL('../package.json', import.meta.url))
const Database = require('better-sqlite3')
const sourcePath = fileURLToPath(new URL('../daemon/src/daemon/cleanup.ts', import.meta.url))
const source = fs.readFileSync(sourcePath, 'utf8')
const compiled = await transform(source, { loader: 'ts', format: 'esm' })
const { runCleanup } = await import(`data:text/javascript;base64,${Buffer.from(compiled.code).toString('base64')}`)
const isoDaysBefore = (now, days) => new Date(now.getTime() - days * 86400_000).toISOString()

test('Claude mailbox is retained 30 days from offline_since, then purged with capability', () => {
  const db = new Database(':memory:')
  try {
    db.pragma('foreign_keys = ON')
    db.exec(`
      CREATE TABLE events(event_id INTEGER PRIMARY KEY, created_at TEXT NOT NULL);
      CREATE TABLE agents(
        agent_id TEXT PRIMARY KEY, agent_type TEXT, session_key TEXT,
        offline_since TEXT, role TEXT, last_seen_at TEXT,
        delivery_kind TEXT, delivery_payload TEXT
      );
      CREATE TABLE claude_bind_capabilities(
        token_hash TEXT PRIMARY KEY,
        agent_id TEXT NOT NULL REFERENCES agents(agent_id) ON DELETE CASCADE,
        session_key TEXT NOT NULL, issued_at TEXT NOT NULL, revoked_at TEXT
      );
      CREATE TABLE messages(id TEXT PRIMARY KEY, event_id INTEGER REFERENCES events(event_id), sent_at TEXT NOT NULL);
      CREATE TABLE message_delivery_status(message_id TEXT NOT NULL REFERENCES messages(id));
    `)
    const now = new Date('2026-01-31T12:00:00.000Z')
    const insertAgent = db.prepare(`INSERT INTO agents(agent_id, agent_type, session_key, offline_since, role, last_seen_at, delivery_kind, delivery_payload)
      VALUES (?, 'claude-code', ?, ?, 'default', ?, 'none', NULL)`)
    insertAgent.run('keep', 'session-keep', isoDaysBefore(now, 29), isoDaysBefore(now, 30))
    insertAgent.run('purge', 'session-purge', isoDaysBefore(now, 31), isoDaysBefore(now, 32))
    db.prepare('INSERT INTO claude_bind_capabilities VALUES (?, ?, ?, ?, NULL)')
      .run('hash-keep', 'keep', 'session-keep', isoDaysBefore(now, 29))
    db.prepare('INSERT INTO claude_bind_capabilities VALUES (?, ?, ?, ?, NULL)')
      .run('hash-purge', 'purge', 'session-purge', isoDaysBefore(now, 31))

    runCleanup(db, { now })

    assert.ok(db.prepare('SELECT 1 FROM agents WHERE agent_id=?').get('keep'))
    assert.equal(db.prepare('SELECT 1 FROM agents WHERE agent_id=?').get('purge'), undefined)
    assert.ok(db.prepare('SELECT 1 FROM claude_bind_capabilities WHERE token_hash=?').get('hash-keep'))
    assert.equal(db.prepare('SELECT 1 FROM claude_bind_capabilities WHERE token_hash=?').get('hash-purge'), undefined)
  } finally {
    db.close()
  }
})
