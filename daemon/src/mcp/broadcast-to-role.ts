import type Database from 'better-sqlite3'
import { randomUUID } from 'node:crypto'
import { AgentsRepo, REACHABLE_MS_DEFAULT } from '../storage/agents-repo.js'
import type { EventsOutbox } from '../storage/events-outbox.js'
import type { FanoutDeps, AutoPokeSkipReason } from './auto-poke-fanout.js'
import { runFanoutWithRetry } from './fanout-with-retry.js'
import { parseDeliveryRow } from '../lib/delivery-spec.js'
import { recordInitialDeliveryStatuses } from './delivery-status.js'

export type BroadcastToRoleDeps = FanoutDeps

export interface BroadcastToRoleInput {
  from: string
  to_role: string
  body: string
  subject?: string
  auto_poke?: boolean
}

interface SuccessResult {
  message_id: string
  event_id: number
  recipients: string[]
  poked: boolean
  poke_skip_reasons?: Array<{ agent_id: string; reason: AutoPokeSkipReason }>
  retry_scheduled: boolean
  retry_delays_s?: number[]
}

export type BroadcastToRoleResult = SuccessResult | { error: 'unknown_recipient' }

export class BroadcastToRoleService {
  constructor(
    private db: Database.Database,
    private agents: AgentsRepo,
    private events: EventsOutbox,
    private deps: BroadcastToRoleDeps = {}
  ) {}

  async broadcast(input: BroadcastToRoleInput): Promise<BroadcastToRoleResult> {
    const fromRow = this.agents.findById(input.from)
    if (!fromRow) return { error: 'unknown_recipient' }
    const rawRows = this.db.prepare(
      `SELECT
         agent_id,
         tmux_pane_id,
         delivery_kind,
         delivery_payload,
         last_seen_at
       FROM agents
       WHERE team=? AND role=? AND agent_id != ?`
    ).all(fromRow.team, input.to_role, input.from) as Array<{
      agent_id: string
      tmux_pane_id: string | null
      delivery_kind: string
      delivery_payload: string | null
      last_seen_at: string
    }>

    // Reachability gate: skip unreachable recipients
    const ttlMs = REACHABLE_MS_DEFAULT
    const now = Date.now()
    const reachable: typeof rawRows = []
    const skipped: string[] = []
    for (const row of rawRows) {
      const ageMs = now - new Date(row.last_seen_at).getTime()
      if (Number.isFinite(ageMs) && ageMs <= ttlMs) {
        reachable.push(row)
      } else {
        skipped.push(row.agent_id)
      }
    }

    const rows = reachable.map((row) => ({
      agent_id: row.agent_id,
      tmux_pane_id: row.tmux_pane_id,
      delivery: parseDeliveryRow(row),
    }))
    if (rows.length === 0) return { error: 'unknown_recipient' }

    const recipients = rows.map(r => r.agent_id)
    const baseId = randomUUID()
    const inserted = this.insert(fromRow.team, input, recipients, baseId)

    // Wake file for claude-job recipients
    try {
      const fs = await import('node:fs/promises')
      for (const row of rows) {
        if (row.delivery.kind === 'claude-job' && row.delivery.job_dir) {
          const wakePath = `${row.delivery.job_dir}/.xats-wake`
          await fs.writeFile(wakePath, new Date().toISOString()).catch(() => {})
        }
      }
    } catch { /* best-effort */ }

    if (input.auto_poke === false) {
      recordInitialDeliveryStatuses(this.db, {
        messageId: inserted.message_id,
        recipients,
        delivered: new Set(),
        skipped: [],
        autoPokeDisabled: true,
      })
      return {
        message_id: inserted.message_id,
        event_id: inserted.event_id,
        recipients,
        poked: false,
        retry_scheduled: false
      }
    }

    const envelope = await runFanoutWithRetry({
      db: this.db,
      team: fromRow.team,
      fromAgentId: input.from,
      recipients: rows,
      body: input.body,
      deps: this.deps,
      messageId: inserted.message_id,
      sentAt: inserted.sent_at
    })
    return {
      message_id: inserted.message_id,
      event_id: inserted.event_id,
      recipients,
      skipped,
      ...envelope
    }
  }

  private insert(team: string, input: BroadcastToRoleInput, recipients: string[], baseId: string):
    { message_id: string; event_id: number; sent_at: string } {
    const tx = this.db.transaction(() => {
      const event_id = this.events.append({
        from_team: team,
        to_team: team,
        event_type: 'message_sent',
        actor_agent_id: input.from,
        payload: { to_role: input.to_role, recipients, subject: input.subject ?? null }
      })
      const sent_at = new Date().toISOString()
      const stmt = this.db.prepare(
        `INSERT INTO messages (id, event_id, from_team, to_team, from_agent_id, to_agent_id, to_role, subject, body, need_reply, sent_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?)`
      )
      for (let i = 0; i < recipients.length; i++) {
        const id = i === 0 ? baseId : `${baseId}-${i}`
        stmt.run(id, event_id, team, team, input.from, recipients[i], input.to_role, input.subject ?? null, input.body, 0, sent_at)
      }
      return { message_id: baseId, event_id, sent_at }
    })
    return tx()
  }
}
