import test from 'node:test'
import assert from 'node:assert/strict'
import { listNativePeers, listNativePeerCommand, routeNativeSend, nativeSubmit,
  nativeBridgeState, drainNativeReceipts, observeNativeReceive, __nativeInternals as internals } from '../assets/claude/mod/hooks/register.js'

const agent = '11111111-1111-4111-8111-111111111111'
const attempt = '22222222-2222-4222-8222-222222222222'
const message = '33333333-3333-4333-8333-333333333333'
const root = '/home/test/.xats/native/owned-session'
const socketDir = '/tmp/cc-socks'
const peer = { agent_id: agent, name: 'pi-worker', ref: '1234', agent_type: 'pi', address: `uds:${socketDir}/xats-999-${agent.replace(/-/g, '').slice(0, 12)}.sock` }
function state(options = {}) {
  return { ready: true, everReady: true, closed: false, root, socketDir, ownerPid: '999', pid: 321, peers: [peer], rawPeers: [],
    requests: new Map(), latest: new Map(), receipts: [], ...options }
}

test.afterEach(() => internals.reset())

test('native ListAgents preserves core rows and adds explicitly attributed xats peers', async () => {
  internals.setState(state())
  const original = { result: { listing: 'Claude: reviewer', sections: [{ kind: 'local', total: 1, rows: [{ name: 'reviewer' }] }] } }
  const result = await listNativePeers({}, { tool: 'ListAgents' }, async () => original)
  assert.match(result.result.listing, /Claude: reviewer/)
  assert.match(result.result.listing, /xats peers \(native IPC, non-Claude\)/)
  assert.match(result.result.listing, /xats:pi-worker \[1234\]/)
  // Native uds first: that is the address form the host's own safety check
  // understands. The xats: alias stays as a re-resolving convenience.
  assert.ok(result.result.listing.includes(`SendMessage to: ${peer.address}`))
  assert.ok(result.result.listing.includes(`Stable alias: xats:${agent}`))
  assert.equal(result.result.sections[0], original.result.sections[0])
  assert.equal(result.result.sections[1].rows[0].type, 'pi')
  assert.equal(original.result.sections.length, 1, 'core result must not be mutated')
})

for (const result of [{ deny: 'policy' }, { isError: true, result: { listing: '' } }, { result: 'older host' }]) {
  test(`native listing leaves refused or unsupported core results alone: ${JSON.stringify(result)}`, async () => {
    internals.setState(state())
    assert.equal(await listNativePeers({}, {}, async () => result), result)
  })
}

test('native /list-agents command retains existing text and appends honest cross-vendor peers', async () => {
  internals.setState(state())
  assert.match((await listNativePeerCommand({}, {}, async () => ({ text: 'Your Claude sessions' }))).text,
    /Your Claude sessions[\s\S]*pi-worker/)
})

for (const to of [`xats:${agent}`, 'xats:pi-worker [1234]']) {
  test(`native SendMessage readdresses ${to} through the original host send`, async () => {
    internals.setState(state())
    const event = Object.freeze({ to, text: 'hello Pi', origin: Object.freeze({ kind: 'model' }) })
    let actual
    const denied = { isDelivered: false, reason: 'host refused this send' }
    const result = await routeNativeSend({}, event, async value => { actual = value; return denied })
    assert.equal(actual.to, peer.address)
    assert.equal(actual.text, event.text)
    assert.equal(actual.origin, event.origin, 'do not forge origin or authorship')
    assert.equal(result, denied, 'the host alone reports admission/refusal')
    assert.equal(event.to, to)
  })
}

test('ordinary native peers are unchanged and unavailable xats peers fail explicitly', async () => {
  internals.setState(state({ ready: false }))
  const native = { to: 'reviewer', text: 'hi' }
  assert.equal(await routeNativeSend({}, native, async e => e), native)
  let calls = 0
  const denied = await routeNativeSend({}, { to: `xats:${agent}` }, async () => { calls++ })
  assert.equal(calls, 0)
  assert.equal(denied.isDelivered, false)
})

test('duplicate friendly names never pick an arbitrary native endpoint', async () => {
  internals.setState(state({ peers: [peer, { ...peer, agent_id: message }] }))
  const denied = await routeNativeSend({}, { to: 'xats:pi-worker [1234]' }, async () => assert.fail('ambiguous send'))
  assert.equal(denied.isDelivered, false)
})

test('native status stream accepts only a matching outstanding attempt and generation', () => {
  const s = state()
  s.requests.set(attempt, { generation: 2, event_id: 7 })
  internals.setState(s)
  internals.receive(s, { kind: 'receipt', attempt_id: attempt, generation: 1, event_id: 7, stage: 'host-queued' })
  internals.receive(s, { kind: 'receipt', attempt_id: attempt, generation: 2, event_id: 8, stage: 'host-queued' })
  internals.receive(s, { kind: 'receipt', attempt_id: message, generation: 2, event_id: 7, stage: 'host-queued' })
  assert.deepEqual(drainNativeReceipts(), [])
  internals.receive(s, { kind: 'receipt', attempt_id: attempt, generation: 2, event_id: 7, stage: 'held' })
  assert.equal(drainNativeReceipts()[0].stage, 'held')
})

test('a selected native owner that dies cannot fall back to another submission path', async () => {
  internals.setState(state({ ready: false }))
  assert.equal(nativeBridgeState().selected, true)
  await assert.rejects(nativeSubmit({}, {}, {}, ''), /no alternate submission/)
  internals.reset()
  assert.equal(await nativeSubmit({}, {}, {}, ''), null, 'compatibility is allowed only before native selection')
})

for (const stage of ['host-queued', 'held', 'refused', 'expired', 'failed', 'unknown']) {
  test(`native submission retains proven ${stage} without prompt submission`, async () => {
    const s = state()
    internals.setState(s)
    const hint = { attempt_id: attempt, message_id: message, generation: 1, event_id: 7 }
    const writes = []
    const $ = { fs: { write: async (file, value) => { writes.push({ file, value }) },
      read: async () => JSON.stringify({ ...hint, stage }) }, clock: { sleep: async () => {} } }
    assert.equal(await nativeSubmit($, hint, { from_agent_id: agent, body: 'full native body' }, 'notice'), stage)
    assert.equal(writes.length, 2)
    assert.equal(writes[0].value, '')
    assert.equal(JSON.parse(writes[1].value).source_agent_id, agent)
    assert.ok(writes[1].file.startsWith(root + '/requests/'))
  })
}

test('a written native frame without a receipt does not invent host queue admission', async () => {
  internals.setState(state())
  const hint = { attempt_id: attempt, message_id: message, generation: 1, event_id: 7 }
  const $ = { fs: { write: async () => {}, read: async () => JSON.stringify({ ...hint, stage: 'transport-written' }) },
    clock: { sleep: async () => {} } }
  assert.equal(await nativeSubmit($, hint, { from_agent_id: agent, body: 'full native body' }, 'notice'), 'transport-written')
})

for (const mode of [undefined, 'notice']) test(`native payload mode ${mode ?? 'default'} preserves body-first behavior`, async () => {
  internals.setState(state())
  const hint = { attempt_id: attempt, message_id: message, generation: 1, event_id: 7 }
  const writes = []
  const $ = { env: { get: async () => mode }, fs: {
    write: async (file, value) => writes.push({ file, value }),
    read: async () => JSON.stringify({ ...hint, stage: 'host-queued' }),
  } }
  const body = 'Actual reply body, delivered without an MCP fetch.\nSecond line.'
  await nativeSubmit($, hint, { from_agent_id: agent, from_name: 'Pi', body }, '<xats-inbox>Call get_inbox</xats-inbox>')
  const request = JSON.parse(writes[1].value)
  assert.equal(request.delivery, mode === 'notice' ? 'notice' : 'body')
  if (mode === 'notice') assert.match(request.text, /Call get_inbox/)
  else {
    assert.ok(request.text.includes(body))
    assert.doesNotMatch(request.text, /Call get_inbox|<xats-inbox>/)
    assert.equal(request.source_name, 'Pi')
  }
})

test('a quoted correlation tag cannot release another held native message', async () => {
  const s = state()
  const oldText = `old held body\n<xats-native-notice attempt="${attempt}" generation="1" event="7"/>`
  const newText = `${oldText}\nNew body quoting the old notice.\n<xats-native-notice attempt="${message}" generation="1" event="8"/>`
  s.requests.set(attempt, { attempt_id: attempt, generation: 1, event_id: 7, text: oldText })
  s.requests.set(message, { attempt_id: message, generation: 1, event_id: 8, text: newText })
  s.latest.set(attempt, { stage: 'held' })
  internals.setState(s)
  const $ = { fs: { write: async () => {} } }
  await observeNativeReceive($, { origin: { kind: 'peer' }, text: newText }, async () => ({ text: newText }))
  assert.deepEqual(drainNativeReceipts().map(r => r.attempt_id), [message])
  assert.equal(s.latest.get(attempt).stage, 'held')
})

test('native admission is witnessed by the actual queued session.receive result, not a socket write', async () => {
  const s = state()
  const text = `fixture notice\n<xats-native-notice attempt="${attempt}" generation="1" event="7"/>`
  s.requests.set(attempt, { attempt_id: attempt, generation: 1, event_id: 7, text })
  internals.setState(s)
  const writes = []
  const $ = { fs: { write: async (file, value) => { writes.push({ file, value }) } } }
  const queued = { text }
  assert.equal(await observeNativeReceive($, { origin: { kind: 'peer' }, text }, async () => queued), queued)
  const admission = writes.find(w => w.file.includes('/admissions/'))
  assert.equal(JSON.parse(admission.value).admission_source, 'session.receive')
  assert.equal(drainNativeReceipts()[0].stage, 'host-queued')
})

for (const outcome of ['held', 'consumed', 'wrong-origin', 'wrong-body', 'wrong-generation', 'terminal-refusal']) {
  test(`native ${outcome} does not invent a queue-admission witness`, async () => {
    const s = state()
    const text = `fixture notice\n<xats-native-notice attempt="${attempt}" generation="1" event="7"/>`
    s.requests.set(attempt, { attempt_id: attempt, generation: outcome === 'wrong-generation' ? 2 : 1, event_id: 7, text })
    if (outcome === 'terminal-refusal') s.latest.set(attempt, { stage: 'refused' })
    internals.setState(s)
    const writes = []
    const $ = { fs: { write: async (file, value) => { writes.push({ file, value }) } } }
    const event = { origin: { kind: outcome === 'wrong-origin' ? 'unclassified' : 'peer' }, text }
    const next = async () => {
      if (outcome === 'held') throw new Error('host held this message')
      return outcome === 'consumed' ? { consumed: 'not delivered' } : { text: outcome === 'wrong-body' ? 'unrelated' : text }
    }
    if (outcome === 'held') await assert.rejects(observeNativeReceive($, event, next), /held/)
    else await observeNativeReceive($, event, next)
    assert.equal(writes.some(w => w.file.includes('/admissions/')), false)
    assert.deepEqual(drainNativeReceipts(), [])
  })
}

test('native peer discovery rejects endpoints outside the owning helper namespace', () => {
  const s = state()
  internals.setState(s)
  internals.receive(s, { kind: 'peers', peers: [peer, { ...peer, address: 'uds:/tmp/arbitrary.sock' },
    { ...peer, address: `uds:${socketDir}/xats-999-${message.replace(/-/g, '').slice(0, 12)}.sock` }] })
  assert.deepEqual(s.peers, [peer])
})
