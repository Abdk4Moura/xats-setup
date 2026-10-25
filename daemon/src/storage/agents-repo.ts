import type Database from 'better-sqlite3'
import { randomUUID } from 'node:crypto'
import {
  parseDeliveryRow,
  serializeDelivery,
  type DeliverySpec,
  type DeliveryRow,
} from '../lib/delivery-spec.js'
import type { AgentType } from '../lib/agent-type.js'

export interface RegisterInput {
  agent_type?: AgentType
  agent_type_name?: string
  device?: string
  model?: string
  name: string
  role?: string
  team?: string
  tmux_pane_id?: string
  session_key?: string
  name_mode?: 'prefer' | 'exact'
  delivery?: DeliverySpec
  claude_ui_pid?: number
  runtime_ui_pid?: number
  remote_addr?: string | null
}

export interface AgentRow {
  agent_id: string
  agent_type: AgentType | null
  agent_type_name: string | null
  device: string
  team: string
  role: string
  name: string
  model: string | null
  // The client's session id, so a client that knows only its own session can
  // find its agent (Claude mod, OpenCode badge).
  session_key: string | null
  tmux_pane_id: string | null
  runtime_ui_pid: number | null
  delivery: DeliverySpec
  channel_session_id: string | null
  last_seen_at: string
}

export interface AgentListRow extends AgentRow {
  online: boolean
}

export interface RuntimeUiPidMatch {
  agent_id: string
  device: string
  team: string
  name: string
  role: string
  last_seen_at: string
}

export const REACHABLE_MS_DEFAULT = 180_000 // 3 minutes, uniform across all delivery kinds

type DbAgentRow = {
  agent_id: string
  agent_type: AgentType | null
  agent_type_name: string | null
  device: string
  team: string
  role: string
  name: string
  model: string | null
  // The client's session id, so a client that knows only its own session can
  // find its agent (Claude mod, OpenCode badge).
  session_key: string | null
  tmux_pane_id: string | null
  runtime_ui_pid: number | null
  last_seen_at: string
  offline_since: string | null
} & DeliveryRow

export function isAgentLive(
  agent: Pick<AgentRow, 'device' | 'last_seen_at'>,
  args: { ttlMs: number }
): boolean {
  // UNIFORM TTL-based: online = (now - last_seen_at) < TTL, same for ALL delivery kinds
  const lastSeenMs = new Date(agent.last_seen_at).getTime()
  if (!Number.isFinite(lastSeenMs)) return false
  return Date.now() - lastSeenMs <= args.ttlMs
}

function toAgentRow(row: DbAgentRow): AgentRow {
  const delivery = parseDeliveryRow(row)
  return {
    agent_id: row.agent_id,
    agent_type: row.agent_type,
    agent_type_name: row.agent_type_name,
    device: row.device,
    team: row.team,
    role: row.role,
    name: row.name,
    model: row.model,
    session_key: row.session_key ?? null,
    tmux_pane_id: row.tmux_pane_id,
    runtime_ui_pid: row.runtime_ui_pid,
    delivery,
    channel_session_id:
      delivery.kind === 'claude-channel' ? delivery.channel_session_id : null,
    last_seen_at: row.last_seen_at,
  }
}

export class AgentsRepo {
  constructor(private db: Database.Database) {
    // Bind hot read-paths so callers can destructure or extract method
    // references without losing `this` binding. (Tests in particular extract
    // `repo.list` to a local for type-cast purposes.)
    this.list = this.list.bind(this)
  }

  findByIdentity(args: { device: string; team: string; name: string }): { agent_id: string } | undefined {
    return this.db.prepare(
      `SELECT agent_id FROM agents WHERE device=? AND team=? AND name=?`
    ).get(args.device, args.team, args.name) as { agent_id: string } | undefined
  }

  findByRuntimeUiPid(ui_pid: number, localDevice: string): RuntimeUiPidMatch[] {
    return this.db.prepare(
      `SELECT agent_id, device, team, name, role, last_seen_at
       FROM agents
       WHERE device = ?
         AND role != '__channel_proxy__'
         AND runtime_ui_pid IS NOT NULL
         AND runtime_ui_pid = ?
       ORDER BY last_seen_at DESC`
    ).all(localDevice, ui_pid) as RuntimeUiPidMatch[]
  }

  register(input: RegisterInput): {
    agent_id: string
    team: string
    name: string
  } {
    const team = input.team ?? 'default'
    const device = input.device ?? 'local'
    const role = input.role ?? 'default'
    const requestedName = input.name
    const sessionKey = input.session_key ?? null
    const mode: 'prefer' | 'exact' = input.name_mode === 'exact' ? 'exact' : 'prefer'
    const ttlMs = REACHABLE_MS_DEFAULT
    let name = requestedName
    const now = new Date().toISOString()
    const newId = randomUUID()
    const delivery = input.delivery ?? { kind: 'none' }
    const serialized = serializeDelivery(delivery)
    const preserveExistingDelivery = input.delivery === undefined ? 1 : 0

    // Identity is the (device, team, name) unique index, so a colliding name is
    // the same agent. Distinguish only when the caller tells us its session; no
    // session_key keeps the legacy takeover semantics. An explicit `exact`
    // request always guards the name, even without a session_key.
    const findRow = (candidate: string) =>
      this.db
        .prepare(
          `SELECT agent_id, agent_type, session_key, name, last_seen_at FROM agents WHERE device=? AND team=? AND name=?`
        )
        .get(device, team, candidate) as
        | { agent_id: string; agent_type: AgentType | null; session_key: string | null; name: string; last_seen_at: string }
        | undefined

    let existing = findRow(requestedName)
    // Prefer mode with a known session: if this session already owns an identity,
    // keep it even when the computed default differs, so a claimed name survives
    // a resume without a client-side binding file.
    if (sessionKey !== null) {
      const owned = input.agent_type === 'claude-code'
        ? this.db.prepare(
            `SELECT name FROM agents WHERE device=? AND team=? AND session_key=? AND agent_type='claude-code'`
          ).get(device, team, sessionKey) as { name: string } | undefined
        : mode === 'prefer'
          ? this.db.prepare(`SELECT name FROM agents WHERE device=? AND team=? AND session_key=?`)
            .get(device, team, sessionKey) as { name: string } | undefined
          : undefined
      if (owned && owned.name !== requestedName) {
        name = owned.name
        existing = findRow(name)
      }
    }
    if (existing) {
      const sameSession = sessionKey !== null && existing.session_key === sessionKey &&
        (existing.agent_type !== 'claude-code' || input.agent_type === 'claude-code')
      const live = isAgentLive({ last_seen_at: existing.last_seen_at }, { ttlMs })
      // A retained Claude mailbox cannot be taken over when its name ages out.
      const retainedClaude = existing.agent_type === 'claude-code' && existing.session_key !== null
      const wantsDistinct = sessionKey !== null || mode === 'exact' || retainedClaude
      if (wantsDistinct && !sameSession && (live || retainedClaude)) {
        if (mode === 'exact') {
          const conflict = new Error('name_taken') as Error & { code?: string }
          conflict.code = 'name_taken'
          throw conflict
        }
        name = this.allocateName(device, team, requestedName, sessionKey, input.agent_type, ttlMs, findRow)
      }
    }

    const tx = this.db.transaction(() => {
      this.writeAgentRow({
        newId,
        input,
        team,
        device,
        role,
        name,
        now,
        serialized,
        preserveExistingDelivery,
      })
      const rebindCsid =
        role === '__channel_proxy__' &&
        input.claude_ui_pid !== undefined &&
        delivery.kind === 'claude-channel'
          ? delivery.channel_session_id
          : undefined
      if (rebindCsid !== undefined) {
        this.reactiveRebindHosts({
          proxy_device: device,
          team,
          claude_ui_pid: input.claude_ui_pid!,
          new_csid: rebindCsid,
        })
      }
    })
    tx()
    const row = this.db.prepare(
      `SELECT agent_id FROM agents WHERE device=? AND team=? AND name=?`
    ).get(device, team, name) as { agent_id: string }
    return { agent_id: row.agent_id, team, name }
  }

  /** First free `<base>-N` for a live collision; random suffix if all are taken. */
  private allocateName(
    device: string,
    team: string,
    base: string,
    sessionKey: string | null,
    agentType: AgentType | undefined,
    ttlMs: number,
    findRow: (candidate: string) => { agent_type: AgentType | null; session_key: string | null; last_seen_at: string } | undefined
  ): string {
    for (let i = 2; i <= 50; i += 1) {
      const candidate = `${base}-${i}`
      const row = findRow(candidate)
      if (!row) return candidate
      const sameSession = sessionKey !== null && row.session_key === sessionKey &&
        (row.agent_type !== 'claude-code' || agentType === 'claude-code')
      if (sameSession) return candidate
      if (row.agent_type === 'claude-code' && row.session_key !== null) continue
      if (!isAgentLive({ last_seen_at: row.last_seen_at }, { ttlMs })) return candidate
    }
    return `${base}-${randomUUID().slice(0, 8)}`
  }

  private writeAgentRow(args: {
    newId: string
    input: RegisterInput
    team: string
    device: string
    role: string
    name: string
    now: string
    serialized: ReturnType<typeof serializeDelivery>
    preserveExistingDelivery: number
  }): void {
    const { newId, input, team, device, role, name, now, serialized, preserveExistingDelivery } = args
    // Fresh INSERT initialises last_processed_event_id to MAX(event_id) so
    // newly registered agents do not see historical mail. The MAX read happens
    // inside the same SQLite transaction as the INSERT (writeAgentRow is always
    // called from `register`'s db.transaction). Reuse path preserves the
    // existing cursor — the ON CONFLICT branch deliberately does not touch
    // last_processed_event_id.
    this.db.prepare(
      `INSERT INTO agents (
         agent_id, agent_type, agent_type_name, device, team, role, name, model, session_key, registered_at, last_seen_at,
         tmux_pane_id, claude_ui_pid, runtime_ui_pid, delivery_kind, delivery_payload, remote_addr,
         last_processed_event_id
       )
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
               COALESCE((SELECT MAX(event_id) FROM events), 0))
       ON CONFLICT (device, team, name) DO UPDATE SET
         agent_type = excluded.agent_type,
         agent_type_name = excluded.agent_type_name,
         role = excluded.role,
         model = excluded.model,
         session_key = COALESCE(excluded.session_key, session_key),
         last_seen_at = excluded.last_seen_at,
         offline_since = CASE
           WHEN excluded.agent_type = 'claude-code' AND excluded.session_key IS NOT NULL THEN NULL
           ELSE offline_since
         END,
         tmux_pane_id = COALESCE(excluded.tmux_pane_id, tmux_pane_id),
         claude_ui_pid = COALESCE(excluded.claude_ui_pid, claude_ui_pid),
         runtime_ui_pid = COALESCE(excluded.runtime_ui_pid, runtime_ui_pid),
         remote_addr = excluded.remote_addr,
         delivery_kind = CASE
           WHEN ? THEN delivery_kind
           ELSE excluded.delivery_kind
         END,
         delivery_payload = CASE
           WHEN ? THEN delivery_payload
           ELSE excluded.delivery_payload
         END`
    ).run(
      newId,
      input.agent_type ?? null,
      input.agent_type_name ?? null,
      device,
      team,
      role,
      name,
      input.model ?? null,
      input.session_key ?? null,
      now,
      now,
      input.tmux_pane_id ?? null,
      input.claude_ui_pid ?? null,
      input.runtime_ui_pid ?? null,
      serialized.delivery_kind,
      serialized.delivery_payload,
      input.remote_addr ?? null,
      preserveExistingDelivery,
      preserveExistingDelivery,
    )
  }

  private reactiveRebindHosts(args: {
    proxy_device: string
    team: string
    claude_ui_pid: number
    new_csid: string
  }): void {
    this.db.prepare(
      `UPDATE agents
       SET delivery_kind = 'claude-channel',
           delivery_payload = json_object('channel_session_id', ?)
       WHERE role != '__channel_proxy__'
         AND device = ?
         AND runtime_ui_pid IS NOT NULL
         AND runtime_ui_pid = ?
         AND team = ?
         AND (
           delivery_kind = 'none'
           OR (delivery_kind = 'claude-channel'
               AND json_extract(delivery_payload,'$.channel_session_id') != ?)
         )`
    ).run(args.new_csid, args.proxy_device, args.claude_ui_pid, args.team, args.new_csid)
  }

  setDelivery(agent_id: string, spec: DeliverySpec): void {
    const serialized = serializeDelivery(spec)
    this.db.prepare(
      `UPDATE agents
       SET delivery_kind=?, delivery_payload=?
       WHERE agent_id=?`
    ).run(serialized.delivery_kind, serialized.delivery_payload, agent_id)
  }

  setAgentType(agent_id: string, agent_type: AgentType, agent_type_name?: string | null): void {
    this.db.prepare(
      `UPDATE agents
       SET agent_type=?,
           agent_type_name=?
       WHERE agent_id=?`
    ).run(agent_type, agent_type_name ?? null, agent_id)
  }

  setRuntimeBinding(
    agent_id: string,
    args: {
      tmux_pane_id: string
      runtime_ui_pid: number | null
      runtime_tty: string
      runtime_verification_mode: string
      runtime_bound_at?: string
    }
  ): void {
    this.db.prepare(
      `UPDATE agents
       SET tmux_pane_id=?,
           runtime_ui_pid=?,
           runtime_tty=?,
           runtime_verification_mode=?,
           runtime_bound_at=?
       WHERE agent_id=?`
    ).run(
      args.tmux_pane_id,
      args.runtime_ui_pid,
      args.runtime_tty,
      args.runtime_verification_mode,
      args.runtime_bound_at ?? new Date().toISOString(),
      agent_id
    )
  }

  list(args: {
    team: string
    excludeRoles?: string[]
    ttlMs?: number
  }): AgentListRow[] {
    const exclude = args.excludeRoles ?? []
    const ttlMs = args.ttlMs ?? REACHABLE_MS_DEFAULT
    const baseSelect =
      `SELECT
         agent_id,
         agent_type,
         agent_type_name,
         device,
         team,
         role,
         name,
         model,
         session_key,
         tmux_pane_id,
         runtime_ui_pid,
         delivery_kind,
         delivery_payload,
         last_seen_at,
         offline_since
       FROM agents
       WHERE team=?`
    const orderBy = ` ORDER BY registered_at ASC`
    let rows: DbAgentRow[]
    if (exclude.length > 0) {
      const placeholders = exclude.map(() => '?').join(',')
      rows = this.db.prepare(
        `${baseSelect} AND role NOT IN (${placeholders})${orderBy}`
      ).all(args.team, ...exclude) as DbAgentRow[]
    } else {
      rows = this.db.prepare(`${baseSelect}${orderBy}`).all(args.team) as DbAgentRow[]
    }
    return rows.map((row) => {
      const agent = toAgentRow(row)
      return {
        ...agent,
        online: row.offline_since === null && isAgentLive(agent, { ttlMs }),
      }
    })
  }

  touch(agent_id: string): void {
    this.db.prepare(`UPDATE agents SET last_seen_at=? WHERE agent_id=?`).run(new Date().toISOString(), agent_id)
  }

  /** Retain Claude keyed mailboxes; mark their first TTL expiry as offline. */
  deleteOlderThan(threshold: string): number {
    return this.db.transaction(() => {
      this.db.prepare(
        `UPDATE agents SET offline_since = ?
         WHERE last_seen_at < ? AND agent_type = 'claude-code'
           AND session_key IS NOT NULL AND offline_since IS NULL`
      ).run(new Date().toISOString(), threshold)
      // TTL expiry also revokes the bearer capability. A later resume issues
      // a fresh one, while the offline mailbox row and agent_id remain intact.
      this.db.prepare(
        `DELETE FROM claude_bind_capabilities
         WHERE agent_id IN (SELECT agent_id FROM agents
                            WHERE agent_type='claude-code' AND session_key IS NOT NULL
                              AND offline_since IS NOT NULL AND last_seen_at < ?)`
      ).run(threshold)
      const result = this.db.prepare(
        `DELETE FROM agents WHERE last_seen_at < ?
         AND (agent_type IS NOT 'claude-code' OR session_key IS NULL)`
      ).run(threshold)
      return result.changes
    })()
  }

  /** A session_end can only off-line the matching Claude session, never another agent. */
  markClaudeSessionOffline(agentId: string, sessionKey: string): boolean {
    const result = this.db.prepare(
      `UPDATE agents SET offline_since = COALESCE(offline_since, ?)
       WHERE agent_id = ? AND agent_type = 'claude-code' AND session_key = ?
         AND session_key IS NOT NULL`
    ).run(new Date().toISOString(), agentId, sessionKey)
    return result.changes === 1
  }

  deleteById(agent_id: string): boolean {
    const result = this.db.prepare(
      `DELETE FROM agents
       WHERE agent_id=?`
    ).run(agent_id)
    return result.changes === 1
  }

  getById(agent_id: string): AgentRow | undefined {
    const row = this.db.prepare(
      `SELECT
         agent_id,
         agent_type,
         agent_type_name,
         device,
         team,
         role,
         name,
         model,
         session_key,
         tmux_pane_id,
         runtime_ui_pid,
         delivery_kind,
         delivery_payload,
         last_seen_at,
         offline_since
       FROM agents
       WHERE agent_id=?`
    ).get(agent_id) as DbAgentRow | undefined
    if (!row) return undefined
    return toAgentRow(row)
  }

  findById(agent_id: string): AgentRow | undefined {
    return this.getById(agent_id)
  }

  /** Read the MCP inbox cursor without advancing it. */
  getLastProcessedEventId(agent_id: string): number | undefined {
    const row = this.db.prepare(
      `SELECT last_processed_event_id FROM agents WHERE agent_id=?`
    ).get(agent_id) as { last_processed_event_id: number } | undefined
    return row?.last_processed_event_id
  }
}
