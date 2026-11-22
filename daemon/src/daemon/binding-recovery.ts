// A daemon restart drops every in-memory MCP session binding. These helpers keep
// the recovery rule in one testable place: rebind only when exactly one identity
// lost its binding, and never guess between several.
export interface LostBinding {
  agent_id: string
  team: string
}

export function selectRebindCandidate(lost: readonly LostBinding[]): LostBinding | null {
  if (!Array.isArray(lost) || lost.length !== 1) return null
  const candidate = lost[0]
  if (!candidate || typeof candidate.agent_id !== 'string' || !candidate.agent_id ||
      typeof candidate.team !== 'string' || !candidate.team) return null
  return { agent_id: candidate.agent_id, team: candidate.team }
}
