import type Database from 'better-sqlite3'
import {
  validateDeliveryForWrite,
  type DeliveryValidationReason,
} from '../lib/delivery-spec.js'
import type { AgentType } from '../lib/agent-type.js'
import { deriveDefaultTeam } from '../lib/default-team.js'
import { AgentsRepo } from '../storage/agents-repo.js'
import type { SessionOriginInfo } from '../daemon/network-origin.js'

export { deriveDefaultTeam } from '../lib/default-team.js'

export interface RegisterInput {
  connection_id: string
  agent_type?: AgentType
  agent_type_name?: string
  model?: string
  device?: string
  name: string
  role?: string
  team?: string
  project_dir?: string
  tmux_pane_id?: string
  delivery?: unknown
  claude_ui_pid?: number
  runtime_ui_pid?: number
}

export type RegisterResult =
  | { agent_id: string; team: string }
  | { error: 'agent_id_collision' }
  | { error: 'invalid_delivery'; reason: DeliveryValidationReason }
  | { error: 'claude_ui_pid_requires_channel_proxy' }
  | { error: 'device_spoofing_from_loopback' }
  | { error: 'device_required_from_remote' }
  | { error: 'device_spoofing_local_label_from_remote' }
  | { error: 'invalid_device_label' }
  | { error: 'invalid_name_label' }
  | { error: 'invalid_team_label' }

function identityKey(device: string, team: string, name: string): string {
  return `${device}\u0000${team}\u0000${name}`
}

export function validateNameLabel(name: string): { ok: string } | { error: 'invalid_name_label' } {
  if (name.includes(':') || name.includes('(') || name.includes(')')) {
    return { error: 'invalid_name_label' }
  }
  return { ok: name }
}

export function validateTeamLabel(team: string): { ok: string } | { error: 'invalid_team_label' } {
  if (team.includes('(') || team.includes(')')) {
    return { error: 'invalid_team_label' }
  }
  return { ok: team }
}

export function resolveEffectiveDevice(args: {
  requestedDevice?: string
  originInfo?: SessionOriginInfo
  localDevice: string
}):
  | { ok: string; remote_addr: string | null }
  | { error: 'device_spoofing_from_loopback' | 'device_required_from_remote' | 'device_spoofing_local_label_from_remote' | 'invalid_device_label' } {
  const origin = args.originInfo?.origin ?? 'local'
  const remote_addr = args.originInfo?.remote_addr ?? null
  const requestedDevice = args.requestedDevice?.trim()

  if (origin === 'local') {
    if (requestedDevice && requestedDevice !== args.localDevice) {
      return { error: 'device_spoofing_from_loopback' }
    }
    return { ok: args.localDevice, remote_addr: null }
  }

  if (!requestedDevice) {
    return { error: 'device_required_from_remote' }
  }
  if (requestedDevice.includes(':') || requestedDevice.length > 64) {
    return { error: 'invalid_device_label' }
  }
  // Normalize the remote-supplied label using the same rules the daemon and
  // channel-cli apply to locally-derived labels (lowercase, non-[a-z0-9_-]
  // replaced with '-'). Without this, the same physical host registers under
  // different labels depending on which path issued the register_agent call
  // (e.g. `MyMac.local` via direct register vs `mymac-local` via channel-cli).
  // requestedDevice is already trimmed and non-empty above, and `replace` (not
  // `remove`) maps every char to at least one output char, so the normalized
  // value is also non-empty.
  const normalizedDevice = requestedDevice
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, '-')
  if (normalizedDevice === args.localDevice) {
    return { error: 'device_spoofing_local_label_from_remote' }
  }
  return { ok: normalizedDevice, remote_addr }
}

export interface RegisterAgentDeps {
  /**
   * Cross-session takeover hook. When `register_agent` re-claims a `(device, team, name)`
   * binding from a NEW MCP session id, the service invokes this with the OLD
   * connection_id so the transport layer can force-close the prior session.
   * Returns true when the old session id was found and a close was issued.
   */
  closeSessionByConnectionId?: (connectionId: string) => boolean
  /**
   * Debug log sink. When omitted, takeover events go through `console.debug`.
   */
  log?: (line: string) => void
  localDevice?: string
  getSessionOrigin?: (connectionId: string) => SessionOriginInfo | undefined
}

export class RegisterAgentService {
  private readonly repo: AgentsRepo
  private readonly connections = new Map<string, string>()
  private readonly deps: RegisterAgentDeps

  constructor(db: Database.Database, deps: RegisterAgentDeps = {}) {
    this.repo = new AgentsRepo(db)
    this.deps = deps
  }

  register(input: RegisterInput): RegisterResult {
    const validated =
      input.delivery === undefined
        ? undefined
        : validateDeliveryForWrite(input.delivery)
    if (validated && 'error' in validated) return validated

    const role = input.role ?? 'default'
    if (input.claude_ui_pid !== undefined && role !== '__channel_proxy__') {
      return { error: 'claude_ui_pid_requires_channel_proxy' }
    }
    const validName = validateNameLabel(input.name)
    if ('error' in validName) return validName
    if (input.team !== undefined) {
      const validTeam = validateTeamLabel(input.team)
      if ('error' in validTeam) return validTeam
    }
    const resolvedDevice = resolveEffectiveDevice({
      requestedDevice: input.device ?? undefined,
      originInfo: this.deps.getSessionOrigin?.(input.connection_id),
      localDevice: this.deps.localDevice ?? 'local',
    })
    if ('error' in resolvedDevice) return resolvedDevice

    const team = deriveDefaultTeam({
      team: input.team,
      project_dir: input.project_dir,
    })
    const key = identityKey(resolvedDevice.ok, team, input.name)
    const bound = this.connections.get(key)
    if (bound && bound !== input.connection_id) {
      // Cross-session takeover: release the old binding and force-close the
      // prior MCP transport. The old session's `onclose` chain reaps it from
      // the daemon's `sessions` Map; new session keeps its existing binding.
      let closed = false
      if (this.deps.closeSessionByConnectionId) {
        try { closed = this.deps.closeSessionByConnectionId(bound) } catch { /* best-effort */ }
      }
      const log = this.deps.log ?? (() => {})
      try {
        log(`register_agent takeover: old=${bound} new=${input.connection_id} device=${resolvedDevice.ok} team=${team} name=${input.name} closed=${closed}`)
      } catch { /* best-effort */ }
    }
    this.connections.set(key, input.connection_id)
    return this.repo.register({
      agent_type: input.agent_type,
      agent_type_name: input.agent_type_name,
      device: resolvedDevice.ok,
      model: input.model,
      name: input.name,
      role,
      team,
      tmux_pane_id: input.tmux_pane_id,
      delivery: validated?.ok,
      claude_ui_pid: input.claude_ui_pid,
      runtime_ui_pid: input.runtime_ui_pid,
      remote_addr: resolvedDevice.remote_addr,
    })
  }

  releaseConnection(agent_id: string, connection_id: string): void {
    // Release by connection_id — scan and unbind any identity key mapped to this connection.
    for (const [k, cid] of this.connections) {
      if (cid === connection_id) this.connections.delete(k)
    }
    void agent_id
  }
}
