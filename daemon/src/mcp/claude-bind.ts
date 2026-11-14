import type Database from 'better-sqlite3'
import { createHash, randomBytes } from 'node:crypto'

// The hook owns the raw capability in a 0600 session file. SQLite holds only its
// hash. A capability selects one exact local Claude agent/session_key; never a
// name, PID, recently seen row, or another agent on the same host.
export class ClaudeBindCapabilities {
  private readonly active = new Map<string, string>() // agent_id -> MCP session id

  constructor(private readonly db: Database.Database, private readonly localDevice: string) {}

  // Codes are short enough for a model to copy verbatim, so they avoid the
  // characters people misread: no 0/O and no 1/I/L.
  private static readonly CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'
  static readonly CODE_TTL_MS = 15 * 60_000

  private static hash(raw: string): string {
    return createHash('sha256').update(raw).digest('hex')
  }

  static normalizeCode(raw: unknown): string | undefined {
    if (typeof raw !== 'string') return undefined
    const clean = raw.toUpperCase().replace(/[^A-Z0-9]/g, '')
    return /^[A-Z0-9]{8}$/.test(clean) ? clean : undefined
  }

  private static makeCode(): string {
    const bytes = randomBytes(8)
    const alphabet = ClaudeBindCapabilities.CODE_ALPHABET
    let out = ''
    // Modulo the real length. A stale 32 here silently indexed past the end,
    // appended the string "undefined", and produced codes that failed
    // normalization about a fifth of the time.
    for (const b of bytes) out += alphabet[b % alphabet.length]
    return `${out.slice(0, 4)}-${out.slice(4)}`
  }

  issue(agentId: string, sessionKey: string): { token: string; code: string } {
    const row = this.db.prepare(
      `SELECT agent_id FROM agents
       WHERE agent_id=? AND device=? AND agent_type='claude-code'
         AND session_key=? AND offline_since IS NULL`
    ).get(agentId, this.localDevice, sessionKey) as { agent_id: string } | undefined
    if (!row) throw new Error('claude_bind_identity_mismatch')
    const token = randomBytes(32).toString('hex')
    const hash = ClaudeBindCapabilities.hash(token)
    const code = ClaudeBindCapabilities.makeCode()
    const normalizedCode = ClaudeBindCapabilities.normalizeCode(code)
    if (!normalizedCode) throw new Error('bind_code_generation_failed')
    const codeHash = ClaudeBindCapabilities.hash(normalizedCode)
    const expires = new Date(Date.now() + ClaudeBindCapabilities.CODE_TTL_MS).toISOString()
    this.db.transaction(() => {
      this.db.prepare('DELETE FROM claude_bind_capabilities WHERE agent_id=?').run(agentId)
      this.db.prepare(
        `INSERT INTO claude_bind_capabilities(token_hash, agent_id, session_key, issued_at, code_hash, code_expires_at)
         VALUES (?, ?, ?, ?, ?, ?)`
      ).run(hash, agentId, sessionKey, new Date().toISOString(), codeHash, expires)
    })()
    // A fresh SessionStart/resume supersedes an obsolete MCP transport. It can
    // no longer act as this identity because its capability was replaced.
    this.active.delete(agentId)
    return { token, code }
  }

  // Bind by the short code the model can see and pass as a normal argument.
  // Single use: the code is cleared as soon as it binds.
  bindCode(raw: unknown, sessionId: string): { agentId: string; team: string } | undefined {
    const code = ClaudeBindCapabilities.normalizeCode(raw)
    if (!code) return undefined
    const hash = ClaudeBindCapabilities.hash(code)
    const row = this.db.prepare(
      `SELECT cap.agent_id AS agentId, a.team, a.last_seen_at AS lastSeenAt,
              a.offline_since AS offlineSince, cap.code_expires_at AS codeExpiresAt
       FROM claude_bind_capabilities cap JOIN agents a ON a.agent_id=cap.agent_id
       WHERE cap.code_hash=? AND cap.session_key=a.session_key
         AND a.agent_type='claude-code' AND a.device=?`
    ).get(hash, this.localDevice) as {
      agentId: string; team: string; lastSeenAt: string; offlineSince: string | null; codeExpiresAt: string | null
    } | undefined
    if (!row || row.offlineSince !== null) return undefined
    if (!row.codeExpiresAt || Date.parse(row.codeExpiresAt) < Date.now()) return undefined
    if (Date.now() - Date.parse(row.lastSeenAt) > 180_000) return undefined
    const holder = this.active.get(row.agentId)
    if (holder && holder !== sessionId) return undefined
    this.db.prepare('UPDATE claude_bind_capabilities SET code_hash=NULL, code_expires_at=NULL WHERE agent_id=?').run(row.agentId)
    this.active.set(row.agentId, sessionId)
    return { agentId: row.agentId, team: row.team }
  }

  revoke(agentId: string): void {
    this.db.prepare('DELETE FROM claude_bind_capabilities WHERE agent_id=?').run(agentId)
    // A previously bound MCP session must not silently continue as this agent.
    this.active.delete(agentId)
  }

  bind(raw: unknown, sessionId: string, expectedAgentId?: string): { agentId: string; team: string } | undefined {
    if (typeof raw !== 'string' || !/^[0-9a-f]{64}$/.test(raw)) return undefined
    const hash = ClaudeBindCapabilities.hash(raw)
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
