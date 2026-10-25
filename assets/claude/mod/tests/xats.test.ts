import { expect, test } from 'claude-code/testing'
import { __internals } from '../hooks/register.js'

const AGENT = {
  agent_id: 'agt_1',
  name: 'claude-host-abcd1234',
  team: 'default',
  session_key: 'sess-1',
  online: true,
}

const MESSAGE = {
  id: 'msg_1',
  event_id: 7,
  from_name: 'pi-host',
  subject: 'deploy window',
  body: 'Can you take the 14:00 window?',
  need_reply: 1,
}

type FakeOptions = {
  agents?: unknown[]
  messages?: unknown[]
  submitFails?: boolean
  submitFailsOnce?: boolean
  invalidateThrows?: boolean
  noIdentity?: boolean
  home?: string
  files?: Map<string, string>
  persistentInbox?: boolean
  cursor?: number
  cursorFails?: boolean
}

/** A hand-rolled mods API, just the calls this mod makes. */
function fake$(options: FakeOptions = {}) {
  const submitted: any[] = []
  const fetches: string[] = []
  const scheduled: Array<() => void> = []
  let inboxServed = 0
  let submitAttempts = 0
  let cursor = options.cursor ?? 0

  // Match the real mods API: { status, ok, headers, text } with text as a string.
  const asJson = (value: unknown) => ({ status: 200, ok: true, headers: {}, text: JSON.stringify(value) })

  const $: any = {
    env: { get: async (name: string) => name === 'XATS_BASE' ? 'http://127.0.0.1:9100' : name === 'HOME' ? options.home : undefined },
    fs: {
      read: async (file: string) => options.files?.get(file),
      write: async (file: string, value: string) => { options.files?.set(file, value) },
    },
    session: { id: async () => 'sess-1' },
    http: {
      fetch: async (url: string) => {
        fetches.push(url)
        if (url.includes('/api/cursor')) {
          if (options.cursorFails) return { status: 503, ok: false, headers: {}, text: '{"error":"unavailable"}' }
          return asJson({ last_processed_event_id: cursor })
        }
        if (url.includes('/api/agents')) {
          return asJson({ agents: options.noIdentity ? [] : (options.agents ?? [AGENT]) })
        }
        if (url.includes('/api/inbox')) {
          inboxServed += 1
          const since = Number(new URL(url).searchParams.get('since_event_id') || 0)
          const messages = options.persistentInbox
            ? (options.messages ?? [MESSAGE]).filter((m: any) => m.event_id > since)
            : inboxServed === 1 ? (options.messages ?? [MESSAGE]) : []
          return asJson({ messages, has_more: false, last_event_id: messages.length ? (messages.at(-1) as any).event_id : since })
        }
        return asJson({ ok: true })
      },
    },
    prompt: {
      submit: async (event: any) => {
        submitAttempts += 1
        if (options.submitFails || (options.submitFailsOnce && submitAttempts === 1)) {
          throw new Error('no turn available')
        }
        submitted.push(event)
        return { ok: true }
      },
    },
    // The real host returns undefined from invalidate; it is not thenable.
    ui: { invalidate: () => {
      if (options.invalidateThrows) throw new Error('redraw unavailable')
      return undefined
    }, resolve: () => ({}) },
    clock: {
      after: (_ms: number, fn: () => void) => {
        scheduled.push(fn)
      },
      every: (_ms: number, fn: () => void) => {
        scheduled.push(fn)
      },
    },
  }

  return { $, submitted, fetches, scheduled, setCursor: (value: number) => { cursor = value } }
}

function fresh() {
  __internals.reset()
}

/** Run everything the poll scheduled (delivery is debounced onto the clock). */
async function flush(scheduled: Array<() => void>) {
  while (scheduled.length > 0) {
    const fn = scheduled.shift()!
    await fn()
    // Mod timers schedule async cursor lookups and prompt submission without
    // returning their promise; yield a full event-loop turn for those to settle.
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
}

test('mail is delivered as an attributed prompt, never as the user', async () => {
  fresh()
  const { $, submitted, scheduled } = fake$()

  await __internals.poll($)
  await flush(scheduled)

  expect(submitted.length).toBe(1)
  expect(submitted[0].asUser).toBeUndefined()
  expect(submitted[0].text).toContain('<xats-inbox>')
  expect(submitted[0].text).toContain('#7 from pi-host: deploy window (needs reply)')
  expect(submitted[0].text).toContain('mcp__cross-agent-teams__get_inbox')
})

test('a throwing redraw cannot strand a fetched inbox batch', async () => {
  fresh()
  const { $, submitted, scheduled } = fake$({ invalidateThrows: true })

  await __internals.poll($)
  await flush(scheduled)
  await new Promise((resolve) => setTimeout(resolve, 0))

  expect(submitted.length).toBe(1)
  expect(__internals.state().pending).toBe(0)
  expect(__internals.state().lastError).toBe('')
})

test('identity is discovered by session key, not by name guessing', async () => {
  fresh()
  const { $, fetches } = fake$()

  await __internals.poll($)

  const agentsCall = fetches.find((url) => url.includes('/api/agents'))
  expect(agentsCall).toBeDefined()
  expect(__internals.state().agentName).toBe('claude-host-abcd1234')
})

test('the same message is not delivered twice', async () => {
  fresh()
  const { $, submitted, scheduled } = fake$()

  await __internals.poll($)
  await flush(scheduled)
  await __internals.poll($)
  await flush(scheduled)

  expect(submitted.length).toBe(1)
  expect(__internals.state().lastEventId).toBe(7)
})

test('mail read via MCP during debounce is dropped before plugin submission', async () => {
  fresh()
  const { $, submitted, scheduled, setCursor } = fake$()

  await __internals.poll($)
  expect(__internals.state().pending).toBe(1)
  setCursor(7)
  await flush(scheduled)

  expect(submitted.length).toBe(0)
  expect(__internals.state().pending).toBe(0)
})

test('poll filters MCP-read mail but still submits unread events', async () => {
  fresh()
  const messages = [
    { ...MESSAGE, event_id: 7 },
    { ...MESSAGE, id: 'msg_8', event_id: 8, from_name: 'codex-host' },
  ]
  const { $, submitted, scheduled } = fake$({ messages, cursor: 7 })

  await __internals.poll($)
  await flush(scheduled)

  expect(submitted.length).toBe(1)
  expect(submitted[0].text).toContain('#8 from codex-host')
  expect(submitted[0].text).not.toContain('#7 from pi-host')
})

test('cursor endpoint failure preserves notification fallback', async () => {
  fresh()
  const { $, submitted, scheduled } = fake$({ cursorFails: true })

  await __internals.poll($)
  await flush(scheduled)

  expect(submitted.length).toBe(1)
  expect(submitted[0].text).toContain('#7 from pi-host')
  expect(__internals.state().mailboxCursorError).toContain('http 503')
})

test('an empty inbox starts no turn', async () => {
  fresh()
  const { $, submitted } = fake$({ messages: [] })

  await __internals.poll($)

  expect(submitted.length).toBe(0)
})

test('an unregistered session draws nothing and starts no turn', async () => {
  fresh()
  const { $, submitted } = fake$({ noIdentity: true })

  await __internals.poll($)

  expect(submitted.length).toBe(0)
  expect(__internals.bandText()).toBeNull()
})

test('the band reports unread and needs-reply counts', async () => {
  fresh()
  const { $ } = fake$()

  expect(__internals.bandText()).toBeNull()
  await __internals.poll($)
  expect(__internals.bandText()).toBe('✦ xats · 1 notice pending · 1 needs reply')
  await __internals.deliver($)
  expect(__internals.bandText()).toBe('✦ xats · claude-host-abcd1234')
})

test('a failed submit keeps the mail pending for a retry', async () => {
  fresh()
  const { $ } = fake$({ submitFails: true })

  await __internals.poll($)
  await __internals.deliver($)

  expect(__internals.state().pending).toBe(1)
  expect(__internals.state().lastSubmitError).toContain('no turn available')
})

test('a busy-turn submit retries on the next poll even with no new mail', async () => {
  fresh()
  const { $, submitted, scheduled } = fake$({ submitFailsOnce: true })

  await __internals.poll($)
  await flush(scheduled)
  await new Promise((resolve) => setTimeout(resolve, 0))
  expect(__internals.state().pending).toBe(1)
  expect(__internals.state().submitAttempts).toBe(1)
  expect(__internals.state().lastSubmitError).toContain('no turn available')

  // The fake server only returns a message on its first poll. The second poll
  // must retry the pending batch rather than waiting for another new message.
  await __internals.poll($)
  await flush(scheduled)
  await new Promise((resolve) => setTimeout(resolve, 0))
  expect(submitted.length).toBe(1)
  expect(__internals.state().pending).toBe(0)
  expect(__internals.state().submitAttempts).toBe(2)
  expect(__internals.state().submitOk).toBe(1)
  expect(__internals.state().lastSubmitError).toBe('')

  await __internals.poll($)
  await flush(scheduled)
  expect(submitted.length).toBe(1)
})

test('accepted cursor survives a mod reload without replaying old mail', async () => {
  fresh()
  const files = new Map<string, string>()
  const messages: any[] = [MESSAGE]
  const options = { home: '/home/me', files, persistentInbox: true, messages }
  const first = fake$(options)
  await __internals.poll(first.$)
  await flush(first.scheduled)
  await new Promise((resolve) => setTimeout(resolve, 0))
  const file = '/home/me/.xats/sessions/sess-1.cursor.json'
  expect(JSON.parse(files.get(file)!)).toEqual({ version: 1, agent_id: 'agt_1', event_id: 7 })

  fresh() // a Claude mod hot reload resets module memory, not the cursor file
  const second = fake$(options)
  await __internals.poll(second.$)
  await flush(second.scheduled)
  expect(second.submitted.length).toBe(0)
  expect(__internals.state().lastEventId).toBe(7)
  messages.push({ ...MESSAGE, id: 'msg_2', event_id: 8, subject: 'new mail' })
  await __internals.poll(second.$)
  await flush(second.scheduled)
  await new Promise((resolve) => setTimeout(resolve, 0))
  expect(second.submitted.length).toBe(1)
  expect(second.submitted[0].text).toContain('#8 from pi-host: new mail')
  expect(JSON.parse(files.get(file)! ).event_id).toBe(8)
})

test('a failed submit is not persisted and is replayed after reload', async () => {
  fresh()
  const files = new Map<string, string>()
  const options = { home: '/home/me', files, persistentInbox: true }
  const first = fake$({ ...options, submitFails: true })
  await __internals.poll(first.$)
  await flush(first.scheduled)
  await new Promise((resolve) => setTimeout(resolve, 0))
  expect(__internals.state().pending).toBe(1)
  expect(files.size).toBe(0)

  fresh()
  const second = fake$(options)
  await __internals.poll(second.$)
  await flush(second.scheduled)
  await new Promise((resolve) => setTimeout(resolve, 0))
  expect(second.submitted.length).toBe(1)
  expect(__internals.state().acceptedEventId).toBe(7)
})

test('a cursor from another agent id cannot hide this agent’s mail', async () => {
  fresh()
  const file = '/home/me/.xats/sessions/sess-1.cursor.json'
  const files = new Map([[file, JSON.stringify({ version: 1, agent_id: 'old-agent', event_id: 900 })]])
  const next = fake$({ home: '/home/me', files, persistentInbox: true, agents: [{ ...AGENT, agent_id: 'agt_2' }] })
  await __internals.poll(next.$)
  await flush(next.scheduled)
  await new Promise((resolve) => setTimeout(resolve, 0))
  expect(next.submitted.length).toBe(1)
  expect(next.submitted[0].text).toContain('#7 from pi-host')
  expect(JSON.parse(files.get(file)! ).agent_id).toBe('agt_2')
})

test('resolves the daemon port from an asynchronous fs.read', async () => {
  // $.fs.read returns a Promise in the mods API. Awaiting it is easy to forget,
  // and the failure is silent: the base URL becomes "[object Promise]" and every
  // request 404s at the URL parser. This pins the awaited path.
  __internals.reset()
  const urls: string[] = []
  const $: any = {
    env: { get: async (name: string) => (name === 'HOME' ? '/home/me' : undefined) },
    fs: { read: async () => '9102\n' },
    session: { id: async () => 'sess-1' },
    http: {
      fetch: async (url: string) => {
        urls.push(url)
        if (url.includes('/api/agents')) return { status: 200, ok: true, headers: {}, text: JSON.stringify({ agents: [] }) }
        return { status: 200, ok: true, headers: {}, text: JSON.stringify({ messages: [] }) }
      },
    },
    prompt: { submit: async () => ({ ok: true }) },
    ui: { invalidate: async () => {} },
    clock: { after: () => {}, every: () => {} },
  }

  await __internals.poll($)

  expect(urls.length).toBeGreaterThan(0)
  expect(urls[0].startsWith('http://127.0.0.1:9102/api/agents')).toBe(true)
  expect(urls[0].includes('object Promise')).toBe(false)
})
