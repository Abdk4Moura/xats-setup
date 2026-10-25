import test from 'node:test'
import assert from 'node:assert/strict'
import { __internals } from '../assets/claude/mod/hooks/register.js'

const agent = { agent_id: 'agent-1', name: 'claude-test', team: 'default', session_key: 'session-1' }
const message = { id: 'message-7', event_id: 7, from_name: 'pi-test', subject: 'hello', body: 'body', need_reply: false }

function fake({ messages = [message], cursor = 0, cursorFails = false } = {}) {
  const submitted = []
  const scheduled = []
  let inboxCalls = 0
  let mailboxCursor = cursor
  const response = (value) => ({ status: 200, ok: true, headers: {}, text: JSON.stringify(value) })
  const $ = {
    env: { get: async (name) => name === 'XATS_BASE' ? 'http://127.0.0.1:9100' : undefined },
    fs: { read: async () => undefined, write: async () => {} },
    session: { id: async () => 'session-1' },
    http: {
      fetch: async (url) => {
        if (url.includes('/api/agents')) return response({ agents: [agent] })
        if (url.includes('/api/inbox')) {
          inboxCalls += 1
          return response({ messages: inboxCalls === 1 ? messages : [], has_more: false, last_event_id: 7 })
        }
        if (url.includes('/api/cursor')) {
          if (cursorFails) return { status: 503, ok: false, headers: {}, text: '{"error":"unavailable"}' }
          return response({ last_processed_event_id: mailboxCursor })
        }
        return response({ ok: true })
      },
    },
    prompt: { submit: async (event) => { submitted.push(event); return { ok: true } } },
    ui: { invalidate: () => undefined, resolve: () => ({}) },
    clock: { after: (_ms, fn) => scheduled.push(fn), every: () => {} },
  }
  return { $, submitted, scheduled, setCursor: (value) => { mailboxCursor = value } }
}

async function flush(scheduled) {
  while (scheduled.length) {
    scheduled.shift()()
    await new Promise((resolve) => setImmediate(resolve))
  }
}

function fresh() {
  __internals.reset()
}

test('mail read through MCP during debounce is dropped before plugin submission', async () => {
  fresh()
  const { $, submitted, scheduled, setCursor } = fake()
  await __internals.poll($)
  assert.equal(__internals.state().pending, 1)
  setCursor(7)
  await flush(scheduled)
  assert.equal(submitted.length, 0)
  assert.equal(__internals.state().pending, 0)
})

test('poll filters MCP-read events but submits remaining unread events', async () => {
  fresh()
  const unread = { ...message, id: 'message-8', event_id: 8, from_name: 'codex-test' }
  const { $, submitted, scheduled } = fake({ messages: [message, unread], cursor: 7 })
  await __internals.poll($)
  await flush(scheduled)
  assert.equal(submitted.length, 1)
  assert.match(submitted[0].text, /#8 from codex-test/)
  assert.doesNotMatch(submitted[0].text, /#7 from pi-test/)
})

test('cursor lookup failure keeps the existing notification fallback', async () => {
  fresh()
  const { $, submitted, scheduled } = fake({ cursorFails: true })
  await __internals.poll($)
  await flush(scheduled)
  assert.equal(submitted.length, 1)
  assert.match(submitted[0].text, /#7 from pi-test/)
  assert.match(__internals.state().mailboxCursorError, /http 503/)
})
