import type { RegisterAgentService } from './register-agent.js'
import { describeError } from './codex-appserver-rpc.js'

type FetchLike = typeof globalThis.fetch

export interface RegisterOpencodeSelfInput {
  connection_id: string
  name: string
  device?: string
  model?: string
  role?: string
  team?: string
  project_dir?: string
  base_url: string
  session_id?: string
  auth_token_ref?: string
}

export type RegisterOpencodeSelfResult =
  | {
      agent_id: string
      team: string
      session_id: string
      base_url: string
    }
  | { error: 'agent_id_collision' }
  | { error: 'invalid_delivery'; reason: string }
  | { error: 'claude_ui_pid_requires_channel_proxy' }
  | { error: 'device_spoofing_from_loopback' }
  | { error: 'device_required_from_remote' }
  | { error: 'device_spoofing_local_label_from_remote' }
  | { error: 'invalid_device_label' }
  | { error: 'invalid_name_label' }
  | { error: 'invalid_team_label' }
  | { error: 'opencode_unreachable'; detail: { base_url: string; cause: string } }
  | { error: 'no_active_session'; detail: { base_url: string } }

export interface RegisterOpencodeSelfDeps {
  env?: NodeJS.ProcessEnv
  fetch?: FetchLike
}

interface OpencodeSessionEntry {
  id?: unknown
  time_updated?: unknown
  time?: { updated?: unknown } | undefined
}

function trimToUndefined(value: string | undefined): string | undefined {
  const trimmed = value?.trim()
  return trimmed ? trimmed : undefined
}

function updatedOf(entry: OpencodeSessionEntry | undefined | null): number | undefined {
  if (!entry) return undefined
  if (typeof entry.time_updated === 'number') return entry.time_updated
  const nested = entry.time?.updated
  if (typeof nested === 'number') return nested
  return undefined
}

function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, '')
}

export class RegisterOpencodeSelfService {
  constructor(
    private readonly registerSvc: RegisterAgentService,
    private readonly deps: RegisterOpencodeSelfDeps = {}
  ) {}

  async register(
    input: RegisterOpencodeSelfInput
  ): Promise<RegisterOpencodeSelfResult> {
    const fetchImpl = this.deps.fetch ?? globalThis.fetch
    const baseUrl = normalizeBaseUrl(input.base_url)

    let healthOk = false
    let healthError = ''
    try {
      const healthRes = await fetchImpl(`${baseUrl}/global/health`, { method: 'GET' })
      if (healthRes.ok) {
        healthOk = true
      } else {
        healthError = `health check HTTP ${healthRes.status}`
      }
    } catch (error) {
      healthError = describeError(error)
    }
    if (!healthOk) {
      return {
        error: 'opencode_unreachable',
        detail: { base_url: input.base_url, cause: healthError },
      }
    }

    let sessionId = trimToUndefined(input.session_id)
    if (!sessionId) {
      let sessions: OpencodeSessionEntry[] = []
      try {
        const listRes = await fetchImpl(`${baseUrl}/session`, { method: 'GET' })
        if (listRes.ok) {
          const body = await listRes.json() as unknown
          if (Array.isArray(body)) {
            sessions = body as OpencodeSessionEntry[]
          } else if (body && typeof body === 'object') {
            const maybeArr = (body as { data?: unknown }).data
            if (Array.isArray(maybeArr)) {
              sessions = maybeArr as OpencodeSessionEntry[]
            }
          }
        }
      } catch (error) {
        return {
          error: 'opencode_unreachable',
          detail: { base_url: input.base_url, cause: describeError(error) },
        }
      }

      const candidates = sessions
        .filter((entry): entry is OpencodeSessionEntry & { id: string } =>
          typeof entry?.id === 'string' && updatedOf(entry) !== undefined
        )
        .sort((a, b) => (updatedOf(b) ?? 0) - (updatedOf(a) ?? 0))

      if (candidates.length === 0) {
        return {
          error: 'no_active_session',
          detail: { base_url: input.base_url },
        }
      }
      sessionId = candidates[0].id
    }

    const result = this.registerSvc.register({
      connection_id: input.connection_id,
      agent_type: 'opencode',
      model: input.model,
      device: input.device,
      name: input.name,
      role: input.role,
      team: input.team,
      project_dir: input.project_dir,
      delivery: {
        kind: 'opencode-server',
        session_id: sessionId,
        base_url: input.base_url,
        ...(input.auth_token_ref === undefined
          ? {}
          : { auth_token_ref: input.auth_token_ref }),
      },
    })
    if ('error' in result) return result
    return {
      ...result,
      session_id: sessionId,
      base_url: input.base_url,
    }
  }
}
