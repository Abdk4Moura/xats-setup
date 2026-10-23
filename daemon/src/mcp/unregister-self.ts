import type Database from 'better-sqlite3'
import type { AgentsRepo } from '../storage/agents-repo.js'

export type UnregisterSelfResult =
  | { ok: true; team: string; name: string; agent_id: string }
  | { error: 'unknown_agent' }

export class UnregisterSelfService {
  constructor(
    private readonly db: Database.Database,
    private readonly agents: AgentsRepo
  ) {}

  unregister(args: { caller: string }): UnregisterSelfResult {
    const caller = this.agents.findById(args.caller)
    if (!caller) return { error: 'unknown_agent' }

    let removed = false
    const tx = this.db.transaction(() => {
      removed = this.agents.deleteById(caller.agent_id)
    })
    tx()

    if (!removed) return { error: 'unknown_agent' }
    return {
      ok: true,
      team: caller.team,
      name: caller.name,
      agent_id: caller.agent_id,
    }
  }
}
