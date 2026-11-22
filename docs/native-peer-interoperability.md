# Native Claude peer interoperability

Status: development candidate, not in xats-setup 0.3.15. Do not confuse the
released connected plugin-notice transport with this native IPC adapter.

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
Claude's leased arrival adapter submits the notice through the native inbox
socket instead of `prompt.submit`. The notice points to the full inbox content,
so the body is not injected once natively and again through an automatic read.

Stock Claude sessions without the xats mod do not gain the additional discovery
section. Native Claude-only peer entries remain unchanged.

## Capability selection and opt-out

The candidate requires a Linux native inbox socket exported by Claude Code,
Python 3 with Linux `SO_PEERCRED`, and the installed daemon/Claude integration.
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
- Native endpoints are private, mailbox-specific sockets. Discovery is extended
  through documented mod hooks, not private Claude session-registry writes.
- The host-exported messaging token is inherited from the owning session where
  available. It is never taken from peer-key files, journaled, logged, or listed.
- An external write is journaled before dispatch. Replayed attempts and changed
  lease generations cannot blindly resend a message that was held, refused, or
  may have landed. Lost mailbox-commit responses stay unknown.
- Native `delivered` after an inbound Claude send means the xats mailbox commit
  succeeded, not that Pi read it. A native `delivered` callback from Claude means
  host queue admission, not model comprehension. Raw wire statuses are retained.
- Explicit host refusals and expirations are terminal. A held request changes
  only after an actual correlated native host receipt, never a fallback timer.
- The existing local outbox, lease, generation fences, acknowledgement retries,
  and MCP inbox cursor remain authoritative. The native journal is a dispatch
  fence, not a second mailbox or an independent delivery owner.

As with the existing same-user loopback API, this is not a sandbox against other
processes running as the same operating-system user.

## Sources

- [Claude cross-session messaging and exported inbox socket](https://code.claude.com/docs/en/cross-session-messaging#the-sessions-inbox-socket)
- [Documented session.send and session.receive mod API](https://code.claude.com/docs/en/plugins/mods/api#send-and-receive-messages-between-sessions)
- [Tool and command middleware](https://code.claude.com/docs/en/plugins/mods/events)
- [Current host-generated tool and mod types](https://code.claude.com/docs/en/plugins/mods/create#get-the-types-for-your-build)
