import { RegisterAgentService } from './register-agent.js'
import {
  JsonRpcSocketClient,
  defaultWebSocketFactory,
  describeError,
  resolveAuthToken,
  safeClose,
  type CodexWebSocketFactory,
  type JsonRpcResponse,
} from './codex-appserver-rpc.js'

export interface RegisterCodexSelfInput {
  connection_id: string
  name: string
  device?: string
  model?: string
  role?: string
  team?: string
  project_dir?: string
  ws_url?: string
  auth_token_ref?: string
  thread_id?: string
  tmux_pane_id?: string
  cwd?: string
  tty?: string
  title_contains?: string
}

export type RegisterCodexSelfResult =
  | {
      agent_id: string
      team: string
      thread_id: string
      ws_url: string
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
  | { error: 'missing_auth_token'; detail: { ref: string } }
  | { error: 'unsupported_client'; detail: { expected: 'codex'; reason: 'codex_appserver_unreachable' | 'codex_protocol_unavailable'; ws_url: string; cause?: unknown } }
  | { error: 'codex_connect_failed'; detail?: unknown }
  | { error: 'codex_initialize_failed'; detail?: unknown }
  | { error: 'codex_loaded_list_failed'; detail?: unknown }
  | { error: 'no_loaded_threads'; detail?: unknown }
  | { error: 'thread_id_required'; detail: { ws_url: string; thread_ids: string[] } }
  | { error: 'codex_resume_failed'; detail?: unknown }

export interface RegisterCodexSelfDeps {
  env?: NodeJS.ProcessEnv
  webSocketFactory?: CodexWebSocketFactory
}

type RpcErrorCode =
  | 'codex_initialize_failed'
  | 'codex_loaded_list_failed'
  | 'codex_resume_failed'

const DEFAULT_CODEX_WS_URL = 'ws://127.0.0.1:8799'

async function requestStep(
  client: JsonRpcSocketClient,
  method: string,
  params: unknown,
  errorCode: RpcErrorCode
): Promise<{ ok: JsonRpcResponse } | { error: RpcErrorCode; detail: unknown }> {
  try {
    const response = await client.request(method, params)
    if (response.error) return { error: errorCode, detail: response.error }
    return { ok: response }
  } catch (error) {
    return { error: errorCode, detail: describeError(error) }
  }
}

function resolveWsUrl(
  input: RegisterCodexSelfInput,
  env: NodeJS.ProcessEnv
): string {
  const explicit = input.ws_url?.trim()
  if (explicit) return explicit
  const fromEnv = env.CROSS_AGENT_TEAMS_CODEX_WS_URL?.trim()
  if (fromEnv) return fromEnv
  return DEFAULT_CODEX_WS_URL
}

function extractThreadIds(response: JsonRpcResponse): string[] {
  const result = response.result as { data?: unknown } | undefined
  if (!result || !Array.isArray(result.data)) return []
  return result.data.filter((value): value is string => typeof value === 'string')
}

function trimToUndefined(value: string | undefined): string | undefined {
  const trimmed = value?.trim()
  return trimmed ? trimmed : undefined
}

export class RegisterCodexSelfService {
  constructor(
    private readonly registerSvc: RegisterAgentService,
    private readonly deps: RegisterCodexSelfDeps = {}
  ) {}

  async register(
    input: RegisterCodexSelfInput
  ): Promise<RegisterCodexSelfResult> {
    const env = this.deps.env ?? process.env
    const wsUrl = resolveWsUrl(input, env)
    const token = resolveAuthToken(input.auth_token_ref, env)
    if ('error' in token) return token
    const headers = token.ok === undefined
      ? undefined
      : { Authorization: `Bearer ${token.ok}` }

    let ws
    try {
      ws = (this.deps.webSocketFactory ?? defaultWebSocketFactory)({
        url: wsUrl,
        headers,
      })
    } catch (error) {
      return {
        error: 'unsupported_client',
        detail: {
          expected: 'codex',
          reason: 'codex_appserver_unreachable',
          ws_url: wsUrl,
          cause: describeError(error),
        },
      }
    }

    const client = new JsonRpcSocketClient(ws)
    try {
      await client.waitForOpen()

      const init = await requestStep(
        client,
        'initialize',
        {
          clientInfo: {
            name: 'cross-agent-teams-mcp',
            title: null,
            version: '0.1.0',
          },
          capabilities: {
            experimentalApi: true,
            optOutNotificationMethods: null,
          },
        },
        'codex_initialize_failed'
      )
      if ('error' in init) {
        return {
          error: 'unsupported_client',
          detail: {
            expected: 'codex',
            reason: 'codex_protocol_unavailable',
            ws_url: wsUrl,
            cause: init.detail,
          },
        }
      }

      client.notify('initialized')

      const explicitThreadId = trimToUndefined(input.thread_id)
      let threadId = explicitThreadId

      if (!threadId) {
        const list = await requestStep(
          client,
          'thread/loaded/list',
          { cursor: null, limit: 20 },
          'codex_loaded_list_failed'
        )
        if ('error' in list) return list

        const threadIds = extractThreadIds(list.ok)
        if (threadIds.length === 0) {
          return {
            error: 'no_loaded_threads',
            detail: { ws_url: wsUrl },
          }
        }

        const liveThreadIds: string[] = []
        const failures: Array<{ thread_id: string; detail: unknown }> = []
        for (const candidateThreadId of threadIds) {
          const resume = await requestStep(
            client,
            'thread/resume',
            {
              threadId: candidateThreadId,
              persistExtendedHistory: false,
            },
            'codex_resume_failed'
          )
          if ('error' in resume) {
            failures.push({ thread_id: candidateThreadId, detail: resume.detail })
            continue
          }
          liveThreadIds.push(candidateThreadId)
        }

        if (liveThreadIds.length === 0) {
          return {
            error: 'codex_resume_failed',
            detail: failures,
          }
        }

        return {
          error: 'thread_id_required',
          detail: {
            ws_url: wsUrl,
            thread_ids: liveThreadIds,
          },
        }
      }

      const resume = await requestStep(
        client,
        'thread/resume',
        {
          threadId,
          persistExtendedHistory: false,
        },
        'codex_resume_failed'
      )
      if ('error' in resume) {
        return {
          error: 'codex_resume_failed',
          detail: { thread_id: threadId, cause: resume.detail },
        }
      }

      const tmuxPaneId = trimToUndefined(input.tmux_pane_id)

      const result = this.registerSvc.register({
        connection_id: input.connection_id,
        agent_type: 'codex',
        model: input.model ?? 'codex',
        device: input.device,
        name: input.name,
        role: input.role,
        team: input.team,
        project_dir: input.project_dir,
        tmux_pane_id: tmuxPaneId,
        delivery: {
          kind: 'codex-appserver',
          thread_id: threadId,
          ws_url: wsUrl,
          ...(input.auth_token_ref === undefined
            ? {}
            : { auth_token_ref: input.auth_token_ref }),
        },
      })
      if ('error' in result) return result
      return {
        ...result,
        thread_id: threadId,
        ws_url: wsUrl,
      }
    } catch (error) {
      return {
        error: 'unsupported_client',
        detail: {
          expected: 'codex',
          reason: 'codex_appserver_unreachable',
          ws_url: wsUrl,
          cause: describeError(error),
        },
      }
    } finally {
      safeClose(ws)
    }
  }
}
