import type { DeliveryCodexAppserver } from '../lib/delivery-spec.js'
import {
  JsonRpcSocketClient,
  defaultWebSocketFactory,
  describeError,
  resolveAuthToken,
  safeClose,
  type CodexWebSocketFactory,
  type JsonRpcResponse,
  type WebSocketLike,
} from './codex-appserver-rpc.js'
export type { WebSocketLike } from './codex-appserver-rpc.js'

type Json = unknown

export interface CodexAppserverDispatchDeps {
  env?: NodeJS.ProcessEnv
  webSocketFactory?: CodexWebSocketFactory
}

export type CodexAppserverDispatchResult =
  | {
      ok: true
      transport_used: 'codex-appserver'
      thread_id: string
    }
  | {
      error:
        | 'missing_auth_token'
        | 'codex_connect_failed'
        | 'codex_initialize_failed'
        | 'codex_resume_failed'
        | 'codex_turn_start_failed'
      detail?: unknown
      transport_used?: 'codex-appserver'
    }

async function requestStep(
  client: JsonRpcSocketClient,
  method: string,
  params: Json
): Promise<
  | { ok: JsonRpcResponse }
  | {
      error:
        | 'codex_initialize_failed'
        | 'codex_resume_failed'
        | 'codex_turn_start_failed'
      detail: unknown
    }
> {
  try {
    const response = await client.request(method, params)
    if (response.error) {
      const mappedError =
        method === 'initialize'
          ? 'codex_initialize_failed'
          : method === 'thread/resume'
            ? 'codex_resume_failed'
            : 'codex_turn_start_failed'
      return { error: mappedError, detail: response.error }
    }
    return { ok: response }
  } catch (error) {
    const mappedError =
      method === 'initialize'
        ? 'codex_initialize_failed'
        : method === 'thread/resume'
          ? 'codex_resume_failed'
          : 'codex_turn_start_failed'
    return { error: mappedError, detail: describeError(error) }
  }
}

export async function dispatchCodexAppserverPoke(
  input: {
    delivery: DeliveryCodexAppserver
    content: string
  },
  deps: CodexAppserverDispatchDeps = {}
): Promise<CodexAppserverDispatchResult> {
  const authToken = resolveAuthToken(
    input.delivery.auth_token_ref,
    deps.env ?? process.env
  )
  if ('error' in authToken) return authToken

  const headers = authToken.ok === undefined
    ? undefined
    : { Authorization: `Bearer ${authToken.ok}` }

  let ws: WebSocketLike
  try {
    ws = (deps.webSocketFactory ?? defaultWebSocketFactory)({
      url: input.delivery.ws_url,
      headers,
    })
  } catch (error) {
    return {
      error: 'codex_connect_failed',
      detail: describeError(error),
      transport_used: 'codex-appserver',
    }
  }

  const client = new JsonRpcSocketClient(ws)
  try {
    await client.waitForOpen()

    const init = await requestStep(client, 'initialize', {
      clientInfo: {
        name: 'cross-agent-teams-mcp',
        title: null,
        version: '0.1.0',
      },
      capabilities: {
        experimentalApi: true,
        optOutNotificationMethods: null,
      },
    })
    if ('error' in init) {
      return {
        error: init.error,
        detail: init.detail,
        transport_used: 'codex-appserver',
      }
    }

    client.notify('initialized')

    const resume = await requestStep(client, 'thread/resume', {
      threadId: input.delivery.thread_id,
      persistExtendedHistory: false,
    })
    if ('error' in resume) {
      return {
        error: resume.error,
        detail: resume.detail,
        transport_used: 'codex-appserver',
      }
    }

    const turnStart = await requestStep(client, 'turn/start', {
      threadId: input.delivery.thread_id,
      input: [{ type: 'text', text: input.content, text_elements: [] }],
    })
    if ('error' in turnStart) {
      return {
        error: turnStart.error,
        detail: turnStart.detail,
        transport_used: 'codex-appserver',
      }
    }

    return {
      ok: true,
      transport_used: 'codex-appserver',
      thread_id: input.delivery.thread_id,
    }
  } catch (error) {
    return {
      error: 'codex_connect_failed',
      detail: describeError(error),
      transport_used: 'codex-appserver',
    }
  } finally {
    safeClose(ws)
  }
}
