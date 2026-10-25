import type Database from 'better-sqlite3'

export interface CleanupOpts {
  maxAgeDays?: number
  now?: Date
}

// Uniform 30-day hard TTL for mailbox-derived tables. The deletion runs as a
// single SQLite transaction in child→parent order so foreign-key references
// (PRAGMA foreign_keys=ON) never become dangling mid-transaction. Cursor
// position is intentionally NOT consulted — agents that have been offline for
// more than 30 days forfeit any unread mail, which is the explicit retention
// contract.
export function runCleanup(db: Database.Database, opts: CleanupOpts = {}): { deleted: number } {
  const now = opts.now ?? new Date()
  const maxAgeDays = opts.maxAgeDays ?? 30
  const ageCutoff = new Date(now.getTime() - maxAgeDays * 86400 * 1000).toISOString()

  const deleteStatus = db.prepare(
    `DELETE FROM message_delivery_status
      WHERE message_id IN (SELECT id FROM messages WHERE sent_at < ?)`
  )
  const deleteMessages = db.prepare(`DELETE FROM messages WHERE sent_at < ?`)
  const deleteEvents = db.prepare(`DELETE FROM events WHERE created_at < ?`)
  // Hard-purge only keyed Claude sessions after 30 days explicitly offline.
  // Delete capabilities first even if a caller opened SQLite without FK enforcement.
  const expiredClaude = `agent_type = 'claude-code' AND session_key IS NOT NULL
    AND offline_since IS NOT NULL AND offline_since < ?`
  const deleteClaudeCapabilities = db.prepare(
    `DELETE FROM claude_bind_capabilities
     WHERE agent_id IN (SELECT agent_id FROM agents WHERE ${expiredClaude})`
  )
  const deleteOfflineClaude = db.prepare(`DELETE FROM agents WHERE ${expiredClaude}`)
  // Channel-proxy GC (design D3 / D4): prune stale `__channel_proxy__` rows
  // whose channel_session_id is no longer referenced by any non-proxy host's
  // delivery_payload. Live-bound proxies survive even past the cutoff.
  const deleteStaleProxies = db.prepare(
    `DELETE FROM agents
      WHERE role = '__channel_proxy__'
        AND last_seen_at < ?
        AND (agent_type IS NOT 'claude-code' OR session_key IS NULL)
        AND NOT EXISTS (
          SELECT 1 FROM agents host
          WHERE host.delivery_kind = 'claude-channel'
            AND host.role <> '__channel_proxy__'
            AND json_extract(host.delivery_payload, '$.channel_session_id')
                = json_extract(agents.delivery_payload, '$.channel_session_id')
        )`
  )

  const tx = db.transaction(() => {
    const s = deleteStatus.run(ageCutoff)
    const m = deleteMessages.run(ageCutoff)
    const e = deleteEvents.run(ageCutoff)
    deleteClaudeCapabilities.run(ageCutoff)
    const c = deleteOfflineClaude.run(ageCutoff)
    const p = deleteStaleProxies.run(ageCutoff)
    return Number(s.changes) + Number(m.changes) + Number(e.changes) + Number(c.changes) + Number(p.changes)
  })
  return { deleted: tx() }
}
