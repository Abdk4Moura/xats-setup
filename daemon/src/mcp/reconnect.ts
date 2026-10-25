import type { AgentsRepo, RuntimeUiPidMatch } from '../storage/agents-repo.js'

export interface ReconnectCandidate {
  agent_id: string
  device: string
  team: string
  name: string
  role: string
  last_seen_at: string
}

export type ReconnectResolution =
  | { kind: 'need_register'; reason: string }
  | { kind: 'single'; match: ReconnectCandidate }
  | { kind: 'ambiguous'; candidates: ReconnectCandidate[] }

function toCandidate(row: RuntimeUiPidMatch): ReconnectCandidate {
  return {
    agent_id: row.agent_id,
    device: row.device,
    team: row.team,
    name: row.name,
    role: row.role,
    last_seen_at: row.last_seen_at,
  }
}

/**
 * Reverse-look-up a prior local claude-code identity by its `runtime_ui_pid`
 * (the Claude UI process id / `$PPID`) and decide how `reconnect` should branch:
 * 0 matches → `need_register`, 1 match → reuse, N matches → `ambiguous`.
 *
 * This function only reads; it never mutates a row. The single-match register /
 * takeover / auto-bind side effects are driven by the caller using the recovered
 * `(device, team, name)`.
 */
export function resolveReconnect(
  repo: AgentsRepo,
  ui_pid: number,
  localDevice: string
): ReconnectResolution {
  const rows = repo.findByRuntimeUiPid(ui_pid, localDevice)
  if (rows.length === 0) {
    return {
      kind: 'need_register',
      reason:
        `No local agent is registered for ui_pid ${ui_pid}. ` +
        'There is no prior identity to reconnect; call register_agent to register a new identity.',
    }
  }
  if (rows.length === 1) {
    return { kind: 'single', match: toCandidate(rows[0]) }
  }
  return { kind: 'ambiguous', candidates: rows.map(toCandidate) }
}
