import type Database from 'better-sqlite3'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { AgentsRepo } from '../storage/agents-repo.js'
import { EventsOutbox } from '../storage/events-outbox.js'
import {
  RegisterAgentService,
  resolveEffectiveDevice,
} from './register-agent.js'
import { SendMessageService } from './send-message.js'
import { BroadcastService } from './broadcast.js'
import { BroadcastToRoleService } from './broadcast-to-role.js'
import { GetInboxService } from './get-inbox.js'
import { GetDeliveryStatusService } from './delivery-status.js'
import { poke } from './poke.js'
import { wrapStorage } from '../daemon/errors.js'
import type { SseFanout } from '../daemon/sse-fanout.js'
import type { ChannelWakeFanout } from '../daemon/channel-wake-fanout.js'
import { SubscribeChannelWakeService } from './subscribe-channel-wake.js'
import { BindChannelService } from './bind-channel.js'
import { AutoBindChannelService } from './auto-bind-channel.js'
import { BindRuntimeIdentityService } from './bind-runtime-identity.js'
import { RegisterCodexSelfService } from './register-codex-self.js'
import { RegisterOpencodeSelfService } from './register-opencode-self.js'
import { resolveReconnect } from './reconnect.js'
import { UnregisterSelfService } from './unregister-self.js'
import { listAgentsForTeam } from './list-agents.js'
import { detectTmuxPane } from '../daemon/tmux-pane-detect.js'
import { bindRuntimeIdentity } from '../daemon/runtime-identity.js'
import type { DetectAgentKind } from '../daemon/tmux-pane-detect.js'
import type { AgentType } from '../lib/agent-type.js'
import { CodexPanePreRegRepo } from './codex-pane-pre-register-repo.js'
import {
  PreRegisterCodexPaneService,
  preRegisterCodexPaneInputSchema,
} from './pre-register-codex-pane.js'
import { autoBindCodexPane } from './auto-bind-codex-pane.js'
import type { SessionOriginInfo } from '../daemon/network-origin.js'
import type { DaemonContext } from '../daemon/server.js'

export interface AgentIdHolder { current: string | undefined }

type TextContent = { content: Array<{ type: 'text'; text: string }> }

function toText(value: unknown): TextContent {
  return { content: [{ type: 'text', text: JSON.stringify(value) }] }
}

const deliverySchema = z.object({
  kind: z.string(),
}).passthrough()

const agentTypeSchema = z.enum(['codex', 'claude-code', 'opencode', 'custom'])

const detectTmuxPaneSchema = z.object({
  agent: z.enum(['codex', 'claude-code', 'opencode', 'custom']),
  cwd: z.string().optional(),
  tty: z.string().optional(),
  title_contains: z.string().optional(),
  process_pattern: z.string().optional(),
})

const detectTmuxPaneArgsSchema = detectTmuxPaneSchema.superRefine((value, ctx) => {
  if (value.agent === 'custom' && (!value.process_pattern || value.process_pattern.trim().length === 0)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['process_pattern'],
      message: 'process_pattern is required when agent=custom',
    })
  }
})

const bindRuntimeIdentitySchema = z.object({
  agent: z.enum(['codex', 'claude-code', 'opencode', 'custom']),
  ui_pid: z.number().int().positive().optional(),
  ui_tty: z.string().optional(),
  tmux_pane_id: z.string().min(1).optional(),
  process_pattern: z.string().optional(),
})

const bindRuntimeIdentityArgsSchema = bindRuntimeIdentitySchema.superRefine((value, ctx) => {
  if (value.agent === 'custom' && (!value.process_pattern || value.process_pattern.trim().length === 0)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['process_pattern'],
      message: 'process_pattern is required when agent=custom',
    })
  }
  const hasPid = value.ui_pid !== undefined
  const hasTtyPair =
    value.ui_tty !== undefined &&
    value.ui_tty.trim().length > 0 &&
    value.tmux_pane_id !== undefined &&
    value.tmux_pane_id.trim().length > 0
  if (!hasPid && !hasTtyPair) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'provide ui_pid, or ui_tty together with tmux_pane_id',
    })
  }
})

const SEND_MESSAGE_DESC = [
  'Private 1→1 message to another agent by name.  By default auto-poke=true with quiet-guard (auto_poke:false opts out), and need_reply=true.',
  'Set need_reply:false for FYI/no-response-needed messages; recipients see need_reply in get_inbox.',
  'to_agent_name is the target\'s `name` within its team; bare names resolve on the caller\'s device, and `name:device` targets a specific device.  For UUID-based sends use send_message_by_id.',
  'If the user refers to a recipient in the shorthand `name(team)` (e.g. `skills-creator(default)`), split it into `to_agent_name`=`skills-creator` and `to_team`=`default`. The daemon does NOT parse `name(team)`, so the literal string fails to resolve (unknown_recipient). This is distinct from the `name:device` suffix, which the daemon DOES parse.',
  'REPLY RULE: when replying to a message returned by get_inbox, treat its `from_device` as authoritative — if it differs from your own device, you MUST send to `from_name + ":" + from_device` (bare `from_name` would resolve on YOUR device and miss the actual sender). Same-device replies can use the bare name. The safe fallback for unknown device is send_message_by_id({to_agent_id: from_agent_id, ...}).',
  'For multi-recipient use broadcast (same-team) or broadcast_to_role (same-team, by role).',
  '除非用户明确指定 to_team, 不要跨 team 沟通 (explicitly set to_team only when user asks).',
  'Reports poked, poke_skip_reasons (no_pane, guard_failed, tmux_unavailable, self); on guard_failed daemon retries at 30s/180s/600s (retry_scheduled, retry_delays_s); stops early on poked.',
  'Auto-poke injects only a SHORT wake-up hint (新邮件 from <sender>, 请调 get_inbox 查看), NOT the body — read bodies via get_inbox.',
  'Delivery is NOT filtered by online/idle; direct and fan-out deliveries write mailbox rows for offline targets. The list_agents `online` flag reflects process liveness.',
  'DO NOT pre-verify the recipient via list_agents before calling send_message — this rule applies to BOTH same-team and cross-team sends (list_agents is caller-team scoped and CANNOT see cross-team agents, so a cross-team pre-check always falsely reports "missing"; for same-team sends the pre-check is pure waste).',
  'On miss send_message returns unknown_recipient cleanly with no side effects, so the correct pattern is "try send, then handle unknown_recipient" — never "list_agents first, then send".'
].join(' ')

const SEND_MESSAGE_BY_ID_DESC = [
  'Private 1→1 message to another agent by agent_id (UUID).  Use this when you already hold the target\'s agent_id; prefer send_message (by name) otherwise.',
  'Same-team only: the recipient must belong to the caller\'s team.  For cross-team sends use send_message with to_team.',
  'By default auto-poke=true with quiet-guard (auto_poke:false opts out), and need_reply=true.  Set need_reply:false for FYI/no-response-needed messages.',
  'Reports poked, poke_skip_reasons (no_pane, guard_failed, tmux_unavailable, self); on guard_failed daemon retries at 30s/180s/600s (retry_scheduled, retry_delays_s); stops early on poked.',
  'Auto-poke injects only a SHORT wake-up hint (新邮件 from <sender>, 请调 get_inbox 查看), NOT the body — read bodies via get_inbox.',
  'Delivery is NOT filtered by online/idle — offline targets still receive the mailbox row.'
].join(' ')

const BROADCAST_DESC = [
  'Same-team broadcast to every other agent in the caller team across all devices; delivers to every team member except the sender.',
  'Auto-poke default true (quiet-guard + 30s/180s/600s retry; reports poked, poke_skip_reasons, retry_scheduled, retry_delays_s).  auto_poke:false opts out.',
  'For role filter use broadcast_to_role.  For cross-team 1→1 use send_message({to_team}).',
  'Auto-poke injects only a SHORT wake-up hint (新邮件 from <sender>, 请调 get_inbox 查看) — never the body.  Read via get_inbox.',
  'Delivery is NOT filtered by online/idle; offline targets still receive mailbox rows. The list_agents `online` flag reflects process liveness.'
].join(' ')

const BROADCAST_TO_ROLE_DESC = [
  'Same-team broadcast filtered by role across all devices; delivers to every matching team member.  Strictly same-team — no cross-team variant.',
  'For cross-team private 1→1 use send_message({to_team}).',
  'Auto-poke default true with quiet-guard + 30s/180s/600s retry (auto_poke:false opts out); injects only a SHORT wake-up hint, not the message body.  Recipients read via get_inbox.',
  'Returns unknown_recipient when no same-team agent matches to_role.'
].join(' ')

const RECONNECT_DESC = [
  'Recover this session\'s prior xats identity when you no longer remember your own (team, name) — for example after a context clear, where the Claude UI process ($PPID) is unchanged but the MCP/channel session is fresh and bind_channel returns unknown_agent. Prefer this over the bind_channel→register_agent fallback for re-establishing on a fresh session: it re-establishes the identity AND rebinds the channel in one call.',
  'Route by whether you still remember your (team, name): if you DO remember it after a restart + resume (you closed Claude Code and resumed the conversation, so $PPID has CHANGED but the context survived), call register_agent with that remembered (team, name) and the current $PPID instead of reconnect — reconnect would reverse-look-up the changed $PPID, find no match, and return need_register. Use reconnect only when you do NOT remember your (team, name).',
  'Invoke this when the user asks to "reconnect xats", "re-register xats", "重连 xats", or "重新注册 xats".',
  '`ui_pid` is the Claude UI process id — pass `$PPID` from a Bash tool call inside Claude Code (the same value register_agent takes as `ui_pid`).',
  'The daemon reverse-looks-up the most recent local claude-code agent row whose runtime_ui_pid matches `ui_pid`, then re-establishes that identity (cross-session takeover + channel/pane auto-bind) reusing the existing agent_id.',
  'On a single match: returns { ok, agent_id, name, team, channel_session_id, last_seen_at }.',
  'On zero matches: returns { need_register, reason } — reconnect does NOT auto-register; call register_agent to create a new identity.',
  'On multiple matches (e.g. the same UI process previously registered under two names): returns { ambiguous, candidates } ordered by last_seen_at descending — surface them so the user can pick, then register_agent with the chosen name.',
  'Each candidate/match carries last_seen_at; if it looks stale the matched ui_pid may have been reused by an unrelated process — surface it to the user before trusting the recovered identity.',
  'Scope is the daemon\'s configured local device label for claude-code only; codex (thread_id-based) reconnect is out of scope.',
].join(' ')

function suppressTmuxHint(
  args: { delivery?: { kind?: string } }
): boolean {
  return args.delivery?.kind !== undefined && args.delivery.kind !== 'none'
}

function defaultClaudeSelfModel(
  clientInfo: SessionClientInfo | undefined
): string {
  const raw = `${clientInfo?.name ?? ''} ${clientInfo?.version ?? ''}`.trim()
  if (/claude/i.test(raw)) return raw
  return 'claude-code'
}

export function buildAutoPokeHint(
  row: { name?: string | null } | undefined,
  fromAgentId: string
): string {
  const dn = row?.name
  const sender = typeof dn === 'string' && dn.length > 0
    ? `${dn} (${fromAgentId})`
    : fromAgentId.slice(0, 8)
  return `新邮件 from ${sender}, 请调 get_inbox 查看`
}

export function createAutoPokeImpl(
  db: Database.Database,
  _agents: AgentsRepo,
  channelWakeFanout?: ChannelWakeFanout
): import('./auto-poke-fanout.js').AutoPokeFn {
  return async (args) => {
    const row = db
      .prepare('SELECT name FROM agents WHERE agent_id=?')
      .get(args.fromAgentId) as { name: string | null } | undefined
    const hint = buildAutoPokeHint(row, args.fromAgentId)
    const res = await poke(
      { db, callerAgentId: args.fromAgentId, allowCrossTeam: true, channelWakeFanout },
      { target_agent_id: args.targetAgentId, prompt: hint, skipGuard: args.skipGuard }
    )
    if ('ok' in res && res.ok) return { ok: true }
    const err = (res as { error?: string }).error
    if (err === 'tmux_unavailable') return { ok: false, reason: 'tmux_unavailable' }
    if (err === 'tmux_pane_not_set') return { ok: false, reason: 'no_pane' }
    if (err === 'no_transport_available') return { ok: false, reason: 'no_pane' }
    if (err === 'self_poke_denied') return { ok: false, reason: 'self' }
    // Remaining errors (incl. guard_failed) map to guard_failed so the retry
    // scheduler picks them up; this preserves the pre-change fall-through.
    return { ok: false, reason: 'guard_failed' }
  }
}

export interface RegisterSuccessHook {
  (agent_id: string, team: string): void
}

export interface UnregisterSuccessHook {
  (agent_id: string): void
}


export interface TransportLike {
  send(msg: Record<string, unknown>): Promise<void> | void
}

export interface SessionClientInfo {
  name?: string
  version?: string
}

function inferRuntimeAgentKind(
  args: { agent_type?: AgentType; delivery?: { kind?: string }; model?: string },
  clientInfo: SessionClientInfo | undefined
): DetectAgentKind | undefined {
  if (args.agent_type === 'custom') return undefined
  if (args.agent_type) return args.agent_type
  if (args.delivery?.kind === 'codex-appserver') return 'codex'

  const raw = `${clientInfo?.name ?? ''} ${clientInfo?.version ?? ''} ${args.model ?? ''}`.toLowerCase()
  if (raw.includes('codex')) return 'codex'
  if (raw.includes('gpt-')) return 'codex'
  if (raw.includes('claude')) return 'claude-code'
  if (raw.includes('opus') || raw.includes('sonnet')) return 'claude-code'
  if (raw.includes('opencode')) return 'opencode'
  return undefined
}

export function registerBusinessTools(
  server: McpServer,
  db: Database.Database,
  getCallerAgentId: () => string | undefined,
  fanout?: SseFanout,
  onRegisterSuccess?: RegisterSuccessHook,
  getSessionId?: () => string | undefined,
  channelWakeFanout?: ChannelWakeFanout,
  getTransport?: () => TransportLike,
  getSessionClientInfo?: () => SessionClientInfo | undefined,
  getSessionOriginInfo?: () => SessionOriginInfo | undefined,
  context?: DaemonContext,
  onUnregisterSuccess?: UnregisterSuccessHook,
  injectedRegisterSvc?: RegisterAgentService
): void {
  const agents = new AgentsRepo(db)
  const events = new EventsOutbox(db)
  const registerSvc = injectedRegisterSvc ?? new RegisterAgentService(db, {
    localDevice: context?.localDevice,
    getSessionOrigin: () => getSessionOriginInfo?.(),
  })
  const bindRuntimeIdentitySvc = new BindRuntimeIdentityService(db)
  const registerCodexSelfSvc = new RegisterCodexSelfService(registerSvc)
  const registerOpencodeSelfSvc = new RegisterOpencodeSelfService(registerSvc)
  const unregisterSelfSvc = new UnregisterSelfService(db, agents)

  const autoPokeImpl = createAutoPokeImpl(db, agents, channelWakeFanout)

  const sendSvc = new SendMessageService(db, agents, events, { poke: autoPokeImpl })
  const broadcastSvc = new BroadcastService(db, agents, { poke: autoPokeImpl })
  const broadcastToRoleSvc = new BroadcastToRoleService(db, agents, events, { poke: autoPokeImpl })
  const inboxSvc = new GetInboxService(db, agents)
  const deliveryStatusSvc = new GetDeliveryStatusService(db)
  const codexPanePreRegRepo = new CodexPanePreRegRepo(db)
  const preRegisterCodexPaneSvc = new PreRegisterCodexPaneService(codexPanePreRegRepo)

  function caller(): string | undefined { return getCallerAgentId() }

  async function run(fn: () => unknown): Promise<TextContent> {
    const out = await wrapStorage(() => fn())
    touchIfRegistered()
    return toText(out)
  }

  function touchIfRegistered(): void {
    const c = caller()
    if (!c) return
    try {
      if (agents.findById(c)) agents.touch(c)
    } catch { /* best-effort */ }
  }

  function requireAgent(): string | { error: 'unknown_agent' } {
    const c = caller()
    if (!c) return { error: 'unknown_agent' }
    const row = agents.findById(c)
    if (!row) return { error: 'unknown_agent' }
    return c
  }

  async function autoBindRuntimeIdentity(
    args: {
      agent_type?: AgentType
      model?: string
      delivery?: { kind?: string }
      ui_pid?: number
    },
    callerAgentId: string
  ): Promise<boolean> {
    const inferredAgent = inferRuntimeAgentKind(args, getSessionClientInfo?.())
    if (!inferredAgent) return false

    if (args.ui_pid !== undefined) {
      const boundByPid = await bindRuntimeIdentitySvc.bind({
        callerAgentId,
        agent: inferredAgent,
        ui_pid: args.ui_pid,
      })
      return 'ok' in boundByPid && boundByPid.ok
    }

    if (inferredAgent === 'codex') {
      const auto = await autoBindCodexPane({
        callerAgentId,
        repo: codexPanePreRegRepo,
        bindRuntimeIdentitySvc,
      })
      if (auto) return true
    }

    const detected = await detectTmuxPane({ agent: inferredAgent })
    if (!('ok' in detected) || !detected.ok) return false

    const bound = await bindRuntimeIdentitySvc.bind({
      callerAgentId,
      agent: inferredAgent,
      ui_tty: detected.pane.tty,
      tmux_pane_id: detected.pane.pane_id,
    })
    return 'ok' in bound && bound.ok
  }

  async function preflightUiPidClient(
    args: {
      agent_type?: AgentType
      model?: string
      delivery?: { kind?: string }
      ui_pid?: number
    }
  ): Promise<
    | undefined
    | {
        error: 'ui_pid_client_mismatch'
        detail: string
      }
  > {
    if (args.ui_pid === undefined) return undefined
    const inferredAgent = inferRuntimeAgentKind(args, getSessionClientInfo?.())
    if (!inferredAgent) return undefined

    const validated = await bindRuntimeIdentity({
      agent: inferredAgent,
      ui_pid: args.ui_pid,
    })
    if (!('error' in validated) || validated.error !== 'agent_process_mismatch') {
      return undefined
    }

    return {
      error: 'ui_pid_client_mismatch',
      detail:
        `ui_pid ${args.ui_pid} does not belong to agent_type=\"${inferredAgent}\". ` +
        'Pass the runtime kind for the process behind ui_pid; for example, use agent_type="opencode" when ui_pid points at an opencode process.',
    }
  }

  const registerAgentInputSchema = z.object({
    model: z.string().optional(),
    name: z.string().min(1).refine(v => v.trim().length > 0, { message: 'name must not be empty' }),
    device: z.string().nullish(),
    role: z.string().optional(),
    team: z.string().optional(),
    project_dir: z.string().min(1).optional(),
    agent_type: agentTypeSchema,
    agent_type_name: z.string().min(1).optional(),
    ui_pid: z.number().int().positive().optional().describe(
      'STRONGLY RECOMMENDED. Visible agent UI process pid (e.g. Claude Code CLI pid — `$PPID` from a Bash tool call inside Claude Code). Enables one-shot pid → tty → pane binding at registration; without it, tmux-based cross-agent poke delivery typically stays off.'
    ),
    channel_session_id: z.string().min(1).optional(),
    thread_id: z.string().min(1).refine(v => v.trim().length > 0, { message: 'thread_id must not be empty' }).optional(),
    ws_url: z.string().optional(),
    auth_token_ref: z.string().min(1).optional(),
    base_url: z.string().min(1).refine(v => v.trim().length > 0, { message: 'base_url must not be empty' }).optional(),
    session_id: z.string().min(1).refine(v => v.trim().length > 0, { message: 'session_id must not be empty' }).optional(),
    claude_ui_pid: z.number().int().positive().optional().describe(
      "Internal field for the cross-agent-teams-mcp channel proxy.  Stores the proxy's parent Claude Code UI pid (`process.ppid`) so that Claude Code hosts registering in the same lineage can auto-bind their claude-channel delivery.  Only valid when role='__channel_proxy__'; rejected otherwise."
    ),
    delivery: deliverySchema.optional(),
  }).strict(
    'Unrecognized key in register_agent input. Note: the fields `client` and `client_name` were renamed to `agent_type` and `agent_type_name` in 0.5.0.'
  )

  const registerAgentArgsSchema = registerAgentInputSchema.superRefine((value, ctx) => {
    // `thread_id` and `ws_url` are codex-exclusive transport fields.
    // `auth_token_ref` is shared between codex-appserver and opencode-server deliveries.
    const hasCodexOnlyFields =
      value.thread_id !== undefined ||
      value.ws_url !== undefined
    if (hasCodexOnlyFields && value.agent_type !== 'codex') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['agent_type'],
        message: 'agent_type=codex is required when thread_id or ws_url is provided',
      })
    }
    if (
      value.auth_token_ref !== undefined &&
      value.agent_type !== 'codex' &&
      value.agent_type !== 'opencode'
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['agent_type'],
        message: 'agent_type=codex or agent_type=opencode is required when auth_token_ref is provided',
      })
    }
    if (value.channel_session_id !== undefined && value.agent_type !== 'claude-code') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['agent_type'],
        message: 'agent_type=claude-code is required when channel_session_id is provided',
      })
    }
    if (value.agent_type_name !== undefined && value.agent_type !== 'custom') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['agent_type_name'],
        message: 'agent_type_name is only allowed when agent_type=custom',
      })
    }
    if (value.claude_ui_pid !== undefined && value.role !== '__channel_proxy__') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['claude_ui_pid'],
        message: "claude_ui_pid is only allowed when role='__channel_proxy__'",
      })
    }
    if (
      value.agent_type === 'codex' &&
      value.delivery === undefined &&
      (value.thread_id === undefined || value.thread_id === '')
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['thread_id'],
        message:
          'thread_id is required when agent_type="codex". '
          + 'If you are a launcher pre-registering a codex pane, use pre_register_codex_pane instead.',
      })
    }
    if (value.agent_type === 'opencode') {
      if (value.base_url === undefined || value.base_url.trim().length === 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['base_url'],
          message:
            'base_url is required when agent_type="opencode". '
            + 'Read it from $OPENCODE_XATS_BASE_URL (set by the free-xats-opencode launcher).',
        })
      } else {
        let parsedUrl: URL | null = null
        try { parsedUrl = new URL(value.base_url) } catch { /* invalid */ }
        if (!parsedUrl || (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:')) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['base_url'],
            message: 'base_url must be a parseable http:// or https:// URL when agent_type="opencode".',
          })
        }
      }
      if (value.session_id !== undefined && value.session_id.trim().length > 0) {
        if (!value.session_id.startsWith('ses')) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['session_id'],
            message: 'session_id must start with "ses" when supplied for agent_type="opencode".',
          })
        }
      }
    }
    if (value.base_url !== undefined && value.agent_type !== 'opencode') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['agent_type'],
        message: 'agent_type=opencode is required when base_url is provided',
      })
    }
    if (value.session_id !== undefined && value.agent_type !== 'opencode') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['agent_type'],
        message: 'agent_type=opencode is required when session_id is provided',
      })
    }
  })

  async function executeRegister(
    args: {
      agent_type?: AgentType
      agent_type_name?: string
      model?: string
      device?: string
      name: string
      role?: string
      team?: string
      project_dir?: string
      ui_pid?: number
      channel_session_id?: string
      thread_id?: string
      ws_url?: string
      auth_token_ref?: string
      base_url?: string
      session_id?: string
      claude_ui_pid?: number
      delivery?: { kind: string; [key: string]: unknown }
    }
  ): Promise<unknown> {
    let nativeDeliveryBound = suppressTmuxHint(args)
    let autoBoundChannelCsid: string | undefined
    const bindChannelSvc = channelWakeFanout
      ? new BindChannelService(db, channelWakeFanout)
      : undefined
    const autoBindChannelSvc = channelWakeFanout
      ? new AutoBindChannelService(db, channelWakeFanout)
      : undefined
    if (args.agent_type === 'claude-code' && args.model === undefined) {
      args.model = defaultClaudeSelfModel(getSessionClientInfo?.())
    }
    if (args.agent_type === 'codex' && args.ws_url === undefined) {
      args.ws_url = ''
    }
    if (args.agent_type === 'codex' && args.model === undefined) {
      args.model = 'gpt'
    }
    const connectionId = getSessionId?.() ?? caller()
    if (!connectionId) return { error: 'unknown_agent' }
    const uiPidClientError = await preflightUiPidClient(args)
    if (uiPidClientError) return uiPidClientError

    // opencode HTTP branch: register via the opencode-server delivery path.
    // Bypasses channel auto-bind and tmux runtime auto-bind because the
    // opencode-server transport is HTTP-based, not tmux-based.
    if (args.agent_type === 'opencode' && args.base_url !== undefined) {
      const opencodeRes = await registerOpencodeSelfSvc.register({
        connection_id: connectionId,
        name: args.name,
        device: args.device,
        model: args.model,
        role: args.role,
        team: args.team,
        project_dir: args.project_dir,
        base_url: args.base_url,
        session_id: args.session_id,
        auth_token_ref: args.auth_token_ref,
      })
      if ('agent_id' in opencodeRes) {
        if (onRegisterSuccess) {
          try { onRegisterSuccess(opencodeRes.agent_id, opencodeRes.team) } catch { /* best-effort */ }
        } else if (fanout) {
          try { fanout.rebind(opencodeRes.agent_id, opencodeRes.team) } catch { /* best-effort */ }
        }
      }
      return opencodeRes
    }
    if (
      args.agent_type === 'claude-code' &&
      args.channel_session_id !== undefined &&
      args.ui_pid !== undefined &&
      autoBindChannelSvc
    ) {
      const effectiveDevice = resolveEffectiveDevice({
        requestedDevice: args.device ?? undefined,
        originInfo: getSessionOriginInfo?.(),
        localDevice: context?.localDevice ?? 'local',
      })
      if ('error' in effectiveDevice) return effectiveDevice
      const proxyLookup = autoBindChannelSvc.lookup({
        ui_pid: args.ui_pid,
        device: effectiveDevice.ok,
      })
      if (
        proxyLookup.ok &&
        proxyLookup.channel_session_id !== args.channel_session_id
      ) {
        return {
          error: 'channel_session_id_ui_pid_mismatch',
          detail: {
            ui_pid_matched_csid: proxyLookup.channel_session_id,
            supplied_csid: args.channel_session_id,
          },
        }
      }
    }
    const hasCodexTransportFields =
      args.thread_id !== undefined ||
      args.ws_url !== undefined ||
      args.auth_token_ref !== undefined
    const res =
      args.agent_type === 'codex' &&
      args.delivery === undefined &&
      hasCodexTransportFields
        ? await registerCodexSelfSvc.register({
            connection_id: connectionId,
            device: args.device,
            name: args.name,
            model: args.model,
            role: args.role,
            team: args.team,
            project_dir: args.project_dir,
            thread_id: args.thread_id,
            ws_url: args.ws_url,
            auth_token_ref: args.auth_token_ref,
          })
        : registerSvc.register({
            connection_id: connectionId,
            agent_type: args.agent_type,
            agent_type_name: args.agent_type_name,
            model: args.model,
            device: args.device,
            name: args.name,
            role: args.role,
            team: args.team,
            project_dir: args.project_dir,
            delivery: args.delivery,
            claude_ui_pid: args.claude_ui_pid,
            runtime_ui_pid:
              args.agent_type === 'claude-code' ? args.ui_pid : undefined,
          })
    if ('thread_id' in res && 'agent_id' in res) {
      nativeDeliveryBound = true
    }
    if ('agent_id' in res) {
      if (onRegisterSuccess) {
        try { onRegisterSuccess(res.agent_id, res.team) } catch { /* best-effort */ }
      } else if (fanout) {
        try { fanout.rebind(res.agent_id, res.team) } catch { /* best-effort */ }
      }
      if (args.agent_type === 'claude-code' && args.channel_session_id !== undefined) {
        const channelBind = bindChannelSvc
          ? bindChannelSvc.bind({
              callerAgentId: res.agent_id,
              channel_session_id: args.channel_session_id,
            })
          : { error: 'unknown_channel_session' as const }
        if ('ok' in channelBind && channelBind.ok) {
          nativeDeliveryBound = true
        } else {
          return channelBind
        }
      }
      if (
        args.agent_type === 'claude-code' &&
        args.channel_session_id === undefined &&
        args.ui_pid !== undefined &&
        autoBindChannelSvc
      ) {
        const callerRow = agents.findById(res.agent_id)
        const autoBind = autoBindChannelSvc.run({
          callerAgentId: res.agent_id,
          ui_pid: args.ui_pid,
          device: callerRow?.device,
        })
        if (autoBind.ok) {
          autoBoundChannelCsid = autoBind.channel_session_id
          nativeDeliveryBound = true
        }
      }
      const autoBound = await autoBindRuntimeIdentity(args, res.agent_id)
      const envelope = autoBoundChannelCsid !== undefined
        ? { ...res, channel_session_id: autoBoundChannelCsid }
        : res
      if (autoBound) return envelope
      if (!nativeDeliveryBound) {
        return {
          ...envelope,
          hint: "No usable tmux_pane_id is bound yet — automatic runtime binding did not converge for this session, so cross-agent poke delivery via tmux is still off. Call `bind_runtime_identity(...)` to bind explicitly, or use `detect_tmux_pane(...)` for debugging. Claude Code users who loaded the cross-agent-teams-mcp channel plugin can also route pokes via channel_session_id — that path does not require tmux binding."
        }
      }
      return envelope
    }
    return res
  }

  function releaseRegisteredState(agentId: string): void {
    const connectionId = getSessionId?.()
    if (connectionId) registerSvc.releaseConnection(agentId, connectionId)
    if (onUnregisterSuccess) {
      try { onUnregisterSuccess(agentId) } catch { /* best-effort */ }
      return
    }
    if (fanout) {
      try { fanout.detach(agentId) } catch { /* best-effort */ }
    }
  }

  // pre_register_codex_pane — callable by launchers before any agent row exists
  server.registerTool(
    'pre_register_codex_pane',
    {
      title: 'Pre-register codex tmux pane',
      description: [
        'Pre-register a pending tmux-pane claim so the launcher can claim a tmux pane before starting codex.',
        'The launcher should call this with `$TMUX_PANE` and a freshly generated UUID, then `exec codex --remote ... -c xats.agent_id="\\"<uuid>\\""`.',
        'When the codex agent later calls `register_agent({agent_type:"codex"})` without `ui_pid`, the daemon uses the pending row to resolve the correct UI pid and auto-bind the pane.',
        'Callable without a prior `register_agent` — launchers have no agent identity yet.',
        'TTL defaults to 120 seconds and is capped at 600; pending rows are garbage-collected opportunistically.',
      ].join(' '),
      inputSchema: preRegisterCodexPaneInputSchema,
    },
    async (args: unknown) => run(async () => preRegisterCodexPaneSvc.register(args))
  )

  // register_agent — bootstrap: callable before an agents row exists for this session
  server.registerTool(
    'detect_tmux_pane',
    {
      title: 'Detect tmux pane',
      description: [
        'Detect the tmux pane that is actually hosting a coding agent UI, even when the shell calling tools lives in a different pane.',
        'The detector scans tmux panes globally, maps each pane to its tty, then inspects real tty processes instead of trusting `$TMUX_PANE` or tmux focus state alone.',
        'Use `agent` to pick a built-in matcher for Codex, Claude Code, or opencode.',
        'Optional `cwd`, `tty`, and `title_contains` narrow the search and make cross-directory multi-agent sessions much more reliable.',
        'Returns either a single best pane, or an ambiguity/not-found result with candidates for debugging.'
      ].join(' '),
      inputSchema: detectTmuxPaneSchema,
    },
    async (args: {
      agent: 'codex' | 'claude-code' | 'opencode' | 'custom'
      cwd?: string
      tty?: string
      title_contains?: string
      process_pattern?: string
    }) => run(async () => {
      const parsed = detectTmuxPaneArgsSchema.safeParse(args)
      if (!parsed.success) {
        return {
          error: 'invalid_arguments' as const,
          detail: parsed.error.issues.map(issue => issue.message).join('; '),
        }
      }
      return detectTmuxPane({
        agent: parsed.data.agent,
        cwd: parsed.data.cwd,
        tty: parsed.data.tty,
        title_contains: parsed.data.title_contains,
        process_pattern: parsed.data.process_pattern,
      })
    })
  )

  server.registerTool(
    'register_agent',
    {
      title: 'Register agent',
      description: [
        'Register this session as an agent in a team. This is the unified registration entry point.',
        'DETECTION (run these probes BEFORE choosing `agent_type=`, in order; first match wins):',
        '1. `printenv OPENCODE_XATS_BASE_URL` non-empty → `agent_type="opencode"`; pass that value as `base_url`. Do NOT pass `session_id` — the daemon auto-resolves it as the most recently updated session on that base_url. The env var is set ONLY by the `free-xats-opencode` launcher, so its presence is itself the runtime assertion that the caller is opencode.',
        '2. `printenv CODEX_THREAD_ID` non-empty → `agent_type="codex"`; pass that value as `thread_id` (REQUIRED for codex per the schema). Do NOT pass `ui_pid` (the launcher\'s `pre_register_codex_pane` flow handles tmux pane binding; supplying `ui_pid` from codex disables that auto-bind path).',
        '3. `printenv CLAUDECODE` non-empty OR `printenv CLAUDE_CODE_ENTRYPOINT` non-empty → `agent_type="claude-code"`; pass `$PPID` as `ui_pid` to enable channel auto-bind.',
        '4. None of the above → `agent_type="custom"` with `agent_type_name="<the harness you are running under, e.g. cursor, opencode, ...>"` (`agent_type_name` is required when `agent_type="custom"`). Detect the harness name from your runtime environment if you can — e.g. `printenv CURSOR_TRACE_ID` non-empty means cursor — but do NOT guess from system-wide signals like "binary X exists on PATH": such probes detect what the user has installed, not what runtime you are inside, and pick the wrong agent type. When unsure, prefer `agent_type_name="unknown"` over a wrong guess.',
        'Calling this tool again with the same `(device, team, name)` identity reuses the existing `agent_id` and refreshes `tmux_pane_id` and `model`; no duplicate row is created.',
        'Use `agent_type="custom"` for unsupported agent harnesses; provide `agent_type_name` for observability.',
        'opencode sessions: pass `agent_type="opencode"` and `base_url` (from `$OPENCODE_XATS_BASE_URL`, set by the `free-xats-opencode` launcher). Omit `session_id` — the daemon auto-resolves it via `<base_url>/session` (most recently updated). `auth_token_ref` is optional; set only when `OPENCODE_SERVER_PASSWORD` is configured on the opencode server. The schema REQUIRES `base_url` (parseable `http://` or `https://` URL) when `agent_type="opencode"`; missing/malformed `base_url` is rejected before any HTTP probe runs.',
        'Claude Code sessions: pass `agent_type="claude-code"` and PREFERRED: pass only `ui_pid` (from `$PPID`) so the daemon auto-binds channel delivery — do not pass `channel_session_id` explicitly. When BOTH `ui_pid` AND `channel_session_id` are supplied, the daemon runs a consistency check against the caller `ui_pid`\'s live channel proxy; if the proxy\'s csid does not match the supplied `channel_session_id`, the call is rejected with `channel_session_id_ui_pid_mismatch` before any agent row is written. To re-establish a prior identity on a fresh/resumed session where you no longer remember your (team, name) (changed csid, unchanged $PPID), prefer `reconnect({ ui_pid })` over the bind_channel→register fallback; `bind_channel` only rebinds a session already bound to your agent. If instead you still remember your (team, name) after a restart + resume (changed $PPID), call register_agent directly with that remembered (team, name) and the current $PPID rather than reconnect.',
        'Codex sessions: pass `agent_type="codex"` and `thread_id` (from `$CODEX_THREAD_ID`) to register Codex app-server delivery. The schema REQUIRES `thread_id` when `agent_type="codex"`; missing or empty `thread_id` is rejected before any handshake runs. Launcher pre-reg callers without `thread_id` should use `pre_register_codex_pane` instead. `ws_url` defaults to `ws://127.0.0.1:8799` (env override `CROSS_AGENT_TEAMS_CODEX_WS_URL`); `model` defaults to `gpt` when omitted. For `agent_type="claude-code"` callers, `model` defaults to a Claude-specific value derived from MCP session client info when omitted.',
        '`model` is OPTIONAL for any agent_type: omit it when you do not have an authoritative model identifier; the daemon stores NULL in that case. Pass an explicit `model` only when you have a stable identifier you would like surfaced via `list_agents`.',
        'Requests such as "register to xats" or "register to cross-agent-teams" refer to this MCP service, not to the `team` field; do not set `team` to `xats` or `cross-agent-teams` from those phrases.',
        'Do not treat the bare word "register" as a request for this tool unless the current conversation is already about cross-agent-teams registration.',
        'If the user writes an identity in the shorthand `name(team)` (e.g. `skills-creator(default)` means name=`skills-creator`, team=`default`), split it into the separate `name` and `team` arguments. The daemon does NOT parse `name(team)`; passing the literal string as `name` registers a malformed identity (the parentheses are not rejected).',
        'When the end user has not explicitly specified `team`, callers should pass `project_dir` as the current working directory so the daemon derives a project-scoped default team from its basename; if omitted, it falls back to `default`.',
        'REPORTING RULE: on success the response carries the actual `team` the daemon assigned. When summarizing the registration to the user, surface that returned `team` value verbatim; NEVER derive or paraphrase the team from `project_dir`, cwd, or your own pre-call assumption. Failing to read the response masks the daemon\'s `default` fallback (e.g. when `project_dir` was forgotten) and produces misleading "team: X (from cwd basename)" reports that break later cross-team send_message diagnostics.',
        '`agent_type` must describe the runtime behind `ui_pid`, not merely the current MCP caller. For example, if `ui_pid` points at an external editor process, pass `agent_type="custom"` with `agent_type_name=<editor>` even when the registration request is issued from a different harness.',
        'STRONGLY RECOMMENDED: pass `ui_pid` unless it is truly unobtainable (codex and opencode callers excepted). Without it, automatic runtime binding usually fails to converge and tmux-based cross-agent poke delivery stays off until a separate `bind_runtime_identity(...)` call. From Claude Code, `$PPID` inside a Bash tool call is the `claude` CLI pid. With `ui_pid` the daemon binds via verified pid → tty → pane evidence in one shot.',
        'After registration, the daemon best-effort attempts runtime binding for recognized local clients so tmux-based poke delivery can come up without a second tool call.',
        'If automatic runtime binding does not converge, call `bind_runtime_identity(...)` explicitly so the daemon can verify and persist your pane binding.',
        '`detect_tmux_pane(...)` remains available as a debugging aid for ambiguous or missing matches, but it does not write registry state by itself.',
        'When registration still has no usable `tmux_pane_id`, tmux-based poke delivery stays unavailable until automatic or explicit runtime binding succeeds.'
      ].join(' '),
      inputSchema: registerAgentInputSchema
    },
    async (args: {
      agent_type: AgentType
      agent_type_name?: string
      device?: string
      model?: string; name: string; role?: string; team?: string;
      project_dir?: string;
      ui_pid?: number;
      channel_session_id?: string
      thread_id?: string
      ws_url?: string
      auth_token_ref?: string
      base_url?: string
      session_id?: string
      claude_ui_pid?: number
      delivery?: { kind: string; [key: string]: unknown }
    }) => {
      return run(async () => executeRegister(registerAgentArgsSchema.parse(args)))
    }
  )

  const reconnectInputSchema = z.object({
    ui_pid: z.number().int().positive().describe(
      'The Claude UI process id (`$PPID` from a Bash tool call inside Claude Code). The daemon reverse-looks-up the prior local claude-code identity registered under this runtime_ui_pid.'
    ),
  }).strict()

  async function executeReconnect(ui_pid: number): Promise<unknown> {
    const resolution = resolveReconnect(agents, ui_pid, context?.localDevice ?? 'local')
    if (resolution.kind === 'need_register') {
      return { need_register: true, reason: resolution.reason }
    }
    if (resolution.kind === 'ambiguous') {
      return {
        ambiguous: true,
        candidates: resolution.candidates.map(c => ({
          agent_id: c.agent_id,
          name: c.name,
          team: c.team,
          device: c.device,
          role: c.role,
          last_seen_at: c.last_seen_at,
        })),
      }
    }
    // Single match: drive the existing register/takeover/auto-bind path using the
    // recovered identity. The recovered (device, team, name) replaces any
    // caller-provided name, and ui_pid re-arms channel + runtime-pane auto-bind.
    const match = resolution.match
    const res = await executeRegister({
      agent_type: 'claude-code',
      name: match.name,
      team: match.team,
      device: match.device,
      role: match.role,
      ui_pid,
    })
    if (typeof res !== 'object' || res === null || !('agent_id' in res)) {
      return res
    }
    const envelope = res as {
      agent_id: string
      team: string
      channel_session_id?: string
    }
    return {
      ok: true,
      agent_id: envelope.agent_id,
      name: match.name,
      team: envelope.team,
      channel_session_id: envelope.channel_session_id ?? null,
      last_seen_at: match.last_seen_at,
    }
  }

  server.registerTool(
    'reconnect',
    {
      title: 'Reconnect to xats by ui_pid',
      description: RECONNECT_DESC,
      inputSchema: reconnectInputSchema,
    },
    async (args: { ui_pid: number }) => {
      return run(async () => executeReconnect(reconnectInputSchema.parse(args).ui_pid))
    }
  )

  server.registerTool(
    'unregister_self',
    {
      title: 'Unregister current agent',
      description: [
        'Remove the caller session\'s current agent registration.',
        'This tool only unregisters the currently bound agent identity; it does not delete other agents.',
        'On success it deletes the agent row and immediately releases the current MCP session back to an unregistered state.'
      ].join(' '),
      inputSchema: z.object({}).strict()
    },
    async () => {
      const who = requireAgent()
      if (typeof who !== 'string') return toText(who)
      const result = await wrapStorage(() => unregisterSelfSvc.unregister({ caller: who }))
      if (
        typeof result === 'object' &&
        result !== null &&
        'ok' in result &&
        result.ok === true &&
        'agent_id' in result &&
        typeof result.agent_id === 'string'
      ) {
        releaseRegisteredState(result.agent_id)
        return toText(result)
      }
      touchIfRegistered()
      return toText(result)
    }
  )

  // list_agents
  server.registerTool(
    'list_agents',
    {
      title: 'List agents',
      description: [
        'List agents in the caller\'s team across all devices. Scope is caller-team only: this tool CANNOT see cross-team agents and MUST NOT be used to verify whether a cross-team recipient exists.',
        'DO NOT call list_agents as a pre-flight / pre-verify / pre-check step before send_message — neither for same-team nor for cross-team sends. For cross-team targets the pre-check will always falsely report "missing" because list_agents is caller-team scoped; for same-team targets the pre-check is pure waste.',
        'The canonical miss signal is the unknown_recipient error returned by send_message itself. The correct pattern is "try send, then handle unknown_recipient" — never "list_agents first, then send".'
      ].join(' '),
      inputSchema: {}
    },
    async () => {
      const who = requireAgent()
      if (typeof who !== 'string') return toText(who)
      const row = agents.findById(who)!
      return run(() => listAgentsForTeam(db, row.team))
    }
  )

  // send_message (by name)
  server.registerTool(
    'send_message',
    {
      title: 'Send message',
      description: SEND_MESSAGE_DESC,
      inputSchema: z.object({
        to_agent_name: z.string().min(1),
        to_team: z.string().min(1).optional(),
        subject: z.string().optional(),
        body: z.string().min(1),
        auto_poke: z.boolean().optional(),
        need_reply: z.boolean().optional()
      }).strict()
    },
    async (args: {
      to_agent_name: string
      to_team?: string
      subject?: string
      body: string
      auto_poke?: boolean
      need_reply?: boolean
    }) => {
      const who = requireAgent()
      if (typeof who !== 'string') return toText(who)
      return run(() => sendSvc.send({ from: who, ...args }))
    }
  )

  // send_message_by_id (by UUID)
  server.registerTool(
    'send_message_by_id',
    {
      title: 'Send message by id',
      description: SEND_MESSAGE_BY_ID_DESC,
      inputSchema: z.object({
        to_agent_id: z.string().min(1),
        subject: z.string().optional(),
        body: z.string().min(1),
        auto_poke: z.boolean().optional(),
        need_reply: z.boolean().optional()
      }).strict()
    },
    async (args: {
      to_agent_id: string
      subject?: string
      body: string
      auto_poke?: boolean
      need_reply?: boolean
    }) => {
      const who = requireAgent()
      if (typeof who !== 'string') return toText(who)
      return run(() => sendSvc.send({ from: who, ...args }))
    }
  )

  // broadcast
  server.registerTool(
    'broadcast',
    {
      title: 'Broadcast message',
      description: BROADCAST_DESC,
      inputSchema: {
        subject: z.string().optional(),
        body: z.string(),
        auto_poke: z.boolean().optional()
      }
    },
    async (args: { subject?: string; body: string; auto_poke?: boolean }) => {
      const who = requireAgent()
      if (typeof who !== 'string') return toText(who)
      return run(() => broadcastSvc.broadcast({ from: who, ...args }))
    }
  )

  // broadcast_to_role
  server.registerTool(
    'broadcast_to_role',
    {
      title: 'Broadcast to role',
      description: BROADCAST_TO_ROLE_DESC,
      inputSchema: z.object({
        to_role: z.string().min(1),
        subject: z.string().optional(),
        body: z.string().min(1),
        auto_poke: z.boolean().optional()
      }).strict()
    },
    async (args: { to_role: string; subject?: string; body: string; auto_poke?: boolean }) => {
      const who = requireAgent()
      if (typeof who !== 'string') return toText(who)
      return run(() => broadcastToRoleSvc.broadcast({ from: who, ...args }))
    }
  )

  // get_inbox
  server.registerTool(
    'get_inbox',
    {
      title: 'Get inbox',
      description: [
        'Return messages addressed to the caller (by agent_id or matching role) within the caller team.',
        'Default behaviour (since_event_id omitted): the daemon reads the caller\'s server-side cursor (`agents.last_processed_event_id`), returns mail past it, and ADVANCES the cursor to the highest returned event_id in the same transaction. Subsequent default calls return only newer mail.',
        'Pagination via `limit` advances the cursor only to the last RETURNED event_id; the next default call resumes from there.',
        'Explicit `since_event_id` (any number, including 0) is read-only inspection: the daemon uses the supplied value as the lower bound and does NOT advance the stored cursor — useful for re-reading history or debugging without disturbing live read position.',
        'REPLY GUIDANCE: every returned message carries `from_agent_id`, `from_name`, and `from_device` for the sender. When replying via `send_message`, construct `to_agent_name` as `from_name + ":" + from_device` whenever `from_device !== <your own device>` — otherwise the daemon resolves the bare name on YOUR device, misses the cross-device sender, and returns `unknown_recipient`. Bare `from_name` is correct only when `from_device === <your own device>`. `send_message_by_id({to_agent_id: from_agent_id, ...})` always works regardless of device and is the safe fallback when device is unknown.',
        'Retention: messages older than 30 days are deleted by the cleanup routine regardless of read state. Agents that go offline for more than 30 days forfeit any unread mail in that window.'
      ].join(' '),
      inputSchema: {
        since_event_id: z.number().int().optional(),
        limit: z.number().int().optional()
      }
    },
    async (args: { since_event_id?: number; limit?: number }) => {
      const who = requireAgent()
      if (typeof who !== 'string') return toText(who)
      return run(() => inboxSvc.get({ caller: who, ...args }))
    }
  )

  // get_delivery_status
  server.registerTool(
    'get_delivery_status',
    {
      title: 'Get delivery status',
      description: [
        'Return wake-hint delivery status for a message sent by caller.',
        'Status describes auto-poke delivery only; mailbox persistence is already complete.',
        'Only the original sender can read a message delivery status.'
      ].join(' '),
      inputSchema: {
        message_id: z.string()
      }
    },
    async (args: { message_id: string }) => {
      const who = requireAgent()
      if (typeof who !== 'string') return toText(who)
      return run(() => deliveryStatusSvc.get({ caller: who, ...args }))
    }
  )

  // bind_channel — self-binding: caller (Claude host) writes its own channel_session_id
  if (channelWakeFanout) {
    const bindSvc = new BindChannelService(db, channelWakeFanout)
    server.registerTool(
      'bind_channel',
      {
        title: 'Bind channel_session_id to caller',
        description: [
          'Low-level rebind tool for Claude channel delivery.',
          'Bind the caller session\'s agent row to a channel_session_id produced by the cross-agent-teams-mcp channel proxy.',
          'Most callers should prefer `register_agent({ agent_type: "claude-code", channel_session_id, ... })` on the unified registration path.',
          'Call this when you need to rebind an already-registered row after the proxy announces a new csid AND your current MCP session is already bound to your agent.',
          'On a fresh or resumed MCP session (e.g. after a context clear or resume) the daemon has not yet associated this session with your agent, so bind_channel returns unknown_agent — use reconnect({ ui_pid: $PPID }) instead, which recovers your identity by process id and rebinds the channel in one step.',
          'Rejects proxy callers (role=__channel_proxy__).',
          'Rejects unknown csid (no live proxy sink attached).'
        ].join(' '),
        inputSchema: {
          channel_session_id: z.string().min(1)
        }
      },
      async (args: { channel_session_id: string }) => {
        const who = requireAgent()
        if (typeof who !== 'string') return toText(who)
        return run(() => bindSvc.bind({
          callerAgentId: who,
          channel_session_id: args.channel_session_id
        }))
      }
    )
  }

  server.registerTool(
    'bind_runtime_identity',
    {
      title: 'Bind runtime identity to caller',
      description: [
        'Bind the caller session\'s agent row to a verified tmux runtime identity.',
        'Pass `agent` to choose the built-in process matcher (`codex`, `claude-code`, `opencode`), or use `custom` together with `process_pattern`.',
        'Prefer passing `ui_pid` for the visible agent UI process; the daemon verifies pid → tty → pane before persisting `tmux_pane_id`.',
        'If `ui_pid` is unavailable, pass `ui_tty` together with `tmux_pane_id` for a weaker but still verified binding path.',
        'This tool writes registry state; `detect_tmux_pane` is for debugging only.'
      ].join(' '),
      inputSchema: bindRuntimeIdentitySchema,
    },
    async (args: {
      agent: 'codex' | 'claude-code' | 'opencode' | 'custom'
      ui_pid?: number
      ui_tty?: string
      tmux_pane_id?: string
      process_pattern?: string
    }) => {
      const parsed = bindRuntimeIdentityArgsSchema.safeParse(args)
      if (!parsed.success) {
        return toText({
          error: 'invalid_arguments',
          detail: parsed.error.issues.map(issue => issue.message).join('; '),
        })
      }
      const who = requireAgent()
      if (typeof who !== 'string') return toText(who)
      return run(() => bindRuntimeIdentitySvc.bind({
        callerAgentId: who,
        agent: parsed.data.agent,
        ui_pid: parsed.data.ui_pid,
        ui_tty: parsed.data.ui_tty,
        tmux_pane_id: parsed.data.tmux_pane_id,
        process_pattern: parsed.data.process_pattern,
      }))
    }
  )

  // subscribe_channel_wake — reserved for channel proxies (role=__channel_proxy__)
  if (channelWakeFanout) {
    const subscribeSvc = new SubscribeChannelWakeService(db, channelWakeFanout)
    server.registerTool(
      'subscribe_channel_wake',
      {
        title: 'Subscribe channel wake',
        description: [
          'Internal tool reserved for the cross-agent-teams-mcp channel proxy.',
          'Attaches the caller\'s MCP session notification sink to a channel_session_id so the',
          'daemon can emit notifications/channel_wake to it.  Requires role=__channel_proxy__.'
        ].join(' '),
        inputSchema: { channel_session_id: z.string().min(1) }
      },
      async (args: { channel_session_id: string }) => {
        const who = requireAgent()
        if (typeof who !== 'string') return toText(who)
        const sid = getSessionId?.()
        if (!sid) return toText({ error: 'unknown_session' })
        const sink = (payload: unknown) => {
          const t = getTransport?.()
          if (!t) return
          try {
            void Promise.resolve(t.send(payload as Record<string, unknown>)).catch(() => { /* best-effort */ })
          } catch { /* best-effort */ }
        }
        return run(() => subscribeSvc.subscribe({
          callerAgentId: who,
          channel_session_id: args.channel_session_id,
          sessionId: sid,
          sink
        }))
      }
    )
  }

}
