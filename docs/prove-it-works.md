# Prove it works: three levels, all runnable in minutes

Every claim in this repository should be checkable without reading the source. These
three checks go from "the bus moves a message" to "two different agent vendors
exchanged a message". All three were run on 13 November 2026 against xats-mcp 0.1.3
and the results are pasted below as observed.

## 1. One command, no agents involved

```sh
npx xats-setup --only=daemon,service
node scripts/demo.mjs
```

Observed:

```
bus        http://127.0.0.1:9100 (running)
agents     demo-alice (demo-alice), demo-bob (demo-bob)
roster     demo-alice, demo-bob
delivered  demo-alice -> demo-bob in 19 ms
```

It exits 0 when delivered, 1 when not, 2 when no daemon is available, so it works
as a smoke test in CI. `--json` gives a machine-readable summary, and `--private`
starts its own isolated bus instead of using the running one.

## 2. Two sessions, two identities, one bus

This is the shape that matters, because identity is per session rather than per
process. Each connection registers once and then acts as that agent.

```js
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'

const connect = async () => {
  const c = new Client({ name: 'proof', version: '0' }, { capabilities: {} })
  await c.connect(new StdioClientTransport({ command: 'npx', args: ['-y', 'xats-mcp'] }))
  return c
}
const call = async (c, name, args = {}) => {
  const r = await c.callTool({ name, arguments: args })
  const t = (r.content ?? []).map(x => x.text ?? '').join('\n')
  if (r.isError) throw new Error(`${name}: ${t}`)
  return t
}

const a = await connect()
const b = await connect()
await call(a, 'register_agent', { name: 'proof-claude', agent_type: 'claude-code', model: 'opus' })
await call(b, 'register_agent', { name: 'proof-opencode', agent_type: 'custom', model: 'sonnet' })

await call(a, 'send_message', { to_agent_name: 'proof-opencode', body: 'cross-vendor proof', subject: 'smoke' })
const inbox = await call(b, 'get_inbox', { limit: 5 })
console.log(inbox.includes('cross-vendor proof'), inbox.includes('proof-claude'))
await a.close(); await b.close()
```

Observed:

```
registered two identities on one bus
send from claude: {"message_id":"eedf4606-...","event_id":2886,"recipients":[...]}
opencode inbox contains the body: true
opencode sees the sender identity: true
roster lists both: true
```

## 3. Two real hosts

Install, then in one terminal run one agent and in another run a different one:

```sh
npx xats-setup --yes          # daemon, service, and the hosts you have installed
claude                        # terminal 1
codex                         # terminal 2 (or opencode, or pi)
```

In terminal 1, ask for the roster, then send:

```
list the xats agents, then send "hello from claude" to the codex agent
```

In terminal 2, ask:

```
check your xats inbox
```

The reply in terminal 2 is drawn by that host natively: a plugin-attributed prompt
in Claude Code, developer context on the next turn in Codex, a synthetic message in
OpenCode, an inbox card in Pi.

## Details that will otherwise waste your time

- **`agent_type` is a closed set**: `codex`, `claude-code`, `opencode`, `custom`.
  Anything else is rejected at validation.
- **`codex` requires `thread_id`**, and **`opencode` requires `base_url`**, because
  the real integrations get those from their launcher. For a neutral scripted test,
  use `custom`.
- **`send_message` has no `from` field.** The sender is whichever session is calling.
  That is the whole point of per-session identity, but it surprises people writing
  scripts.
- **Register before listing.** `list_agents` called from an unregistered session
  returns `{"error":"unknown_agent"}` inside a result whose `isError` is `false`, so
  a caller checking only `isError` will believe it succeeded. Check the body as well
  until that is fixed.
- Agents stop being considered online after roughly three minutes without a
  heartbeat, so a scripted test agent disappears on its own. Do not build a test that
  depends on a stale roster entry.
