import type Database from 'better-sqlite3'
import type { ChannelWakeFanout } from '../daemon/channel-wake-fanout.js'
import { AgentsRepo } from '../storage/agents-repo.js'
import { CHANNEL_PROXY_ROLE } from './subscribe-channel-wake.js'

export interface BindInput {
  callerAgentId: string
  channel_session_id: string
}

export type BindResult =
  | { ok: true }
  | { error: 'unknown_agent' | 'forbidden_role' | 'invalid_channel_session_id' | 'unknown_channel_session' }

export class BindChannelService {
  private readonly repo: AgentsRepo

  constructor(
    db: Database.Database,
    private readonly fanout: ChannelWakeFanout
  ) {
    this.repo = new AgentsRepo(db)
  }

  bind(input: BindInput): BindResult {
    const csid = input.channel_session_id?.trim()
    if (!csid) return { error: 'invalid_channel_session_id' }
    const caller = this.repo.getById(input.callerAgentId)
    if (!caller) return { error: 'unknown_agent' }
    if (caller.role === CHANNEL_PROXY_ROLE) return { error: 'forbidden_role' }
    if (!this.fanout.has(csid)) return { error: 'unknown_channel_session' }
    this.repo.setAgentType(input.callerAgentId, 'claude-code')
    this.repo.setDelivery(input.callerAgentId, {
      kind: 'claude-channel',
      channel_session_id: csid,
    })
    return { ok: true }
  }
}
