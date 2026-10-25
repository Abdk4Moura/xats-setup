import Fastify, { type FastifyInstance } from 'fastify'
import { createServer as createHttpServer, type Server as HttpServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { openDb } from '../storage/db.js'
import { applySchema } from '../storage/schema.js'
import { AgentsRepo } from '../storage/agents-repo.js'
import { ClaudeBindCapabilities } from '../mcp/claude-bind.js'
import { makeAuthHook } from './auth.js'
import { mountMcp } from '../mcp/transport.js'
import { mountRestApi } from './rest-api.js'
import { runCleanup } from './cleanup.js'
import { SseFanout } from './sse-fanout.js'
import { ChannelWakeFanout } from './channel-wake-fanout.js'
import { clearAllRetries } from '../mcp/poke-retry.js'
import { resolveLocalDeviceLabel } from './local-device.js'
import { bindHostCoversIpv4Loopback, classifyPeerAddress, type SessionOriginInfo } from './network-origin.js'

export interface ServerOpts {
  dbPath: string
  token?: string
  localDevice?: string
  cleanupIntervalMs?: number
  orphanGcIntervalMs?: number
  orphanGcIdleMs?: number
  orphanGcMaxAgeMs?: number
  orphanGcMaxSessions?: number
  mcpLog?: (line: string) => void
  fanout?: SseFanout
  channelWakeFanout?: ChannelWakeFanout
}
export interface StartOpts extends ServerOpts {
  port: number
  host?: string
  // When primary host is not loopback-covering, also bind 127.0.0.1 on the
  // same port so same-host clients can connect via loopback and get the
  // 'local' origin classification (which auto-fills the local device label
  // and skips the remote spoofing check). Default true. Set false to opt out.
  loopbackCompanion?: boolean
}

const DEFAULT_KEEP_ALIVE_TIMEOUT_MS = 120_000
const DEFAULT_ORPHAN_GC_INTERVAL_MS = 60_000
const DEFAULT_ORPHAN_GC_IDLE_MS = 300_000
const DEFAULT_ORPHAN_GC_MAX_AGE_MS = 300_000
const DEFAULT_ORPHAN_GC_MAX_SESSIONS = 500

export interface DaemonContext {
  localDevice: string
}

function parsePositiveInt(raw: string | undefined, fallback: number): number {
  const n = Number(raw)
  return Number.isInteger(n) && n > 0 ? n : fallback
}

export async function buildServer(opts: ServerOpts): Promise<FastifyInstance> {
  const keepAliveTimeout = parsePositiveInt(process.env.KEEP_ALIVE_TIMEOUT_MS, DEFAULT_KEEP_ALIVE_TIMEOUT_MS)
  const app = Fastify({ logger: false, keepAliveTimeout })
  app.server.headersTimeout = keepAliveTimeout + 1000
  const db = openDb(opts.dbPath)
  const context: DaemonContext = {
    localDevice: opts.localDevice ?? resolveLocalDeviceLabel(),
  }
  applySchema(db, { localDevice: context.localDevice })
  const claudeBind = new ClaudeBindCapabilities(db, context.localDevice)
  const startedAt = Date.now()
  const version = '0.1.0'
  const fanout = opts.fanout ?? new SseFanout()
  const channelWakeFanout = opts.channelWakeFanout ?? new ChannelWakeFanout()
  app.addHook('onRequest', makeAuthHook(opts.token))
  app.addHook('onRequest', async (req) => {
    ;(req as typeof req & { xatsPeer?: SessionOriginInfo }).xatsPeer =
      classifyPeerAddress(req.raw.socket.remoteAddress)
  })
  const orphanGcMaxSessions = opts.orphanGcMaxSessions
    ?? parsePositiveInt(process.env.ORPHAN_GC_MAX_SESSIONS, DEFAULT_ORPHAN_GC_MAX_SESSIONS)
  const mcp = mountMcp(app, db, fanout, channelWakeFanout, {
    context,
    log: opts.mcpLog,
    orphanSessionLimit: orphanGcMaxSessions,
    claudeBind,
  })
  // Loopback-only REST lifeboat. Mounted after the auth + origin-classification
  // onRequest hooks (above) and alongside mountMcp. Receives the same
  // channelWakeFanout used for send fan-out so /api/send pokes identically.
  mountRestApi(app, db, { channelWakeFanout, context, claudeBind })
  app.get('/health', async () => ({
    ok: true,
    version,
    uptime_seconds: Math.floor((Date.now() - startedAt) / 1000),
    mcp_sessions: mcp.sessionMetrics(),
  }))

  const cleanupIntervalMs = opts.cleanupIntervalMs
    ?? Number(process.env.CLEANUP_INTERVAL_MS ?? 60 * 60 * 1000)
  const interval = setInterval(() => {
    try { runCleanup(db) } catch { /* best-effort */ }
  }, cleanupIntervalMs)
  if (typeof interval.unref === 'function') interval.unref()

  const orphanGcIntervalMs = opts.orphanGcIntervalMs
    ?? parsePositiveInt(process.env.ORPHAN_GC_INTERVAL_MS, DEFAULT_ORPHAN_GC_INTERVAL_MS)
  const orphanGcIdleMs = opts.orphanGcIdleMs
    ?? parsePositiveInt(process.env.ORPHAN_GC_IDLE_MS, DEFAULT_ORPHAN_GC_IDLE_MS)
  const orphanGcMaxAgeMs = opts.orphanGcMaxAgeMs
    ?? parsePositiveInt(process.env.ORPHAN_GC_MAX_AGE_MS, DEFAULT_ORPHAN_GC_MAX_AGE_MS)
  const orphanGcInterval = setInterval(() => {
    try {
      mcp.reapOrphanSessions(Date.now(), {
        idleMs: orphanGcIdleMs,
        maxAgeMs: orphanGcMaxAgeMs,
        maxSessions: orphanGcMaxSessions,
      })
    } catch { /* best-effort */ }
  }, orphanGcIntervalMs)
  if (typeof orphanGcInterval.unref === 'function') orphanGcInterval.unref()

  // Agent TTL reaper: retain keyed Claude mailboxes as offline, deregister the rest.
  // REST-registered agents (delivery=none) have no persistent connection, so they
  // rely on periodic heartbeat (POST /api/heartbeat) to stay alive. Agents tied to
  // a persistent MCP session (channel_session_id) should be reaped on disconnect
  // by the transport layer; this is a safety net for missed disconnections.
  const agentTtlMs = parsePositiveInt(process.env.AGENT_TTL_MS, 180_000)
  const agentReapIntervalMs = parsePositiveInt(process.env.AGENT_REAP_INTERVAL_MS, 60_000)
  const agentsRepo = new AgentsRepo(db)
  const agentReaper = setInterval(() => {
    try {
      const cutoff = new Date(Date.now() - agentTtlMs).toISOString()
      const count = agentsRepo.deleteOlderThan(cutoff)
      if (count > 0) {
        console.log(`[reaper] removed ${count} stale agent(s) older than ${agentTtlMs}ms`)
      }
    } catch { /* best-effort */ }
  }, agentReapIntervalMs)
  if (typeof agentReaper.unref === 'function') agentReaper.unref()

  app.addHook('onClose', async () => {
    clearInterval(interval)
    clearInterval(orphanGcInterval)
    clearInterval(agentReaper)
    clearAllRetries()
    fanout.stopAll()
    db.close()
  })
  return app
}

export interface StartServerResult {
  app: FastifyInstance
  port: number
  host: string
  loopbackCompanion?: HttpServer
}

export async function startServer(opts: StartOpts): Promise<StartServerResult> {
  const app = await buildServer(opts)
  const host = opts.host ?? '127.0.0.1'

  // Hook for the loopback companion's graceful close. Registered BEFORE
  // app.listen (Fastify seals hooks once listening). The ref is filled in
  // after the companion successfully binds; if no companion is created the
  // hook is a no-op.
  const companionRef: { server: HttpServer | undefined } = { server: undefined }
  app.addHook('onClose', async () => {
    const server = companionRef.server
    if (!server) return
    await new Promise<void>((resolve) => {
      server.close(() => resolve())
    })
  })

  await app.listen({ port: opts.port, host })
  const addr = app.server.address()
  const port = addr && typeof addr === 'object' ? addr.port : opts.port

  const companionEnabled = opts.loopbackCompanion !== false
  if (companionEnabled && !bindHostCoversIpv4Loopback(host)) {
    const handler = app.server.listeners('request')[0] as
      | ((req: IncomingMessage, res: ServerResponse) => void)
      | undefined
    if (!handler) {
      await app.close()
      throw new Error('loopback_companion_no_handler: Fastify did not expose a request handler')
    }
    const companion = createHttpServer(handler)
    try {
      await new Promise<void>((resolve, reject) => {
        const onErr = (err: Error): void => reject(err)
        companion.once('error', onErr)
        companion.listen(port, '127.0.0.1', () => {
          companion.removeListener('error', onErr)
          resolve()
        })
      })
    } catch (err) {
      try { companion.close() } catch { /* best-effort */ }
      await app.close()
      const detail = err instanceof Error ? err.message : String(err)
      throw new Error(`loopback_companion_bind_failed: ${detail}`)
    }
    companionRef.server = companion
  }

  return { app, port, host, loopbackCompanion: companionRef.server }
}
