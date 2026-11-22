import test from 'node:test'
import assert from 'node:assert/strict'
import { pinIdentity, pinnedCall } from '../mcp-stdio/src/identity.mjs'
import { agyIdentityName } from '../lib/agy.mjs'

test('a stdio host pins registration to its configured durable identity', () => {
  const pinned = pinnedCall('register_agent', { name: 'invented-' + Date.now(), cwd: '/work' }, 'agy-box-root')
  assert.equal(pinned.name, 'agy-box-root')
  assert.equal('name_mode' in pinned, false, 'the MCP tool schema rejects fields it does not define')
  assert.equal(pinned.agent_type, 'custom')
  assert.equal(pinned.agent_type_name, 'Antigravity')
  assert.equal(pinned.cwd, '/work', 'other model-supplied fields are preserved')
})

test('only registration is rewritten, and no name means no change', () => {
  const args = { to: 'pi', body: 'hi' }
  assert.deepEqual(pinnedCall('send_message', args, 'agy-box-root'), args)
  const ignored = { name: 'model-choice' }
  assert.deepEqual(pinIdentity('   ', ignored), ignored)
  assert.deepEqual(pinnedCall('register_agent', ignored, undefined), ignored)
})

test('the pinned name is stable per box and independent of session timing', () => {
  const paths = { xatsRoot: '/tmp/xats-test-root' }
  const first = agyIdentityName(paths)
  assert.match(first, /^agy-[a-z0-9_-]+-[a-z0-9_-]+$/)
  assert.equal(agyIdentityName(paths), first)
})

test('each Antigravity instance gets its own name while one conversation stays stable', () => {
  const base = 'agy-box-root'
  const a = pinnedCall('register_agent', {}, base, { 'antigravity.google/root_conversation_id': 'conv-a' })
  const b = pinnedCall('register_agent', {}, base, { 'antigravity.google/root_conversation_id': 'conv-b' })
  const aAgain = pinnedCall('register_agent', {}, base, { 'antigravity.google/root_conversation_id': 'conv-a' })
  assert.match(a.name, /^agy-box-root-[0-9a-f]{8}$/)
  assert.notEqual(a.name, b.name, 'two live instances must not share one mailbox')
  assert.equal(a.name, aAgain.name, 'a reload of the same conversation keeps its identity')
  assert.equal('name_mode' in a, false)
})

test('without a host conversation id there is exactly one identity per box', () => {
  const pinned = pinnedCall('register_agent', {}, 'agy-box-root', {})
  assert.equal(pinned.name, 'agy-box-root')
  assert.equal(pinnedCall('register_agent', {}, 'agy-box-root', { 'antigravity.google/root_conversation_id': undefined }).name, 'agy-box-root')
})
