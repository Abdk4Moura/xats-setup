import test from 'node:test'
import assert from 'node:assert/strict'
import { listNativePeers, listNativePeerCommand, routeNativeSend, nativeSubmit,
  nativeBridgeState, drainNativeReceipts, __nativeInternals as internals } from '../assets/claude/mod/hooks/native-peer.js'

const agent = '11111111-1111-4111-8111-111111111111'
const attempt = '22222222-2222-4222-8222-222222222222'
const message = '33333333-3333-4333-8333-333333333333'
const root = '/home/test/.xats/native/owned-session'
const peer = { agent_id: agent, name: 'pi-worker', ref: '1234', agent_type: 'pi', address: `uds:${root}/peers/abc/321.sock` }
function state(options = {}) {
  return { ready: true, everReady: true, closed: false, root, socketRoot: root + '/peers', pid: 321, peers: [peer], rawPeers: [],
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
  assert.match(result.result.listing, new RegExp(`SendMessage to: xats:${agent}`))
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
    assert.equal(await nativeSubmit($, hint, { from_agent_id: agent }, 'notice'), stage)
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
  assert.equal(await nativeSubmit($, hint, { from_agent_id: agent }, 'notice'), 'transport-written')
})

test('native peer discovery rejects endpoints outside the owning helper namespace', () => {
  const s = state()
  internals.setState(s)
  internals.receive(s, { kind: 'peers', peers: [peer, { ...peer, address: 'uds:/tmp/arbitrary.sock' },
    { ...peer, address: `uds:${root}/peers/abc/999.sock` }] })
  assert.deepEqual(s.peers, [peer])
})
