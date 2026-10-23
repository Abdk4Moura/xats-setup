import type Database from 'better-sqlite3'

export interface CodexPanePreRegRow {
  pane_id: string
  xats_agent_id: string
  expires_at: string
}

export interface UpsertInput {
  pane_id: string
  xats_agent_id: string
  expires_at: string
}

export class CodexPanePreRegRepo {
  constructor(private readonly db: Database.Database) {}

  upsert(input: UpsertInput): void {
    this.db
      .prepare(
        `INSERT INTO codex_pane_pre_registrations (pane_id, xats_agent_id, expires_at)
         VALUES (?, ?, ?)
         ON CONFLICT(pane_id) DO UPDATE SET
           xats_agent_id = excluded.xats_agent_id,
           expires_at = excluded.expires_at`
      )
      .run(input.pane_id, input.xats_agent_id, input.expires_at)
  }

  listUnexpired(now: string): CodexPanePreRegRow[] {
    return this.db
      .prepare(
        `SELECT pane_id, xats_agent_id, expires_at
         FROM codex_pane_pre_registrations
         WHERE expires_at > ?`
      )
      .all(now) as CodexPanePreRegRow[]
  }

  takeByPaneId(pane_id: string): CodexPanePreRegRow | undefined {
    const row = this.db
      .prepare(
        `DELETE FROM codex_pane_pre_registrations
         WHERE pane_id = ?
         RETURNING pane_id, xats_agent_id, expires_at`
      )
      .get(pane_id) as CodexPanePreRegRow | undefined
    return row
  }

  deleteExpired(now: string): number {
    const res = this.db
      .prepare(`DELETE FROM codex_pane_pre_registrations WHERE expires_at <= ?`)
      .run(now)
    return res.changes
  }
}
