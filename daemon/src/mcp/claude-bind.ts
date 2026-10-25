import type Database from 'better-sqlite3'
import { createHash, randomBytes } from 'node:crypto'

// The hook owns the raw capability in a 0600 session file. SQLite holds only its
// hash. A capability selects one exact local Claude agent/session_key; never a
// name, PID, recently seen row, or another agent on the same host.
export class ClaudeBindCapabilities {
  private readonly active = new Map<string, string>() // agent_id -> MCP session id

  constructor(private readonly db: Database.Database, private readonly localDevice: string) {}

  issue(agentId: string, sessionKey: string): string {
    const row = this.db.prepare(
      `SELECT agent_id FROM agents
       WHERE agent_id=? AND device=? AND agent_type='claude-code'
         AND session_key=? AND offline_since IS NULL`
    ).get(agentId, this.localDevice, sessionKey) as { agent_id: string } | undefined
    if (!row) throw new Error('claude_bind_identity_mismatch')
    const token = randomBytes(32).toString('hex')
    const hash = createHash('sha256').update(token).digest('hex')
    this.db.transaction(() => {
      this.db.prepare('DELETE FROM claude_bind_capabilities WHERE agent_id=?').run(agentId)
      this.db.prepare(
        `INSERT INTO claude_bind_capabilities(token_hash, agent_id, session_key, issued_at)
         VALUES (?, ?, ?, ?)`
      ).run(hash, agentId, sessionKey, new Date().toISOString())
    })()
    // A fresh SessionStart/resume supersedes an obsolete MCP transport. It can
    // no longer act as this identity because its capability was replaced.
    this.active.delete(agentId)
    return token
  }

  revoke(agentId: string): void {
    this.db.prepare('DELETE FROM claude_bind_capabilities WHERE agent_id=?').run(agentId)
    // A previously bound MCP session must not silently continue as this agent.
    this.active.delete(agentId)
  }

  bind(raw: unknown, sessionId: string, expectedAgentId?: string): { agentId: string; team: string } | undefined {
    if (typeof raw !== 'string' || !/^[0-9a-f]{64}$/.test(raw)) return undefined
    const hash = createHash('sha256').update(raw).digest('hex')
    const row = this.db.prepare(
      `SELECT a.agent_id AS agentId, a.team, a.last_seen_at AS lastSeenAt,
              a.offline_since AS offlineSince
       FROM claude_bind_capabilities cap JOIN agents a ON a.agent_id=cap.agent_id
       WHERE cap.token_hash=? AND cap.session_key=a.session_key
         AND a.agent_type='claude-code' AND a.device=?`
    ).get(hash, this.localDevice) as {
      agentId: string; team: string; lastSeenAt: string; offlineSince: string | null
    } | undefined
    if (!row || (expectedAgentId && row.agentId !== expectedAgentId) ||
        row.offlineSince !== null || Date.now() - Date.parse(row.lastSeenAt) > 180_000) return undefined
    const holder = this.active.get(row.agentId)
    if (holder && holder !== sessionId) return undefined
    this.active.set(row.agentId, sessionId)
    return { agentId: row.agentId, team: row.team }
  }

  owns(agentId: string, sessionId: string): boolean {
    if (this.active.get(agentId) !== sessionId) return false
    const row = this.db.prepare(
      `SELECT a.last_seen_at AS lastSeenAt, a.offline_since AS offlineSince
       FROM claude_bind_capabilities cap JOIN agents a ON a.agent_id=cap.agent_id
       WHERE cap.agent_id=? AND a.device=? AND a.agent_type='claude-code'
         AND cap.session_key=a.session_key`
    ).get(agentId, this.localDevice) as { lastSeenAt: string; offlineSince: string | null } | undefined
    return Boolean(row && row.offlineSince === null && Date.now() - Date.parse(row.lastSeenAt) <= 180_000)
  }

  release(agentId: string, sessionId: string): void {
    if (this.active.get(agentId) === sessionId) this.active.delete(agentId)
  }
}
