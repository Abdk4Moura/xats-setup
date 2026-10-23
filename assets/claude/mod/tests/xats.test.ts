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
  noIdentity?: boolean
}

/** A hand-rolled mods API, just the calls this mod makes. */
function fake$(options: FakeOptions = {}) {
  const submitted: any[] = []
  const fetches: string[] = []
  const scheduled: Array<() => void> = []
  let inboxServed = 0

  // Match the real mods API: { status, ok, headers, text } with text as a string.
  const asJson = (value: unknown) => ({ status: 200, ok: true, headers: {}, text: JSON.stringify(value) })

  const $: any = {
    env: { get: async (name: string) => (name === 'XATS_BASE' ? 'http://127.0.0.1:9100' : undefined) },
    fs: { read: () => undefined },
    session: { id: async () => 'sess-1' },
    http: {
      fetch: async (url: string) => {
        fetches.push(url)
        if (url.includes('/api/agents')) {
          return asJson({ agents: options.noIdentity ? [] : (options.agents ?? [AGENT]) })
        }
        if (url.includes('/api/inbox')) {
          inboxServed += 1
          // Only the first poll sees the message, the way a cursor works.
          const messages = inboxServed === 1 ? (options.messages ?? [MESSAGE]) : []
          return asJson({ messages, has_more: false, last_event_id: 7 })
        }
        return asJson({ ok: true })
      },
    },
    prompt: {
      submit: async (event: any) => {
        if (options.submitFails) throw new Error('no turn available')
        submitted.push(event)
        return { ok: true }
      },
    },
    ui: { invalidate: async () => {}, resolve: () => ({}) },
    clock: {
      after: (_ms: number, fn: () => void) => {
        scheduled.push(fn)
      },
      every: (_ms: number, fn: () => void) => {
        scheduled.push(fn)
      },
    },
  }

  return { $, submitted, fetches, scheduled }
}

function fresh() {
  __internals.reset()
}

/** Run everything the poll scheduled (delivery is debounced onto the clock). */
async function flush(scheduled: Array<() => void>) {
  while (scheduled.length > 0) {
    const fn = scheduled.shift()!
    await fn()
    // let the async continuation of that callback settle
    await Promise.resolve()
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
  expect(submitted[0].text).toContain('from pi-host: deploy window (needs reply)')
  expect(submitted[0].text).toContain('xats_inbox')
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
  await __internals.deliver($)
  expect(__internals.bandText()).toBe('✉ xats · claude-host-abcd1234')
})

test('a failed submit keeps the mail pending for a retry', async () => {
  fresh()
  const { $ } = fake$({ submitFails: true })

  await __internals.poll($)
  await __internals.deliver($)

  expect(__internals.state().pending).toBe(1)
  expect(__internals.state().lastError).toContain('no turn available')
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
