import type Database from 'better-sqlite3'
import { AgentsRepo, REACHABLE_MS_DEFAULT } from '../storage/agents-repo.js'
import { toPublicAgentRow, type PublicAgentListRow } from './agent-public-row.js'
import { assignAgentRefs } from '../storage/agent-ref.js'

// Shared team-scoped agent listing used by BOTH the list_agents MCP tool and the
// GET /api/agents REST route. Kept as a single helper so the two stay in lockstep
// and produce identical output (public rows + uniform TTL-based online flag).
export function listAgentsForTeam(
  db: Database.Database,
  team: string,
  ttlMs?: number,
): { agents: PublicAgentListRow[] } {
  const agents = new AgentsRepo(db)
  const rows = agents.list({
    team,
    excludeRoles: ['__channel_proxy__'],
    ttlMs: ttlMs ?? REACHABLE_MS_DEFAULT,
  })
  // Refs are assigned per team roster, so they stay stable and collision-free
  // for every address the roster advertises.
  const refs = assignAgentRefs(rows.map((row) => row.agent_id))
  return {
    agents: rows.map((row) => toPublicAgentRow(row, refs.get(row.agent_id) ?? '')),
  }
}

/**
 * Every agent across every team on this daemon.
 *
 * Peer federation needs the whole roster, not one team: a peer advertises what
 * it has, and the local bus serves many teams. Added here (it is not in the
 * upstream package) because our federation layer depends on it.
 */
export function listAllAgents(
  db: Database.Database,
  ttlMs?: number,
): { agents: PublicAgentListRow[] } {
  const teams = db
    .prepare(`SELECT DISTINCT team FROM agents ORDER BY team`)
    .all() as Array<{ team: string }>
  return {
    agents: teams.flatMap((row) => listAgentsForTeam(db, row.team, ttlMs).agents),
  }
}
