import { createHash, randomBytes, randomUUID } from 'node:crypto'
import type Database from 'better-sqlite3'

export type DeliveryStage = 'stored' | 'claimed' | 'transport-written' | 'host-queued'
  | 'held' | 'inbox-consumed' | 'model-turn-started' | 'replied'
  | 'refused' | 'expired' | 'failed' | 'unknown'

export interface LocalDeliveryLease {
  agentId: string
  sessionKey: string
  generation: number
  expiresAt: number
}
export interface LocalDeliveryRow {
  message_id: string
  agent_id: string
  event_id: number
  seq: number
  status: DeliveryStage
  selected: number
  attempt_id: string | null
  generation: number | null
  created_at: number
  updated_at: number
}
export interface LocalDeliveryClaim extends LocalDeliveryRow {
  attempt_id: string
  generation: number
}

const DEFAULT_TTL = 60_000
const MIN_TTL = 1_000
const MAX_TTL = 300_000
const stages = new Set<DeliveryStage>([
  'stored', 'claimed', 'transport-written', 'host-queued', 'held', 'inbox-consumed',
  'model-turn-started', 'replied', 'refused', 'expired', 'failed', 'unknown',
])
const completionRank: Partial<Record<DeliveryStage, number>> = {
  'host-queued': 1, 'inbox-consumed': 2, 'model-turn-started': 3, replied: 4,
}
const hash = (token: string): string => createHash('sha256').update(token).digest('hex')
function time(now = Date.now()): number {
  if (!Number.isSafeInteger(now) || now < 0) throw new Error('Invalid delivery time')
  return now
}
function ttl(value = DEFAULT_TTL): number {
  if (!Number.isFinite(value)) throw new Error('Invalid lease TTL')
  return Math.max(MIN_TTL, Math.min(MAX_TTL, Math.floor(value)))
}

/** Additive schema only. Existing mailbox and wake-status tables are unchanged. */
export function initLocalDeliverySchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS local_delivery_endpoints (
      agent_id TEXT PRIMARY KEY REFERENCES agents(agent_id) ON DELETE CASCADE,
      generation INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS local_delivery_leases (
      agent_id TEXT NOT NULL REFERENCES agents(agent_id) ON DELETE CASCADE,
      generation INTEGER NOT NULL,
      session_key TEXT NOT NULL,
      token_hash TEXT NOT NULL UNIQUE,
      expires_at INTEGER NOT NULL,
      revoked_at INTEGER,
      PRIMARY KEY (agent_id, generation)
    );
    CREATE TABLE IF NOT EXISTS local_delivery_sequences (
      agent_id TEXT PRIMARY KEY REFERENCES agents(agent_id) ON DELETE CASCADE,
      seq INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS local_delivery_outbox (
      message_id TEXT NOT NULL,
      agent_id TEXT NOT NULL REFERENCES agents(agent_id) ON DELETE CASCADE,
      event_id INTEGER NOT NULL,
      seq INTEGER NOT NULL,
      status TEXT NOT NULL,
      selected INTEGER NOT NULL,
      attempt_id TEXT,
      generation INTEGER,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (message_id, agent_id),
      UNIQUE (agent_id, seq)
    );
    CREATE TABLE IF NOT EXISTS local_delivery_attempts (
      attempt_id TEXT PRIMARY KEY,
      message_id TEXT NOT NULL,
      agent_id TEXT NOT NULL,
      generation INTEGER NOT NULL,
      status TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      FOREIGN KEY (message_id, agent_id)
        REFERENCES local_delivery_outbox(message_id, agent_id) ON DELETE CASCADE
    );
    CREATE TABLE IF NOT EXISTS local_delivery_facts (
      attempt_id TEXT NOT NULL REFERENCES local_delivery_attempts(attempt_id) ON DELETE CASCADE,
      stage TEXT NOT NULL,
      observed_at INTEGER NOT NULL,
      PRIMARY KEY (attempt_id, stage)
    );
    CREATE INDEX IF NOT EXISTS local_delivery_pending ON local_delivery_outbox(agent_id, selected, seq);
  `)
}

/**
 * Scoped arrival hints ONLY, never message bodies. The caller authorizes session
 * binding and commits enqueue alongside the mailbox insert in its own transaction.
 * A claim is not a read receipt. Only explicit host receipts prove admission.
 *
 * Uncertain attempts remain recorded as unknown. A replacement generation may
 * replay their hints safely because content is read separately from the durable
 * inbox cursor. This is NOT safe for direct body submission or exactly-once turns.
 * Held requests block later hints, including across replacement. Refused, expired
 * and failed requests never retry or fall back. No transport fallback is performed.
 *
 * Tokens are returned once, stored only as SHA-256 hashes, and must not be logged.
 * The same-user daemon is not a sandbox against other same-user processes.
 */
export class LocalDeliveryStore {
  constructor(private db: Database.Database) {}

  private current(agentId: string, now: number): LocalDeliveryLease | null {
    const row = this.db.prepare(`SELECT l.agent_id AS agentId, l.session_key AS sessionKey,
        l.generation, l.expires_at AS expiresAt
      FROM local_delivery_leases l
      JOIN local_delivery_endpoints e ON e.agent_id = l.agent_id AND e.generation = l.generation
      JOIN agents a ON a.agent_id = l.agent_id AND a.session_key = l.session_key
      WHERE l.agent_id = ? AND l.revoked_at IS NULL AND l.expires_at > ? AND a.offline_since IS NULL`).get(agentId, now)
    return row as LocalDeliveryLease | undefined ?? null
  }

  /**
   * Ownership probe for the send path. A recipient has a local delivery owner
   * only while a live, unexpired lease is bound to its current session and the
   * agent is online. Otherwise the polling/host path owns delivery.
   */
  hasLiveLease(agentId: string, now = Date.now()): boolean {
    time(now)
    if (typeof agentId !== 'string' || agentId.length === 0) return false
    return this.current(agentId, now) !== null
  }

  issueLease(args: { agentId: string; sessionKey: string; ttlMs?: number; now?: number }): LocalDeliveryLease & { token: string } {
    const now = time(args.now)
    const duration = ttl(args.ttlMs)
    return this.db.transaction(() => {
      if (!args.sessionKey || !this.db.prepare('SELECT 1 FROM agents WHERE agent_id = ? AND session_key = ? AND offline_since IS NULL')
        .get(args.agentId, args.sessionKey)) throw new Error('Invalid delivery binding')
      this.retire(args.agentId, now)
      const endpoint = this.db.prepare(`INSERT INTO local_delivery_endpoints (agent_id, generation)
        VALUES (?, 1) ON CONFLICT(agent_id) DO UPDATE SET generation = generation + 1
        RETURNING generation`).get(args.agentId) as { generation: number }
      const token = randomBytes(32).toString('base64url')
      const expiresAt = now + duration
      this.db.prepare(`INSERT INTO local_delivery_leases
        (agent_id, generation, session_key, token_hash, expires_at) VALUES (?, ?, ?, ?, ?)`)
        .run(args.agentId, endpoint.generation, args.sessionKey, hash(token), expiresAt)
      return { agentId: args.agentId, sessionKey: args.sessionKey, generation: endpoint.generation, expiresAt, token }
    })()
  }

  authenticate(token: string, now = Date.now()): LocalDeliveryLease | null {
    time(now)
    if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(token)) return null
    const row = this.db.prepare('SELECT agent_id FROM local_delivery_leases WHERE token_hash = ?')
      .get(hash(token)) as { agent_id: string } | undefined
    if (!row) return null
    const lease = this.current(row.agent_id, now)
    if (!lease) return null
    const match = this.db.prepare(`SELECT 1 FROM local_delivery_leases
      WHERE agent_id = ? AND generation = ? AND token_hash = ?`)
      .get(lease.agentId, lease.generation, hash(token))
    return match ? lease : null
  }

  renew(token: string, args: { now?: number; ttlMs?: number } = {}): LocalDeliveryLease | null {
    const now = time(args.now)
    const duration = ttl(args.ttlMs)
    return this.db.transaction(() => {
      const lease = this.authenticate(token, now)
      if (!lease) return null
      const expiresAt = Math.max(lease.expiresAt, now + duration)
      this.db.prepare('UPDATE local_delivery_leases SET expires_at = ? WHERE agent_id = ? AND generation = ?')
        .run(expiresAt, lease.agentId, lease.generation)
      return { ...lease, expiresAt }
    })()
  }

  private retire(agentId: string, now: number): void {
    // Held is intentionally excluded: reconnect cannot bypass host approval.
    this.db.prepare(`INSERT OR IGNORE INTO local_delivery_facts (attempt_id, stage, observed_at)
      SELECT attempt_id, 'unknown', ? FROM local_delivery_outbox
      WHERE agent_id = ? AND status IN ('claimed', 'transport-written')`).run(now, agentId)
    this.db.prepare(`UPDATE local_delivery_attempts SET status = 'unknown', updated_at = ?
      WHERE attempt_id IN (SELECT attempt_id FROM local_delivery_outbox
        WHERE agent_id = ? AND status IN ('claimed', 'transport-written'))`).run(now, agentId)
    this.db.prepare(`UPDATE local_delivery_outbox SET status = 'unknown', updated_at = ?
      WHERE agent_id = ? AND status IN ('claimed', 'transport-written')`).run(now, agentId)
    this.db.prepare(`UPDATE local_delivery_leases SET revoked_at = ?
      WHERE agent_id = ? AND revoked_at IS NULL`).run(now, agentId)
  }

  revokeAgent(agentId: string, now = Date.now()): void {
    time(now)
    this.db.transaction(() => this.retire(agentId, now))()
  }

  /** Materialize expiry as unknown, without treating uncertainty as failure. */
  expireLeases(now = Date.now()): number {
    time(now)
    return this.db.transaction(() => {
      const rows = this.db.prepare(`SELECT DISTINCT l.agent_id FROM local_delivery_leases l
        LEFT JOIN agents a ON a.agent_id = l.agent_id
        WHERE l.revoked_at IS NULL AND (l.expires_at <= ? OR a.session_key IS NOT l.session_key OR a.offline_since IS NOT NULL)`)
        .all(now) as Array<{ agent_id: string }>
      for (const row of rows) this.retire(row.agent_id, now)
      return rows.length
    })()
  }

  enqueue(args: { messageId: string; agentId: string; eventId: number; now?: number }): LocalDeliveryRow {
    const now = time(args.now)
    if (!args.messageId || !args.agentId || !Number.isSafeInteger(args.eventId) || args.eventId < 1) {
      throw new Error('Invalid delivery intent')
    }
    return this.db.transaction(() => {
      const existing = this.db.prepare(`SELECT * FROM local_delivery_outbox WHERE message_id = ? AND agent_id = ?`)
        .get(args.messageId, args.agentId) as LocalDeliveryRow | undefined
      if (existing) {
        if (existing.event_id !== args.eventId) throw new Error('Conflicting delivery intent')
        return existing
      }
      const sequence = this.db.prepare(`INSERT INTO local_delivery_sequences (agent_id, seq) VALUES (?, 1)
        ON CONFLICT(agent_id) DO UPDATE SET seq = seq + 1 RETURNING seq`).get(args.agentId) as { seq: number }
      this.db.prepare(`INSERT INTO local_delivery_outbox
        (message_id, agent_id, event_id, seq, status, selected, created_at, updated_at)
        VALUES (?, ?, ?, ?, 'stored', ?, ?, ?)`)
        .run(args.messageId, args.agentId, args.eventId, sequence.seq, this.current(args.agentId, now) ? 1 : 0, now, now)
      return this.db.prepare('SELECT * FROM local_delivery_outbox WHERE message_id = ? AND agent_id = ?')
        .get(args.messageId, args.agentId) as LocalDeliveryRow
    })()
  }

  /** Ownership never falls back once selected, even after refusal or lease expiry. */
  ownsDelivery(messageId: string, agentId: string, _now?: number): boolean {
    return !!this.db.prepare(`SELECT 1 FROM local_delivery_outbox
      WHERE message_id = ? AND agent_id = ? AND selected = 1`).get(messageId, agentId)
  }

  listForMessage(messageId: string): LocalDeliveryRow[] {
    return this.db.prepare('SELECT * FROM local_delivery_outbox WHERE message_id = ? ORDER BY agent_id')
      .all(messageId) as LocalDeliveryRow[]
  }

  // Called only by the trusted inbox service when its implicit read advances
  // the durable mailbox cursor. A UI preview or explicit-since read is not
  // consumption. This reconciles uncertain notices without resubmitting them.
  consumeThrough(agentId: string, eventId: number, now = Date.now()): number {
    time(now)
    return this.db.transaction(() => {
      const rows = this.db.prepare(`SELECT attempt_id FROM local_delivery_outbox
        WHERE agent_id=? AND event_id<=? AND status NOT IN ('inbox-consumed','model-turn-started','replied')`)
        .all(agentId, eventId) as Array<{ attempt_id: string | null }>
      for (const row of rows) if (row.attempt_id) {
        this.db.prepare('INSERT OR IGNORE INTO local_delivery_facts(attempt_id,stage,observed_at) VALUES (?, ?, ?)')
          .run(row.attempt_id, 'inbox-consumed', now)
        this.db.prepare("UPDATE local_delivery_attempts SET status='inbox-consumed', updated_at=? WHERE attempt_id=?")
          .run(now, row.attempt_id)
      }
      return this.db.prepare(`UPDATE local_delivery_outbox SET status='inbox-consumed', updated_at=?
        WHERE agent_id=? AND event_id<=? AND status NOT IN ('inbox-consumed','model-turn-started','replied')`)
        .run(now, agentId, eventId).changes
    })()
  }

  claim(token: string, args: { now?: number; limit?: number } = {}): LocalDeliveryClaim[] {
    const now = time(args.now)
    if (args.limit !== undefined && (!Number.isSafeInteger(args.limit) || args.limit < 0)) throw new Error('Invalid claim limit')
    return this.db.transaction(() => {
      this.expireLeases(now)
      const lease = this.authenticate(token, now)
      if (!lease || args.limit === 0) return []
      const row = this.db.prepare(`SELECT * FROM local_delivery_outbox
        WHERE agent_id = ? AND selected = 1
          AND status IN ('stored', 'claimed', 'held', 'unknown')
        ORDER BY seq LIMIT 1`).get(lease.agentId) as LocalDeliveryRow | undefined
      // A lost wait response must be recoverable without minting a second
      // attempt. This replays only a stable, body-free hint for the same lease.
      if (row?.status === 'claimed' && row.generation === lease.generation && row.attempt_id) {
        return [row as LocalDeliveryClaim]
      }
      // transport-written acknowledges a hint handoff, not host admission. It
      // unblocks later hints without upgrading the observation to host-queued.
      if (!row || (row.status !== 'stored' && !(row.status === 'unknown' && row.generation !== lease.generation))) return []
      const attemptId = randomUUID()
      this.db.prepare(`INSERT INTO local_delivery_attempts
        (attempt_id, message_id, agent_id, generation, status, created_at, updated_at)
        VALUES (?, ?, ?, ?, 'claimed', ?, ?)`).run(attemptId, row.message_id, lease.agentId, lease.generation, now, now)
      this.db.prepare(`INSERT INTO local_delivery_facts (attempt_id, stage, observed_at) VALUES (?, 'claimed', ?)`)
        .run(attemptId, now)
      this.db.prepare(`UPDATE local_delivery_outbox SET attempt_id = ?, generation = ?, status = 'claimed', updated_at = ?
        WHERE message_id = ? AND agent_id = ?`).run(attemptId, lease.generation, now, row.message_id, lease.agentId)
      return [{ ...row, attempt_id: attemptId, generation: lease.generation, status: 'claimed', updated_at: now }]
    })()
  }

  acknowledge(token: string, args: { attemptId: string; stage: DeliveryStage; now?: number }): boolean {
    const now = time(args.now)
    if (!stages.has(args.stage) || args.stage === 'stored' || args.stage === 'claimed') return false
    return this.db.transaction(() => {
      this.expireLeases(now)
      const lease = this.authenticate(token, now)
      if (!lease) return false
      const row = this.db.prepare(`SELECT * FROM local_delivery_outbox
        WHERE attempt_id = ? AND agent_id = ? AND generation = ?`)
        .get(args.attemptId, lease.agentId, lease.generation) as LocalDeliveryRow | undefined
      if (!row) return false
      // Facts are additive, but stale lower-stage observations cannot reopen a
      // completed request. Terminal host outcomes cannot be bypassed by an ACK.
      const previous = this.db.prepare('SELECT 1 FROM local_delivery_facts WHERE attempt_id = ? AND stage = ?')
        .get(args.attemptId, args.stage)
      if (previous) return true
      if (['refused', 'expired', 'failed'].includes(row.status)) return false
      if (row.status === 'unknown' && !completionRank[args.stage]) return false
      if (completionRank[row.status] && !completionRank[args.stage]) return true
      this.db.prepare('INSERT INTO local_delivery_facts (attempt_id, stage, observed_at) VALUES (?, ?, ?)')
        .run(args.attemptId, args.stage, now)
      const next = row.status === 'held' && args.stage === 'transport-written' ? 'held'
        : (completionRank[row.status] ?? 0) > (completionRank[args.stage] ?? 0) ? row.status : args.stage
      this.db.prepare('UPDATE local_delivery_attempts SET status = ?, updated_at = ? WHERE attempt_id = ?')
        .run(next, now, args.attemptId)
      this.db.prepare('UPDATE local_delivery_outbox SET status = ?, updated_at = ? WHERE attempt_id = ?')
        .run(next, now, args.attemptId)
      return true
    })()
  }
}
