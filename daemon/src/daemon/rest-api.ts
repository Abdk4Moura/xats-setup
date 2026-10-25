import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify'
import type Database from 'better-sqlite3'
import { z } from 'zod'
import { AgentsRepo, type RegisterInput as AgentsRegisterInput } from '../storage/agents-repo.js'
import { EventsOutbox } from '../storage/events-outbox.js'
import { SendMessageService, type SendInput } from '../mcp/send-message.js'
import { GetInboxService } from '../mcp/get-inbox.js'
import { createAutoPokeImpl } from '../mcp/tools.js'
import { listAgentsForTeam, listAllAgents } from '../mcp/list-agents.js'
import { validateDeliveryForWrite } from '../lib/delivery-spec.js'
import { validateNameLabel, validateTeamLabel, resolveEffectiveDevice } from '../mcp/register-agent.js'
import { wrapStorage } from './errors.js'
import type { ChannelWakeFanout } from './channel-wake-fanout.js'
import type { SessionOriginInfo } from './network-origin.js'
import type { DaemonContext } from './server.js'
import type { ClaudeBindCapabilities } from '../mcp/claude-bind.js'

// Loopback-only, sessionless REST lifeboat. It reuses the SAME service layer as
// the MCP tools (SendMessageService / GetInboxService / listAgentsForTeam) and
// resolves identity purely by (team, name) → agents row on the local device.
// It NEVER touches any MCP session, RegisterAgentService.connections, or any
// delivery/fanout/channel-wake binding — there is no code path from here into
// the session/register machinery (the no-session-side-effect invariant).
export interface RestApiDeps {
  channelWakeFanout?: ChannelWakeFanout
  context?: DaemonContext
  claudeBind?: ClaudeBindCapabilities
}

interface RestCtx {
  db: Database.Database
  localDevice: string
  agents: AgentsRepo
  sendSvc: SendMessageService
  inboxSvc: GetInboxService
  claudeBind?: ClaudeBindCapabilities
}

const identitySchema = z.object({
  team: z.string().min(1),
  name: z.string().min(1),
}).strict()

// `to` is EITHER an agent_id OR a (name, optional team) pair. `.strict()` on each
// branch makes a mixed object like `{ agent_id, name }` match neither branch and
// be rejected at the boundary, rather than silently dropping a field. `team` stays
// optional to preserve parity with the send_message tool (`to_team ?? fromTeam`).
const sendBodySchema = z.object({
  from: identitySchema,
  to: z.union([
    z.object({ agent_id: z.string().min(1) }).strict(),
    z.object({ name: z.string().min(1), team: z.string().min(1).optional() }).strict(),
  ]),
  subject: z.string().optional(),
  body: z.string().min(1),
  need_reply: z.boolean().optional(),
  auto_poke: z.boolean().optional(),
}).strict()

type SendBody = z.infer<typeof sendBodySchema>

function isErrorResult(value: unknown): value is { error: string } {
  return (
    typeof value === 'object' &&
    value !== null &&
    'error' in value &&
    typeof (value as { error: unknown }).error === 'string'
  )
}

function sendErrorStatus(error: string): number {
  if (error === 'unknown_recipient') return 404
  if (error === 'storage_unavailable') return 503
  return 400
}

function peerOrigin(req: FastifyRequest): SessionOriginInfo['origin'] | undefined {
  return (req as FastifyRequest & { xatsPeer?: SessionOriginInfo }).xatsPeer?.origin
}

// Origin is derived from the socket's peer address (see network-origin), never
// from a spoofable header, so a forged `X-Forwarded-For` cannot reach the API.
async function restLoopbackGate(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  if (!req.url.startsWith('/api/')) return
  if (peerOrigin(req) !== 'local') {
    await reply.code(403).send({ error: 'remote_forbidden' })
  }
}

function recipientFields(to: SendBody['to']): Pick<SendInput, 'to_agent_id' | 'to_agent_name' | 'to_team'> {
  if ('agent_id' in to) return { to_agent_id: to.agent_id }
  return { to_agent_name: to.name, to_team: to.team }
}

async function handleSend(ctx: RestCtx, req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const parsed = sendBodySchema.safeParse(req.body)
  if (!parsed.success) {
    return reply.code(400).send({
      error: 'invalid_request',
      detail: parsed.error.issues.map(i => i.message).join('; '),
    })
  }
  const data = parsed.data
  const fromRow = ctx.agents.findByIdentity({
    device: ctx.localDevice,
    team: data.from.team,
    name: data.from.name,
  })
  if (!fromRow) return reply.code(404).send({ error: 'unknown_sender' })

  const input: SendInput = {
    from: fromRow.agent_id,
    subject: data.subject,
    body: data.body,
    need_reply: data.need_reply,
    auto_poke: data.auto_poke,
    ...recipientFields(data.to),
  }
  const result = await wrapStorage(() => ctx.sendSvc.send(input))
  if (isErrorResult(result)) {
    return reply.code(sendErrorStatus(result.error)).send({ error: result.error })
  }
  return reply.send(result)
}

async function handleInbox(ctx: RestCtx, req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const query = req.query as Record<string, unknown>
  const team = typeof query.team === 'string' ? query.team : undefined
  const name = typeof query.name === 'string' ? query.name : undefined
  if (!team || !name) {
    return reply.code(400).send({ error: 'invalid_request', detail: 'team and name are required' })
  }
  let since_event_id: number | undefined
  if (query.since_event_id !== undefined) {
    const n = Number(query.since_event_id)
    if (!Number.isInteger(n)) {
      return reply.code(400).send({ error: 'invalid_request', detail: 'since_event_id must be an integer' })
    }
    since_event_id = n
  }
  const owner = ctx.agents.findByIdentity({ device: ctx.localDevice, team, name })
  if (!owner) return reply.code(404).send({ error: 'unknown_owner' })

  const result = await wrapStorage(() => ctx.inboxSvc.get({ caller: owner.agent_id, since_event_id }))
  if (isErrorResult(result)) {
    return reply.code(503).send({ error: result.error })
  }
  return reply.send(result)
}

async function handleCursor(ctx: RestCtx, req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const parsed = identityQuerySchema.safeParse(req.query)
  if (!parsed.success) {
    return reply.code(400).send({
      error: 'invalid_request',
      detail: parsed.error.issues.map(i => i.message).join('; '),
    })
  }
  const last_processed_event_id = ctx.agents.getLastProcessedEventId(parsed.data.agent_id)
  if (last_processed_event_id === undefined) return reply.code(404).send({ error: 'unknown_agent' })
  return reply.send({ last_processed_event_id })
}

async function handleAgents(ctx: RestCtx, req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const query = req.query as Record<string, unknown>
  const team = typeof query.team === 'string' ? query.team : undefined
  if (!team) {
    return reply.code(400).send({ error: 'invalid_request', detail: 'team is required' })
  }
  const result = await wrapStorage(() => listAgentsForTeam(ctx.db, team))
  if (isErrorResult(result)) {
    return reply.code(503).send({ error: result.error })
  }
  return reply.send(result)
}

const registerBodySchema = z.object({
  name: z.string().min(1),
  team: z.string().optional(),
  role: z.string().optional(),
  device: z.string().nullish(),
  agent_type: z.string().optional(),
  agent_type_name: z.string().optional(),
  model: z.string().optional(),
  name_mode: z.enum(['prefer', 'exact']).optional(),
  session_key: z.string().min(1).optional(),
  bind_mcp: z.boolean().optional(),
  delivery: z.unknown().optional(),
}).strict()

const deregisterBodySchema = z.object({
  agent_id: z.string().min(1),
  session_key: z.string().min(1).optional(),
  retain_mailbox: z.boolean().optional(),
}).strict()

const heartbeatBodySchema = z.object({
  agent_id: z.string().min(1),
}).strict()

const identityQuerySchema = z.object({
  agent_id: z.string().min(1),
}).strict()

type RegisterBody = z.infer<typeof registerBodySchema>

function agentTypeFromString(s: string | undefined): import('../lib/agent-type.js').AgentType | undefined {
  const known = ['opencode', 'claude-code', 'codex', 'custom'] as const
  if (s && (known as readonly string[]).includes(s)) return s as import('../lib/agent-type.js').AgentType
  return undefined
}

async function handleRegister(ctx: RestCtx, req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const parsed = registerBodySchema.safeParse(req.body)
  if (!parsed.success) {
    return reply.code(400).send({
      error: 'invalid_request',
      detail: parsed.error.issues.map(i => i.message).join('; '),
    })
  }
  const data = parsed.data
  if (data.bind_mcp && (data.agent_type !== 'claude-code' || !data.session_key || !ctx.claudeBind)) {
    return reply.code(400).send({ error: 'claude_bind_requires_session_key' })
  }

  const validName = validateNameLabel(data.name)
  if ('error' in validName) return reply.code(400).send({ error: validName.error })

  if (data.team !== undefined) {
    const validTeam = validateTeamLabel(data.team)
    if ('error' in validTeam) return reply.code(400).send({ error: validTeam.error })
  }

  const deviceResult = resolveEffectiveDevice({
    requestedDevice: data.device ?? undefined,
    localDevice: ctx.localDevice,
  })
  if ('error' in deviceResult) return reply.code(400).send({ error: deviceResult.error })

  let delivery: import('../lib/delivery-spec.js').DeliverySpec | undefined
  if (data.delivery !== undefined) {
    const validated = validateDeliveryForWrite(data.delivery)
    if ('error' in validated) return reply.code(400).send({ error: validated.error, reason: validated.reason })
    delivery = validated.ok
  }

  const input: AgentsRegisterInput = {
    name: data.name,
    team: data.team,
    role: data.role,
    device: deviceResult.ok,
    agent_type: agentTypeFromString(data.agent_type),
    agent_type_name: data.agent_type_name,
    model: data.model,
    name_mode: data.name_mode,
    session_key: data.session_key,
    delivery,
  }
  let result: ReturnType<typeof ctx.agents.register>
  try {
    result = ctx.agents.register(input)
  } catch (error) {
    const code = (error as { code?: string })?.code
    if (code === 'name_taken') {
      return reply.code(409).send({
        error: 'name_taken',
        name: data.name,
        detail: 'a live agent on this team already holds that name',
      })
    }
    throw error
  }
  if (data.bind_mcp) {
    const bind_token = ctx.claudeBind!.issue(result.agent_id, data.session_key!)
    return reply.send({ ...result, bind_token })
  }
  return reply.send(result)
}

async function handleDeregister(ctx: RestCtx, req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const parsed = deregisterBodySchema.safeParse(req.body)
  if (!parsed.success) {
    return reply.code(400).send({
      error: 'invalid_request',
      detail: parsed.error.issues.map(i => i.message).join('; '),
    })
  }
  const data = parsed.data
  if (data.retain_mailbox) {
    if (!data.session_key) return reply.code(400).send({ error: 'session_key_required' })
    const marked = ctx.agents.markClaudeSessionOffline(data.agent_id, data.session_key)
    if (!marked) return reply.code(404).send({ error: 'unknown_agent' })
    ctx.claudeBind?.revoke(data.agent_id)
    return reply.send({ ok: true })
  }
  const deleted = ctx.agents.deleteById(data.agent_id)
  if (!deleted) return reply.code(404).send({ error: 'unknown_agent' })
  ctx.claudeBind?.revoke(data.agent_id)
  return reply.send({ ok: true })
}

async function handleHeartbeat(ctx: RestCtx, req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const parsed = heartbeatBodySchema.safeParse(req.body)
  if (!parsed.success) {
    return reply.code(400).send({
      error: 'invalid_request',
      detail: parsed.error.issues.map(i => i.message).join('; '),
    })
  }
  const { agent_id } = parsed.data
  const row = ctx.agents.getById(agent_id)
  if (!row) return reply.code(404).send({ error: 'unknown_agent' })
  ctx.agents.touch(agent_id)
  return reply.send({ ok: true })
}

async function handleWhoami(ctx: RestCtx, req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const parsed = identityQuerySchema.safeParse(req.body)
  if (!parsed.success) {
    return reply.code(400).send({
      error: 'invalid_request',
      detail: parsed.error.issues.map(i => i.message).join('; '),
    })
  }
  const { agent_id } = parsed.data
  const row = ctx.agents.getById(agent_id)
  if (!row) return reply.code(404).send({ error: 'unknown_agent' })
  return reply.send({
    agent_id: row.agent_id,
    name: row.name,
    team: row.team,
    role: row.role,
    device: row.device,
    agent_type: row.agent_type,
    agent_type_name: row.agent_type_name,
    model: row.model,
    delivery_kind: row.delivery_kind,
    registered_at: row.registered_at,
    last_seen_at: row.last_seen_at,
  })
}

export function mountRestApi(
  app: FastifyInstance,
  db: Database.Database,
  deps: RestApiDeps = {}
): void {
  const agents = new AgentsRepo(db)
  const events = new EventsOutbox(db)
  const localDevice = deps.context?.localDevice ?? 'local'
  // Constructed exactly like the send_message tool in src/mcp/tools.ts so a REST
  // send pokes recipients identically (channel-wake / tmux / codex-appserver /
  // opencode-server are all resolved inside poke() from the target's delivery row).
  const autoPokeImpl = createAutoPokeImpl(db, agents, deps.channelWakeFanout)
  const sendSvc = new SendMessageService(db, agents, events, { poke: autoPokeImpl })
  const inboxSvc = new GetInboxService(db, agents)
  const ctx: RestCtx = { db, localDevice, agents, sendSvc, inboxSvc, claudeBind: deps.claudeBind }

  // Loopback gate for every /api/* route. Runs after the global token-auth and
  // origin-classification onRequest hooks registered in buildServer, so the order
  // is token (401) then loopback (403); a remote caller with a correct token still
  // gets 403 and no data-layer action runs (short-circuit in the gate).
  app.addHook('onRequest', restLoopbackGate)
  app.post('/api/send', (req, reply) => handleSend(ctx, req, reply))
  app.get('/api/inbox', (req, reply) => handleInbox(ctx, req, reply))
  app.get('/api/cursor', (req, reply) => handleCursor(ctx, req, reply))
  app.get('/api/agents', (req, reply) => handleAgents(ctx, req, reply))
  // Cross-team roster: used by peer federation to advertise what this bus has.
  app.get('/api/agents/all', (_req, reply) => {
    try {
      return reply.send(listAllAgents(ctx.db))
    } catch (error) {
      return reply.code(503).send({ error: 'storage_unavailable', detail: String((error as Error)?.message ?? error) })
    }
  })
  app.post('/api/register', (req, reply) => handleRegister(ctx, req, reply))
  app.post('/api/deregister', (req, reply) => handleDeregister(ctx, req, reply))
  app.post('/api/heartbeat', (req, reply) => handleHeartbeat(ctx, req, reply))
  app.post('/api/whoami', (req, reply) => handleWhoami(ctx, req, reply))
}
