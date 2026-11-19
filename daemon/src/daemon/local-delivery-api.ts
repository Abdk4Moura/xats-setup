import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import type Database from 'better-sqlite3'
import { z } from 'zod'
import { LocalDeliveryStore } from '../storage/local-delivery.js'
import { localArrivalHub } from './local-arrival.js'

const ackSchema = z.object({
  attempt_id: z.string().min(1).max(128),
  stage: z.enum(['host-queued', 'transport-written', 'inbox-consumed', 'held', 'refused', 'unknown', 'failed']),
}).strict()
const waitSchema = z.object({
  timeout_ms: z.coerce.number().int().min(0).max(20000).optional(),
}).strict()

// Called after mountRestApi installs its socket-derived loopback gate. Tokens
// authorize exactly one mailbox/generation, never arbitrary agent IDs or names.
export function mountLocalDeliveryApi(app: FastifyInstance, db: Database.Database): void {
  const store = new LocalDeliveryStore(db)
  const hub = localArrivalHub(db)
  const waiting = new Set<string>()
  let closing = false
  app.addHook('preClose', async () => { closing = true; hub.close() })

  function tokenOf(req: FastifyRequest): string | undefined {
    const token = req.headers['x-xats-delivery-token']
    return typeof token === 'string' && /^[A-Za-z0-9_-]{43}$/.test(token) ? token : undefined
  }
  function authenticated(req: FastifyRequest, reply: FastifyReply) {
    const token = tokenOf(req)
    const lease = token ? store.authenticate(token) : null
    if (!token || !lease) { void reply.code(401).send({ error: 'invalid_delivery_lease' }); return }
    return { token, lease }
  }

  app.post('/api/local-delivery/renew', async (req, reply) => {
    const auth = authenticated(req, reply)
    if (!auth) return
    const lease = store.renew(auth.token)
    if (!lease) return reply.code(401).send({ error: 'invalid_delivery_lease' })
    return reply.send({ generation: lease.generation, expiresAt: lease.expiresAt })
  })

  app.post('/api/local-delivery/ack', async (req, reply) => {
    const auth = authenticated(req, reply)
    if (!auth) return
    const parsed = ackSchema.safeParse(req.body)
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_delivery_ack' })
    const accepted = store.acknowledge(auth.token, { attemptId: parsed.data.attempt_id, stage: parsed.data.stage })
    if (!accepted) return reply.code(409).send({ error: 'stale_delivery_attempt' })
    hub.publish()
    return reply.send({ ok: true })
  })

  app.get('/api/local-delivery/wait', async (req, reply) => {
    const auth = authenticated(req, reply)
    if (!auth) return
    const parsed = waitSchema.safeParse(req.query)
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_delivery_wait' })
    // Bound outstanding waiters; a second waiter must not steal this one's
    // claim or grow an unbounded listener set. No token values in diagnostics.
    const key = `${auth.lease.agentId}:${auth.lease.generation}`
    if (waiting.has(key)) return reply.code(409).send({ error: 'delivery_wait_in_progress' })
    waiting.add(key)
    const abort = new AbortController()
    const onClose = () => { if (!reply.raw.writableEnded) abort.abort() }
    reply.raw.once('close', onClose)
    const deadline = Date.now() + (parsed.data.timeout_ms ?? 20000)
    try {
      while (!closing && !abort.signal.aborted) {
        const version = hub.version()
        const lease = store.authenticate(auth.token)
        if (!lease) return reply.code(401).send({ error: 'invalid_delivery_lease' })
        const hints = store.claim(auth.token)
        if (hints.length || Date.now() >= deadline) {
          return reply.send({ generation: lease.generation, hints: hints.map(hint => {
            // Broadcasts use one public send ID but distinct mailbox row IDs.
            const mailbox = db.prepare('SELECT id FROM messages WHERE event_id=? AND to_agent_id=? LIMIT 1')
              .get(hint.event_id, lease.agentId) as { id: string } | undefined
            return {
              message_id: mailbox?.id ?? hint.message_id, event_id: hint.event_id,
              attempt_id: hint.attempt_id, generation: hint.generation,
            }
          }) })
        }
        // A future commit wakes the waiter. Timeout is only connection upkeep;
        // mailbox scanning does not run on a timer in the idle steady state.
        await hub.wait(version, Math.min(deadline - Date.now(), 20000), abort.signal)
      }
      if (!abort.signal.aborted) return reply.code(503).send({ error: 'daemon_closing' })
    } finally {
      waiting.delete(key)
      reply.raw.removeListener('close', onClose)
    }
  })
}
