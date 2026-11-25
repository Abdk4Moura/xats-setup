# Native Claude peer interoperability

Status: shipped in xats-setup 0.3.16 for Linux Claude Code sessions. Connected
plugin notices remain the fallback for other platforms and hosts, and
`XATS_NATIVE_PEERS=0` selects them explicitly.

## User-facing behavior

With the updated xats mod on a compatible Linux Claude session, native peer
interoperability is selected automatically. `ListAgents` and `/list-agents`
include a separate **xats peers** section for online non-Claude agents. Entries
retain their real harness type and durable xats identity. Claude can address one
with its existing `SendMessage` tool, using `xats:<agent_id>` from the listing.
The mod readdresses that send to the peer's actual IPC endpoint; Claude still
runs its native send implementation and destination checks.

A native endpoint represents an xats mailbox, not a fabricated Claude session.
Pi and Antigravity continue using their normal xats integrations. The bridge
receives native Claude traffic and commits it to the addressed mailbox before
returning a native admission receipt. Their replies remain durable xats mail;
Claude's leased arrival adapter delivers the full message body through the
native inbox socket, with an honestly labeled `xats:` peer envelope. It does not
inject an `<xats-inbox>` notification or ask Claude to fetch that body again.
Native host admission is not treated as a canonical MCP read receipt.

`XATS_NATIVE_DELIVERY=notice` selects the older native-notification/MCP-fetch
behavior for compatibility. Unset means full native body delivery.

Stock Claude sessions without the xats mod do not gain the additional discovery
section. Native Claude-only peer entries remain unchanged.

## Capability selection and opt-out

The candidate requires a Linux native inbox socket exported by Claude Code,
Python 3 with Linux `SO_PEERCRED`, and the updated daemon/Claude integration.
The mod probes the daemon's receipt-observation capability before native I/O;
an older daemon keeps connected plugin notices.
No additional host binary is downloaded. A lightweight helper is attached to the
Claude session and stops when the owning process or mod ends.

No flag is needed when those capabilities are present. To use connected plugin
notices instead, launch a fresh session with:

```sh
XATS_NATIVE_PEERS=0 claude
```

`XATS_LOCAL_DELIVERY=0` still selects compatibility polling. Other platforms or a
missing native capability retain the existing connected integration before any
native dispatch. A failed or uncertain native dispatch never falls back to a
second submission method for that message.

## Identity, delivery, and recovery

- The helper accepts native traffic only from its explicitly bound Claude
  process, checking kernel PID/UID and process-start evidence as well as the
  session's exact reply address.
- Native endpoints are private, mailbox-specific sockets in the host's own
  socket directory, where native policy callbacks can vet them. Their filenames
  are bound to the owner/helper process and mailbox. Cleanup removes only the
  helper's sockets, never Claude's shared namespace. Discovery is extended
  through documented mod hooks, not private Claude session-registry writes.
- The host-exported messaging token is inherited from the owning session where
  available. It is never taken from peer-key files, journaled, logged, or listed.
- An external write is journaled before dispatch. Replayed attempts and changed
  lease generations cannot blindly resend a message that was held, refused, or
  may have landed. Lost mailbox-commit responses stay unknown.
- Native `delivered` after an inbound Claude send means the xats mailbox commit
  succeeded, not that Pi read it. A native `delivered` callback from Claude means
  host queue admission, not model comprehension. Direct accepts do not normally
  emit that positive wire callback. For those, the mod records admission only
  after the documented `session.receive` continuation returns queued text matching
  the exact outstanding notice, attempt, event and generation. This evidence is
  labeled `admission_source: session.receive`; a `delivered` wire packet is never
  fabricated. Socket writes alone remain `transport-written`.
- Explicit host refusals and expirations are terminal. A held request changes
  only after a correlated real host receipt or queued host continuation, never a
  fallback timer. A released hold wakes receipt reconciliation even while the
  adapter is waiting for another daemon hint.
- The existing local outbox, lease, generation fences, acknowledgement retries,
  and MCP inbox cursor remain authoritative. A live observer can report a late
  receipt only for the same mailbox and session, explicitly naming its original
  attempt and generation. Ordinary stale ACKs still fail. The daemon settles the
  actual original attempt, not a fabricated replacement dispatch; a covering
  read cannot erase a delayed refusal. Read reconciliation uses the daemon's own
  stored MCP cursor, never a client-supplied cursor.
- The native journal is a dispatch fence, not a second mailbox or an independent
  delivery owner.

As with the existing same-user loopback API, this is not a sandbox against other
processes running as the same operating-system user.

## Acceptance scope

CI requires actual native interoperability on Claude Code 2.1.295 and 2.1.330,
with accept, refuse, hold/release and restart-before-refusal profiles on each. Each fixture has its own
HOME, native socket, loopback daemon and synthetic model endpoint. It exercises
real `ListAgents`, `SendMessage`, native IPC and MCP inbox tools. The peer is a
Pi-typed durable mailbox fixture, not a running Pi model.

The refusal profile explicitly reads the inbox after refusal and requires the
attempt to remain refused. A second refusal profile restarts the daemon while
the native host holds the notice, then obtains its actual refusal and reconnects
the real MCP client. A live replacement observer must settle the original
attempt and generation even after that inbox read. The hold profile changes the
fixture's trusted host policy, requires actual release without another dispatch,
and then reads the inbox. Queue-admission evidence, one outbox attempt, and restart persistence are
asserted separately. These are required gates, not a claim that a pending CI run
has passed.

## Delivery transport

Delivery hints, not bodies, reach a session. Claude Code and Pi long-poll the
same delivery lease, and Antigravity is woken through a bound tmux pane.
See [transports](transports.md) for the invariants and why each harness differs.

## Sources

- [Claude cross-session messaging and exported inbox socket](https://code.claude.com/docs/en/cross-session-messaging#the-sessions-inbox-socket)
- [Documented session.send and session.receive mod API](https://code.claude.com/docs/en/plugins/mods/api#send-and-receive-messages-between-sessions)
- [Tool and command middleware](https://code.claude.com/docs/en/plugins/mods/events)
- [Current host-generated tool and mod types](https://code.claude.com/docs/en/plugins/mods/create#get-the-types-for-your-build)
