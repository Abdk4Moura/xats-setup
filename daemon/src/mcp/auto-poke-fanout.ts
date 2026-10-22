import { runQuietGuard } from './poke-guard.js'
import { isTmuxAvailable } from '../daemon/tmux-cli.js'
import { scheduleRetry as defaultScheduleRetry, type RetryAgentLookup, type RetryContext } from './poke-retry.js'
import type { DeliverySpec } from '../lib/delivery-spec.js'

export type AutoPokeSkipReason = 'no_pane' | 'guard_failed' | 'tmux_unavailable' | 'self'

export interface AutoPokeArgs {
  team: string
  fromAgentId: string
  targetAgentId: string
  paneId: string | null
  body: string
  skipGuard?: boolean
}

export type AutoPokeFn = (args: AutoPokeArgs) => Promise<{ ok: true } | { ok: false; reason?: AutoPokeSkipReason }>

export interface AutoPokeRecipient {
  agent_id: string
  tmux_pane_id: string | null
  delivery?: DeliverySpec
}

export interface FanoutDeps {
  poke?: AutoPokeFn
  tmuxAvailable?: () => Promise<boolean>
}

export interface RetryScheduleCtx {
  messageId: string
  sentAt: string
  lookupAgentFn: (agentId: string) => RetryAgentLookup | undefined
  scheduleRetryFn?: (ctx: RetryContext) => void
  updateStatusFn?: RetryContext['updateStatusFn']
}

export interface FanoutResult {
  poked: boolean
  skipReasons: Array<{ agent_id: string; reason: AutoPokeSkipReason }>
  deliveredAgentIds: string[]
  retryScheduledCount: number
}

function hasNonTmuxTransport(recipient: AutoPokeRecipient): boolean {
  return recipient.delivery !== undefined && recipient.delivery.kind !== 'none'
}

// Recipients are supplied by the caller; no team filter is applied here, so cross-team fan-out works transparently.
export async function fanoutAutoPoke(args: {
  team: string
  fromAgentId: string
  recipients: AutoPokeRecipient[]
  body: string
  deps: FanoutDeps
  retry?: RetryScheduleCtx
}): Promise<FanoutResult> {
  const pokeFn = args.deps.poke
  const tmuxAvail = args.deps.tmuxAvailable ?? isTmuxAvailable

  const results = await Promise.all(args.recipients.map(async (r) => {
    try {
      const nonTmuxTransport = hasNonTmuxTransport(r)
      if (r.agent_id === args.fromAgentId) {
        return { agent_id: r.agent_id, poked: false, reason: 'self' as AutoPokeSkipReason, paneId: null as string | null }
      }
      if (!nonTmuxTransport && !r.tmux_pane_id) {
        return { agent_id: r.agent_id, poked: false, reason: 'no_pane' as AutoPokeSkipReason, paneId: null }
      }
      if (!nonTmuxTransport && !(await tmuxAvail())) {
        return { agent_id: r.agent_id, poked: false, reason: 'tmux_unavailable' as AutoPokeSkipReason, paneId: r.tmux_pane_id }
      }
      if (!pokeFn) {
        return { agent_id: r.agent_id, poked: false, reason: 'tmux_unavailable' as AutoPokeSkipReason, paneId: r.tmux_pane_id }
      }
      const out = await pokeFn({
        team: args.team,
        fromAgentId: args.fromAgentId,
        targetAgentId: r.agent_id,
        paneId: r.tmux_pane_id,
        body: args.body
      })
      if (out.ok) return { agent_id: r.agent_id, poked: true, reason: undefined, paneId: r.tmux_pane_id }
      return {
        agent_id: r.agent_id,
        poked: false,
        reason: (out.reason ?? 'guard_failed') as AutoPokeSkipReason,
        paneId: r.tmux_pane_id
      }
    } catch {
      return { agent_id: r.agent_id, poked: false, reason: 'guard_failed' as AutoPokeSkipReason, paneId: r.tmux_pane_id }
    }
  }))

  let retryScheduledCount = 0
  if (args.retry && pokeFn) {
    const scheduleFn = args.retry.scheduleRetryFn ?? defaultScheduleRetry
    for (const res of results) {
      if (!res.poked && res.reason === 'guard_failed' && res.paneId) {
        scheduleFn({
          agentId: res.agent_id,
          messageId: args.retry.messageId,
          fromAgentId: args.fromAgentId,
          body: args.body,
          team: args.team,
          sentAt: args.retry.sentAt,
          paneId: res.paneId,
          paneGuardFn: runQuietGuard,
          pokeFn: async (pokeArgs) => { await pokeFn({ ...pokeArgs, skipGuard: true }) },
          lookupAgentFn: args.retry.lookupAgentFn,
          updateStatusFn: args.retry.updateStatusFn
        })
        retryScheduledCount += 1
      }
    }
  }

  const poked = results.some(x => x.poked)
  const skipReasons = results
    .filter(x => !x.poked && x.reason !== undefined)
    .map(x => ({ agent_id: x.agent_id, reason: x.reason as AutoPokeSkipReason }))
  const deliveredAgentIds = results.filter(x => x.poked).map(x => x.agent_id)
  return { poked, skipReasons, deliveredAgentIds, retryScheduledCount }
}
