import type Database from 'better-sqlite3'
import { fanoutAutoPoke, type AutoPokeRecipient, type AutoPokeSkipReason, type FanoutDeps } from './auto-poke-fanout.js'
import { RETRY_DELAYS_S } from './poke-retry.js'
import { recordInitialDeliveryStatuses, updateDeliveryStatus } from './delivery-status.js'
import { LocalDeliveryStore } from '../storage/local-delivery.js'

export interface FanoutResultEnvelope {
  poked: boolean
  poke_skip_reasons?: Array<{ agent_id: string; reason: AutoPokeSkipReason }>
  retry_scheduled: boolean
  retry_delays_s?: number[]
}

// Shared fan-out + retry wiring used by both BroadcastService (all-team) and BroadcastToRoleService (same-team role-scoped).
// Same recipient-lookup SQL (agent_id-only, team-agnostic) keeps cross-team retry behaviour consistent.
export async function runFanoutWithRetry(args: {
  db: Database.Database
  team: string
  fromAgentId: string
  recipients: AutoPokeRecipient[]
  body: string
  deps: FanoutDeps
  messageId: string
  sentAt: string
}): Promise<FanoutResultEnvelope> {
  const { db } = args
  const store = new LocalDeliveryStore(db)
  const localRecipients = args.recipients.filter(r => store.ownsDelivery(args.messageId, r.agent_id))
  const localIds = new Set(localRecipients.map(r => r.agent_id))
  const fanout = await fanoutAutoPoke({
    team: args.team,
    fromAgentId: args.fromAgentId,
    // A claimed local owner must never also get a terminal/API legacy poke.
    recipients: args.recipients.filter(r => !localIds.has(r.agent_id)),
    body: args.body,
    deps: args.deps,
    retry: {
      messageId: args.messageId,
      sentAt: args.sentAt,
      lookupAgentFn: (agentId: string) => db.prepare(
        'SELECT agent_id, tmux_pane_id, last_seen_at FROM agents WHERE agent_id=?'
      ).get(agentId) as { agent_id: string; tmux_pane_id: string | null; last_seen_at: string } | undefined,
      updateStatusFn: (status) => {
        updateDeliveryStatus(db, args.messageId, status.agentId, status)
      }
    }
  })
  recordInitialDeliveryStatuses(db, {
    messageId: args.messageId,
    recipients: args.recipients.map(r => r.agent_id),
    delivered: new Set(fanout.deliveredAgentIds),
    skipped: [...fanout.skipReasons, ...localRecipients.map(r => ({ agent_id: r.agent_id, reason: 'local_adapter' as const }))]
  })
  const retry_scheduled = fanout.retryScheduledCount > 0
  return {
    poked: fanout.poked,
    poke_skip_reasons: [...fanout.skipReasons, ...localRecipients.map(r => ({ agent_id: r.agent_id, reason: 'local_adapter' as const }))],
    retry_scheduled,
    ...(retry_scheduled ? { retry_delays_s: [...RETRY_DELAYS_S] } : {})
  }
}
