import test from 'node:test'
import assert from 'node:assert/strict'
import { __internals as mod, register } from '../assets/claude/mod/hooks/register.js'

const root = '/home/test/.xats/sessions/session-1'
const lease = { version: 1, agent_id: 'agent-1', token: 'a'.repeat(43), generation: 1, expiresAt: Date.now() + 120000 }
const hint = { message_id: 'message-7', event_id: 7, attempt_id: 'attempt-1', generation: 1 }
const message = { id: hint.message_id, event_id: 7, from_name: 'pi', subject: 'hello', body: 'SECRET BODY' }
function fake(options = {}) {
  const files = options.files ?? new Map([[`${root}.delivery.json`, JSON.stringify(lease)]])
  const requests = [], submits = [], timers = [], acks = []
  let ackFailures = options.ackFailures ?? 0
  const json = (data) => ({ ok: true, status: 200, text: JSON.stringify(data) })
  const $ = {
    env: { get: async (key) => ({ HOME: '/home/test', XATS_BASE: 'http://localhost:9100', XATS_LOCAL_DELIVERY: options.disabled ? '0' : '1' })[key] },
    fs: { read: async (file) => files.get(file), write: async (file, value) => { if (options.writeFails) throw new Error('secret error'); files.set(file, value) } },
    session: { id: async () => options.session ?? 'session-1' },
    clock: { after: (ms, fn) => timers.push({ ms, fn }), every: () => {} },
    command: { register: async () => {} },
    ui: { invalidate: () => {} },
    prompt: { submit: async (value) => { submits.push(value); if (options.throws) throw new Error('private-token'); return 'result' in options ? options.result : { ok: true } } },
    http: { fetch: async (url, init) => {
      requests.push({ url, init })
      if (options.fetch) {
        const response = await options.fetch(url, init, files);
        if (response !== undefined) return response;
      }
      if (url.includes('/local-delivery/')) assert.ok((options.tokens ?? [lease.token]).includes(init.headers['X-Xats-Delivery-Token']))
      if (url.includes('/api/agents')) return json({ agents: [{ agent_id: lease.agent_id, name: 'claude', session_key: options.session ?? 'session-1' }] })
      if (url.includes('/api/cursor')) return json({ last_processed_event_id: options.cursor ?? 0 })
      if (url.includes('/api/inbox')) {
        assert.ok(new URL(url).searchParams.has('since_event_id'))
        return json({ messages: (options.messages ?? [message]).filter((m) => m.event_id > Number(new URL(url).searchParams.get('since_event_id'))).slice(0, 50) })
      }
      if (url.includes('/wait?')) {
        if (options.waitStatus) return { ok: false, status: options.waitStatus, text: '{}' }
        return json({ generation: options.generation ?? 1, hints: options.hints ?? [hint] })
      }
      if (url.endsWith('/ack')) {
        acks.push(JSON.parse(init.body))
        if (ackFailures-- > 0) throw new Error('private-token')
        return json({ ok: true })
      }
      if (url.endsWith('/renew')) {
        if (options.renewStatus) return { ok: false, status: options.renewStatus, text: '{}' }
        return json({ generation: options.renewGeneration ?? 1, expiresAt: options.renewExpiry ?? Date.now() + 120000 })
      }
      return json({ ok: true })
    } },
  }
  return { $, files, submits, timers, requests, acks }
}
async function connect(f) { await mod.poll(f.$); assert.equal(mod.state().localOwned, true) }

test.beforeEach(() => mod.reset())

test('hint immediately submits only attributed notice; connected mode stops all normal polling', async () => {
  const f = fake()
  await connect(f)
  assert.equal(f.timers[0].ms, 0)
  await mod.localTick(f.$)
  assert.equal(f.submits.length, 1)
  assert.match(f.submits[0].text, /mcp__cross-agent-teams__get_inbox/)
  assert.doesNotMatch(f.submits[0].text, /SECRET BODY/)
  assert.equal(f.submits[0].asUser, undefined)
  assert.deepEqual(f.acks, [{ attempt_id: hint.attempt_id, stage: 'host-queued' }])
  const count = f.requests.length
  await mod.poll(f.$)
  await mod.deliver(f.$)
  assert.equal(f.requests.length, count)
})

for (const [label, options, stage] of [
  ['void success', { result: undefined }, 'transport-written'],
  ['explicit refusal', { result: { ok: false, stage: 'refused' } }, 'refused'],
  ['held approval', { result: { status: 'held' } }, 'held'],
  ['uncertain exception', { throws: true }, 'unknown'],
  ['unclassifiable failure', { result: { busy: true } }, 'unknown'],
  ['actual MCP read', { cursor: 7 }, 'inbox-consumed'],
]) test(`${label} reports only proven stage and never falls back or resubmits`, async () => {
  const f = fake(options)
  await connect(f)
  await mod.localTick(f.$)
  await mod.localTick(f.$) // deliberately replay identical claimed hint
  await mod.poll(f.$)
  await mod.deliver(f.$)
  assert.equal(f.acks[0].stage, stage)
  assert.equal(f.acks[1].stage, stage)
  assert.equal(f.submits.length, stage === 'inbox-consumed' ? 0 : 1)
  assert.doesNotMatch(JSON.stringify(mod.state()), /private-token/)
})

test('lost ack retries same attempt without another wait or host submission', async () => {
  const f = fake({ ackFailures: 1 })
  await connect(f)
  await mod.localTick(f.$)
  await mod.localTick(f.$)
  assert.equal(f.submits.length, 1)
  assert.deepEqual(f.acks[0], f.acks[1])
  assert.equal(f.requests.filter((r) => r.url.includes('/wait?')).length, 1)
})

test('accepted cursor and durable attempt survive restart and safely replay the ack', async () => {
  const f = fake()
  await connect(f)
  await mod.localTick(f.$)
  assert.equal(JSON.parse(f.files.get(`${root}.cursor.json`)).event_id, 7)
  mod.reset()
  const restarted = fake({ files: f.files })
  await connect(restarted)
  await mod.localTick(restarted.$)
  assert.equal(restarted.submits.length, 0)
  assert.equal(restarted.acks[0].stage, 'host-queued')
})

for (const stage of ['refused', 'unknown']) test(`${stage} journal prevents restart resubmission`, async () => {
  const f = fake(stage === 'unknown' ? { throws: true } : { result: { ok: false, stage: 'refused' } })
  await connect(f)
  await mod.localTick(f.$)
  mod.reset()
  const restarted = fake({ files: f.files })
  await connect(restarted)
  await mod.localTick(restarted.$)
  assert.equal(restarted.submits.length, 0)
  assert.equal(restarted.acks[0].stage, stage)
})

for (const stage of ['refused', 'unknown', 'held']) test(`${stage} cannot resubmit through replacement generation or legacy opt-out`, async () => {
  const f = fake(stage === 'unknown' ? { throws: true } : { result: stage === 'held' ? { status: 'held' } : { ok: false, stage: 'refused' } })
  await connect(f)
  await mod.localTick(f.$)
  f.files.set(`${root}.delivery.json`, JSON.stringify({ ...lease, generation: 2 }))
  mod.reset()
  const replacement = fake({ files: f.files, generation: 2, hints: [{ ...hint, attempt_id: 'new-attempt', generation: 2 }] })
  await connect(replacement)
  await mod.localTick(replacement.$)
  assert.equal(replacement.submits.length, 0)
  assert.equal(replacement.acks[0].stage, stage)
  mod.reset()
  const legacy = fake({ files: f.files, disabled: true })
  await mod.poll(legacy.$)
  await mod.deliver(legacy.$)
  assert.equal(legacy.submits.length, 0, 'transport opt-out must not bypass a prior host outcome')
  mod.reset()
  f.files.delete(`${root}.delivery.json`)
  const missing = fake({ files: f.files })
  await mod.poll(missing.$)
  assert.equal(mod.state().localOwned, true)
  assert.equal(missing.requests.some(r => r.url.includes('/api/inbox')), false)
})

test('malformed lease permits only preconnection polling and unsafe session paths are never read', async () => {
  const f = fake({ files: new Map([[`${root}.delivery.json`, '{broken']]) })
  await mod.poll(f.$)
  assert.equal(mod.state().localOwned, false)
  assert.equal(f.requests.some((r) => r.url.includes('/wait?')), false)
  mod.reset()
  const unsafe = fake({ session: '../escape' })
  unsafe.$.fs.read = async () => { throw new Error('must not read') }
  await mod.poll(unsafe.$)
  assert.equal(mod.state().localOwned, false)
})

test('stale generation never submits or acks and cannot enable polling', async () => {
  const f = fake({ generation: 2 })
  await connect(f)
  await mod.localTick(f.$)
  await mod.poll(f.$)
  assert.equal(f.submits.length, 0)
  assert.equal(f.acks.length, 0)
  assert.equal(f.requests.some((r) => r.url.includes('/api/inbox')), false)
  assert.equal(mod.state().localOwned, true)
})

test('stale hint generation is ignored even with a current wait generation', async () => {
  const f = fake({ hints: [{ ...hint, generation: 2 }] })
  await connect(f)
  await mod.localTick(f.$)
  assert.equal(f.submits.length, 0)
  assert.equal(f.acks.length, 0)
  assert.equal(mod.state().localOwned, true)
})

test('legacy accepted cursor suppresses a replay without claiming inbox consumption', async () => {
  const f = fake()
  f.files.set(`${root}.cursor.json`, JSON.stringify({ version: 1, agent_id: lease.agent_id, event_id: 7 }))
  await connect(f)
  await mod.localTick(f.$)
  assert.equal(f.submits.length, 0)
  assert.equal(f.acks[0].stage, 'transport-written')
})

test('uncertain wait permanently disables unsupported-server fallback', async () => {
  const options = { waitStatus: 503 }
  const f = fake(options)
  await connect(f)
  await mod.localTick(f.$)
  options.waitStatus = 404
  await mod.localTick(f.$)
  await mod.poll(f.$)
  assert.equal(mod.state().localOwned, true)
  assert.equal(f.requests.some((r) => r.url.includes('/api/inbox')), false)
})

test('renewal keeps same generation; stale renewal never enables fallback', async () => {
  const f = fake({ renewGeneration: 2 })
  await connect(f)
  await mod.renewLocal(f.$)
  assert.equal(mod.state().localOwned, true)
  assert.match(mod.state().localError, /renewal failed/)
})

test('authentication failure cannot fallback; old unsupported server may before connection', async () => {
  const f = fake({ waitStatus: 401 })
  await connect(f)
  await mod.localTick(f.$)
  await mod.poll(f.$)
  assert.equal(mod.state().localOwned, true)
  assert.equal(f.submits.length, 0)
  mod.reset()
  const old = fake({ waitStatus: 404 })
  await connect(old)
  await mod.localTick(old.$)
  assert.equal(mod.state().localOwned, false)
  await mod.poll(old.$)
  assert.ok(old.requests.some((r) => r.url.includes('/api/inbox')))
})

test('cursor write failure prevents submission and exposes actionable diagnostics without secrets', async () => {
  const f = fake({ writeFails: true })
  await connect(f)
  await mod.localTick(f.$)
  assert.equal(f.submits.length, 0)
  assert.match(mod.state().cursorError, /persistence failed/)
  assert.doesNotMatch(JSON.stringify(mod.state()), /secret error|private-token/)
})

test('two refusals remain suppressed after restart with local delivery disabled', async () => {
  const messages = [message, { ...message, id: 'message-8', event_id: 8 }]
  const options = { messages, result: { ok: false } }
  const f = fake(options)
  await connect(f)
  await mod.localTick(f.$)
  options.hints = [{ ...hint, message_id: 'message-8', event_id: 8, attempt_id: 'attempt-2' }]
  await mod.localTick(f.$)
  assert.equal(f.submits.length, 2)
  const saved = JSON.parse(f.files.get(`${root}.cursor.json`))
  assert.deepEqual(Object.keys(saved.local_outcomes), ['7', '8'])
  assert.equal(saved.local_delivery.event_id, 8)
  mod.reset()
  const legacy = fake({ files: f.files, disabled: true, messages })
  await mod.poll(legacy.$)
  await mod.deliver(legacy.$)
  assert.equal(legacy.submits.length, 0)
})

test('multipoint unknown journal survives later acceptance, replacement attempts and opt-out', async () => {
  const messages = [7, 8, 9, 10].map(event_id => ({ ...message, event_id, id: `message-${event_id}` }))
  const options = { messages, throws: true }
  const f = fake(options)
  await connect(f)
  for (const event_id of [7, 8, 9, 10]) {
    options.hints = [{ ...hint, event_id, message_id: `message-${event_id}`, attempt_id: `attempt-${event_id}` }]
    options.throws = event_id !== 10
    await mod.localTick(f.$)
  }
  assert.equal(JSON.parse(f.files.get(`${root}.cursor.json`)).event_id, 10)
  mod.reset()
  f.files.set(`${root}.delivery.json`, JSON.stringify({ ...lease, generation: 2 }))
  const replacementOptions = { files: f.files, messages, generation: 2 }
  const replacement = fake(replacementOptions)
  await connect(replacement)
  for (const event_id of [8, 7, 9]) {
    replacementOptions.hints = [{ ...hint, event_id, message_id: `message-${event_id}`, generation: 2, attempt_id: `new-${event_id}` }]
    await mod.localTick(replacement.$)
  }
  assert.deepEqual(replacement.acks.map(a => a.stage), ['unknown', 'unknown', 'unknown'])
  assert.equal(replacement.submits.length, 0)
  assert.deepEqual(Object.keys(JSON.parse(f.files.get(`${root}.cursor.json`)).local_outcomes), ['7', '8', '9'])
  mod.reset()
  const legacy = fake({ files: f.files, disabled: true, messages })
  await mod.poll(legacy.$)
  await mod.deliver(legacy.$)
  assert.equal(legacy.submits.length, 0)
})

test('legacy acceptance preserves older unresolved journal entries on disk', async () => {
  const f = fake({ disabled: true, messages: [message, { ...message, event_id: 9, id: 'message-9' }] })
  f.files.set(`${root}.cursor.json`, JSON.stringify({ version: 1, agent_id: lease.agent_id, event_id: 0,
    local_delivery: { ...hint, stage: 'refused' } }))
  await mod.poll(f.$)
  await mod.deliver(f.$)
  assert.equal(f.submits.length, 1)
  assert.doesNotMatch(f.submits[0].text, /#7 /)
  const saved = JSON.parse(f.files.get(`${root}.cursor.json`))
  assert.equal(saved.event_id, 9)
  assert.equal(saved.local_outcomes[7].stage, 'refused')
  assert.equal(saved.local_delivery.stage, 'refused')
})

test('single-attempt version 1 migration is retained alongside newer unresolved events', async () => {
  const f = fake({ result: { status: 'held' }, messages: [{ ...message, event_id: 8, id: 'message-8' }],
    hints: [{ ...hint, event_id: 8, message_id: 'message-8', attempt_id: 'attempt-2' }] })
  f.files.set(`${root}.cursor.json`, JSON.stringify({ version: 1, agent_id: lease.agent_id, event_id: 0,
    local_delivery: { ...hint, stage: 'unknown' } }))
  await connect(f)
  await mod.localTick(f.$)
  const saved = JSON.parse(f.files.get(`${root}.cursor.json`))
  assert.equal(saved.version, 1)
  assert.equal(saved.local_outcomes[7].stage, 'unknown')
  assert.equal(saved.local_outcomes[8].stage, 'held')
})

test('actual inbox cursor prunes only consumed unresolved outcomes', async () => {
  const options = { result: { ok: false }, messages: [message, { ...message, event_id: 8, id: 'message-8' }] }
  const f = fake(options)
  await connect(f)
  await mod.localTick(f.$)
  options.hints = [{ ...hint, event_id: 8, message_id: 'message-8', attempt_id: 'attempt-2' }]
  await mod.localTick(f.$)
  options.cursor = 7
  options.hints = [{ ...hint, attempt_id: 'consumed-attempt' }]
  await mod.localTick(f.$)
  assert.equal(f.acks.at(-1).stage, 'inbox-consumed')
  assert.deepEqual(Object.keys(JSON.parse(f.files.get(`${root}.cursor.json`)).local_outcomes), ['8'])
})

test('hint preview starts directly before target beyond a full old backlog page', async () => {
  const target = { ...message, event_id: 77 }
  const messages = [...Array.from({ length: 76 }, (_, i) => ({ ...message, id: `old-${i}`, event_id: i + 1 })), target]
  const f = fake({ messages, hints: [{ ...hint, event_id: 77 }] })
  await connect(f)
  await mod.localTick(f.$)
  const previews = f.requests.filter(r => r.url.includes('/api/inbox'))
  assert.equal(new URL(previews[0].url).searchParams.get('since_event_id'), '76')
  assert.equal(f.submits.length, 1)
  assert.match(f.submits[0].text, /#77/)
  assert.equal(f.acks[0].stage, 'host-queued')
})

test('transient missing preview leaves claim unacknowledged and retries without terminal failure', async () => {
  const options = { messages: [] }
  const f = fake(options)
  await connect(f)
  await mod.localTick(f.$)
  assert.equal(f.acks.length, 0)
  assert.equal(f.submits.length, 0)
  options.messages = [message]
  await mod.localTick(f.$)
  assert.equal(f.submits.length, 1)
  assert.equal(f.acks[0].stage, 'host-queued')
})

test('past persisted expiry is validated against same-generation server renewal on every reload', async () => {
  const f = fake()
  f.files.set(`${root}.delivery.json`, JSON.stringify({ ...lease, expiresAt: Date.now() - 10000 }))
  for (let i = 0; i < 2; i++) {
    mod.reset()
    const reloaded = fake({ files: f.files })
    await connect(reloaded)
    assert.ok(reloaded.requests.some(r => r.url.endsWith('/renew')))
    await mod.localTick(reloaded.$)
    assert.equal(reloaded.acks[0].stage, 'host-queued')
    assert.equal(reloaded.submits.length, i === 0 ? 1 : 0)
  }
})

test('stale same-generation file cannot locally extend a server-expired lease', async () => {
  const f = fake({ renewStatus: 401 })
  f.files.set(`${root}.delivery.json`, JSON.stringify({ ...lease, expiresAt: Date.now() - 10000 }))
  f.files.set(`${root}.cursor.json`, JSON.stringify({ version: 1, agent_id: lease.agent_id, event_id: 0,
    local_delivery: { ...hint, stage: 'unknown' } }))
  await connect(f)
  await mod.localTick(f.$)
  await mod.poll(f.$)
  assert.equal(f.requests.some(r => r.url.includes('/wait?')), false)
  assert.equal(f.submits.length, 0)
  assert.equal(f.acks.length, 0)
  assert.equal(mod.state().localOutcomes[7].stage, 'unknown')
})

test('successful local history still fences pending work when the lease genuinely expires on reload', async () => {
  const first = fake()
  await connect(first)
  await mod.localTick(first.$)
  assert.equal(first.acks[0].stage, 'host-queued')
  assert.deepEqual(mod.state().localOutcomes, {})
  first.files.set(`${root}.delivery.json`, JSON.stringify({ ...lease, expiresAt: Date.now() - 10000 }))
  mod.reset()
  const pending = { ...message, id: 'message-8', event_id: 8 }
  const reloaded = fake({ files: first.files, renewStatus: 401, messages: [pending], result: { ok: false } })
  await connect(reloaded)
  await mod.localTick(reloaded.$)
  await mod.poll(reloaded.$)
  await mod.deliver(reloaded.$)
  assert.equal(reloaded.requests.some(r => r.url.includes('/api/inbox')), false)
  assert.equal(reloaded.submits.length, 0)
  assert.equal(mod.state().localOwned, true)
})

test('unavailable lease with journal schedules recovery without restoring legacy ownership', async () => {
  const f = fake({ files: new Map() })
  f.files.set(`${root}.cursor.json`, JSON.stringify({ version: 1, agent_id: lease.agent_id, event_id: 0,
    local_delivery: { ...hint, stage: 'held' } }))
  await connect(f)
  assert.equal(f.timers[0].ms, 0)
  f.files.set(`${root}.delivery.json`, JSON.stringify(lease))
  await mod.localTick(f.$)
  assert.equal(f.submits.length, 0)
  assert.equal(f.acks[0].stage, 'held')
  assert.ok(f.requests.some(r => r.url.endsWith('/renew')))
})

test('server renewal with expired response cannot validate a stale file', async () => {
  const f = fake({ renewExpiry: Date.now() - 1000 })
  f.files.set(`${root}.delivery.json`, JSON.stringify({ ...lease, expiresAt: Date.now() - 10000 }))
  await mod.poll(f.$)
  assert.equal(mod.state().localOwned, false)
  assert.equal(f.requests.some(r => r.url.includes('/wait?')), false)
})

for (const failureRoute of ['wait?', 'ack', 'renew']) test(`runtime replacement after ${failureRoute} auth failure reclaims with new generation and retained journal`, async () => {
  const token = 'b'.repeat(43)
  let armed = failureRoute === 'ack'
  let replaced = false
  const options = { throws: true, tokens: [lease.token, token] }
  options.fetch = async (url, init, files) => {
    if (!armed || replaced || !url.includes(`/local-delivery/${failureRoute}`)) return
    replaced = true
    files.set(`${root}.delivery.json`, JSON.stringify({ ...lease, token, generation: 2 }))
    options.generation = options.renewGeneration = 2
    options.hints = [{ ...hint, generation: 2, attempt_id: 'replacement-attempt' }]
    return { ok: false, status: 401, text: '{}' }
  }
  const f = fake(options)
  await connect(f)
  await mod.localTick(f.$)
  if (failureRoute !== 'ack') {
    armed = true
    if (failureRoute === 'renew') await mod.renewLocal(f.$)
    else await mod.localTick(f.$)
  }
  await mod.localTick(f.$)
  assert.equal(replaced, true)
  assert.equal(f.submits.length, 1)
  assert.deepEqual(f.acks.at(-1), { attempt_id: 'replacement-attempt', stage: 'unknown' })
  const newAcks = f.requests.filter(r => r.url.endsWith('/ack') && r.init.headers['X-Xats-Delivery-Token'] === token)
  assert.ok(newAcks.length)
  assert.ok(newAcks.every(r => JSON.parse(r.init.body).attempt_id === 'replacement-attempt'))
  assert.equal(JSON.parse(f.files.get(`${root}.cursor.json`)).local_outcomes[7].stage, 'unknown')
  const waitCount = f.requests.filter(r => r.url.includes('/wait?')).length
  await mod.poll(f.$)
  assert.equal(mod.state().localOwned, true)
  assert.equal(f.requests.filter(r => r.url.includes('/wait?')).length, waitCount)
  assert.doesNotMatch(JSON.stringify(mod.state()), new RegExp(token))
})

test('replacement during host submission never sends the old receipt with new credentials', async () => {
  const options = { tokens: [lease.token, 'b'.repeat(43)] }
  const f = fake(options)
  await connect(f)
  f.$.prompt.submit = async () => {
    f.files.set(`${root}.delivery.json`, JSON.stringify({ ...lease, token: 'b'.repeat(43), generation: 2 }))
    options.renewGeneration = 2
    options.fetch = async (url, init) => url.endsWith('/renew') && init.headers['X-Xats-Delivery-Token'] === lease.token
      ? { ok: false, status: 401, text: '{}' } : undefined
    await mod.renewLocal(f.$)
    return { ok: false }
  }
  await mod.localTick(f.$)
  assert.equal(f.requests.some(r => r.url.endsWith('/ack')), false)
  options.generation = 2
  options.hints = [{ ...hint, generation: 2, attempt_id: 'replacement-attempt' }]
  await mod.localTick(f.$)
  // An unclassifiable non-ok submit is uncertainty, not an invented refusal.
  assert.deepEqual(f.acks, [{ attempt_id: 'replacement-attempt', stage: 'unknown' }])
})

test('session hook schedules background work without waiting for the longpoll', async () => {
  const hooks = []
  const on = (event, ...args) => { hooks.push({ event, fn: args.at(-1) }); return { catch() {} } }
  register(on)
  const f = fake()
  await hooks.find((h) => h.event === 'session.start').fn(f.$, {}, async () => 'next')
  assert.equal(f.requests.length, 0)
  assert.ok(f.timers.length > 0)
})

// --- submit-outcome classification (task: busy vs explicit refusal) ---------
const classify = mod.classifySubmitResult

test('busy host result is retryable, never a refusal', () => {
  assert.equal(classify({ ok: false, error: 'busy: a turn is already running' }), 'busy')
  assert.equal(classify({ ok: false, reason: 'turn in progress' }), 'busy')
  // An explicit host hold is a real hold, not a busy retry.
  assert.equal(classify({ ok: false, status: 'held' }), 'held')
})

test('explicit refusal stays terminal', () => {
  assert.equal(classify({ ok: false, stage: 'refused' }), 'refused')
  assert.equal(classify({ ok: false, refused: true }), 'refused')
})

test('unclassifiable failure is unknown, not an invented refusal', () => {
  assert.equal(classify({ ok: false }), 'unknown')
  assert.equal(classify({ ok: false, error: 'socket closed' }), 'unknown')
})

test('success shapes keep their distinct stages', () => {
  assert.equal(classify({ ok: true }), 'host-queued')
  assert.equal(classify(undefined), 'transport-written')
})

test('busy submit retries at the next turn boundary and then succeeds', async () => {
  const f = fake({ result: { ok: false, error: 'busy: turn in progress' } })
  await connect(f)
  await mod.localTick(f.$)
  assert.equal(f.submits.length, 1, 'one host submit attempt')
  assert.equal(f.acks.length, 0, 'a busy host must not be acknowledged as settled')
  assert.equal(mod.state().localAttempt?.stage, 'held', 'journaled as held for visibility')
  // Host becomes free: the same claim is retried rather than replayed as settled.
  f.$.prompt.submit = async (value) => { f.submits.push(value); return { ok: true } }
  await mod.localTick(f.$)
  assert.equal(f.submits.length, 2)
  assert.deepEqual(f.acks[0], { attempt_id: hint.attempt_id, stage: 'host-queued' })
})

test('re-arms after a daemon restart without surrendering ownership to polling', async () => {
  const options = {}
  const f = fake(options)
  await connect(f)
  // The daemon goes away: the long-poll fails with a connection error.
  options.fetch = async (url) => {
    if (url.includes('/wait?')) throw new Error('connect ECONNREFUSED 127.0.0.1:9100')
  }
  await mod.localTick(f.$)
  assert.equal(mod.state().localOwned, true, 'ownership must survive the restart')
  assert.equal(f.requests.some((r) => r.url.includes('/api/inbox')), false,
    'no polling fallback while the local owner is recovering')
  // The daemon comes back on the same lease: the same claim is delivered.
  options.fetch = undefined
  await mod.localTick(f.$)
  assert.deepEqual(f.acks[0], { attempt_id: hint.attempt_id, stage: 'host-queued' })
  assert.equal(f.submits.length, 1, 'exactly one host submission after recovery')
})

test('a refused journal is never rewritten as inbox-consumed by a later read', async () => {
  const f = fake({ result: { ok: false, stage: 'refused' } })
  await connect(f)
  await mod.localTick(f.$)
  assert.equal(f.acks[0].stage, 'refused')
  // The person (or the model) later reads the mailbox, advancing the cursor.
  f.files.set(`${root}.cursor.json`, JSON.stringify({ version: 1, agent_id: lease.agent_id, event_id: 7,
    local_delivery: { ...hint, stage: 'refused' } }))
  mod.reset()
  const restarted = fake({ files: f.files, cursor: 7 })
  await connect(restarted)
  await mod.localTick(restarted.$)
  assert.equal(restarted.acks[0].stage, 'refused', 'a host refusal stays a refusal')
})
