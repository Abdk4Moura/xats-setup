import test from 'node:test'
import assert from 'node:assert/strict'
import { pinIdentity, pinnedCall } from '../mcp-stdio/src/identity.mjs'
import { agyIdentityName } from '../lib/agy.mjs'

test('a stdio host pins registration to its configured durable identity', () => {
  const pinned = pinnedCall('register_agent', { name: 'invented-' + Date.now(), cwd: '/work' }, 'agy-box-root')
  assert.equal(pinned.name, 'agy-box-root')
  assert.equal(pinned.name_mode, 'exact', 'a live collision must be reported, never sufficed into a new id')
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
