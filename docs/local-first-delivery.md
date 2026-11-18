# Local-first xats delivery

Status: proposed design, not implemented. Existing transports remain unchanged.

## Decision

Optimize the common case: agents on the same machine should receive messages
through their host's event loop, with correct peer attribution and no terminal
pasting. Keep xats as the single authority for cross-vendor identity, durable
mailboxes, and routing. Do not build a new terminal multiplexer.

Native Claude messaging is a useful host transport, not a replacement for the
cross-vendor bus. Existing HTTP MCP, stdio MCP, host plugins, turn hooks, and
paired-host federation remain supported.

## Architecture

```text
sender (any supported host)
            |
     xats send / MCP / REST
            |
     durable local mailbox + outbox
            |
     per-recipient ordered delivery dispatcher
        /              |                  \
 native host       event-driven        pull-only / next-turn
 transport         plugin adapter      compatibility adapter
        \              |                  /
          recipient host queue and inbox

For another machine: persist locally, route through existing peer service,
then use that machine's local delivery dispatcher.
```

Persist the message and its delivery intent in one transaction before any wake.
Local dispatch never depends on peer discovery, pairing, or an overlay being up.
Do not replace loopback HTTP with Unix sockets everywhere just for their own sake:
removing polling and integrating host queues matters more than socket type.

## Separate identity, endpoint, and lifecycle

- Mailbox identity is durable and independent of PID, pane, or socket path.
- A runtime endpoint is leased and bound to one mailbox plus a session generation.
- Reconnection replaces the old lease. A late acknowledgement from an older
  generation cannot acknowledge a new attempt or change its binding.
- Bind through an authenticated host integration or explicit user-authorized
  pairing. A scanned socket filename, display name, or supplied PID alone is not
  authority to bind an inbox.
- Advertise capabilities explicitly: native peer attribution, host queue admission,
  receipt support, readiness events, payload limits, and protocol/version support.
- Report working/idle/blocked/offline/unknown separately from mailbox presence.
  Idle means neither approval to inject input nor successful task completion.
- Bindings and local credentials must never be exported by federation or public
  roster APIs. A same-user daemon is not a sandbox against arbitrary same-user
  processes; document that trust boundary rather than claiming otherwise.

## Transport preference

Pick one delivery owner for each recipient generation. Do not run native delivery
and the existing polling submitter for the same message concurrently.

1. A verified native, attributed host transport, when authorized and compatible.
2. A connected host plugin consuming scoped arrival events and using host-native
   submission, with replay after disconnect.
3. Existing next-turn hooks or explicit inbox reads for hosts without a suitable
   live submission API.
4. Existing terminal-control paths remain explicit legacy compatibility options,
   not the default local route and never a way around a host's refusal.

Existing Codex/OpenCode API adapters remain available, subject to their actual
capabilities. Pi uses its own extension/event loop. Antigravity currently has MCP
and a skill only; no push capability should be advertised until verified.

A scoped local subscription should push arrival hints to connected adapters.
Replay comes from the mailbox cursor, not a second queue with independent truth.
Reuse a suitable existing MCP notification connection when supported; otherwise
add a narrowly scoped adapter stream. Do not revive an unscoped global event feed
or claim an SSE write proves host admission. Polling remains a recovery path for
older adapters, not the steady-state default for the new connected adapter.

## Delivery semantics

Expose what is known, not a single optimistic delivered flag:

| Observation | What it proves |
|---|---|
| stored | Message committed to the mailbox |
| transport-written | Bytes handed to a transport, receipt not established |
| host-queued | Host explicitly acknowledged admission to its queue |
| held | Host awaits recipient approval |
| inbox-consumed | An inbox API or adapter advanced its cursor |
| model-turn-started | Host confirmed a turn containing the message, if supported |
| replied | A correlated reply was stored |
| refused / expired / failed | Explicit outcome at a named delivery stage |
| unknown | An attempt may have landed; do not disguise it as failure or success |

Track these as facts about a message and its delivery attempts, not one strictly
linear state machine. A reply may arrive without a queue acknowledgement. A
transport without receipts cannot claim host-queued or model-turn-started.

Use stable message IDs, per-recipient sequence numbers, explicit attempt IDs,
and session generations. An outbox worker retries definite pre-admission failures
with bounded backoff and coalesces wake hints. If a write may have landed, retry
only where the receiver deduplicates that message ID, or retain an unknown outcome
until reconciliation. Do not promise exactly-once model execution.

A host refusal is terminal for that delivery request. Never switch to a plugin,
next-turn hook, or terminal paste to evade it. A hold waits for the host's user
approval, not a timer-driven fallback. Unsupported capability before dispatch can
select another compatible adapter; uncertain acceptance cannot blindly fail over.

Wake hints may point to durable content in the inbox. Direct body delivery must
avoid a second model-visible delivery when the model later reads that inbox.
Keep human UI display, host submission acknowledgement, and mailbox consumption
as distinct cursors/receipts. Advancing a notice cursor is not a read receipt.

## Claude-native experiment

Static inspection of installed Claude Code 2.1.295 found a local cross-session
UDS receiver, native peer-attributed queue admission, held/refused/dropped status
handling, permission-mode parity checks, and notify-when-idle controls. Native
SendMessage explicitly says a successful send does not establish model reading.
The hidden socket option and internal framing are not a public stability contract.

Before implementing a production adapter:

1. Prefer a documented host/plugin API if it can provide the same semantics.
2. In isolated owned test sessions, verify available native capability and whether
   an external xats adapter can use it legitimately, with honest xats provenance.
3. Do not spoof a Claude session, acquire arbitrary session credentials, change
   crossSessionInbound policy, force feature gates, or bypass permission parity.
4. Verify idle and busy delivery, holds, refusal, reconnect, process recycling,
   duplicates, and shutdown. A successful socket write is not sufficient evidence.
5. If legitimate third-party access cannot be established, keep the current
   attributed plugin transport and make its arrival path event-driven instead.
6. Roll out only with explicit opt-in and tested version/capability bounds.

Do not republish proprietary Claude code. Derive adapter behavior from permitted
interfaces and independently written code.

## What to learn from Herdr

Herdr is a terminal runtime/workspace, not merely a messaging bus. Its current
core owns PTYs, process lifetime, attach/read/send/wait operations, parent-child
relationships, and SSH-connected machines. The app adds a configurable desktop
UI and mobile access. The older Herdr TUI is separate and also supports screen
recognition of agent states; current core relies on program-reported OSC 7501.

Borrow lifecycle signals, explainable delivery diagnostics, correlated helper
completion, and a simple user-facing CLI. Do not infer task success from terminal
idle. Do not adopt terminal ownership, raw input injection, or a desktop UI as
requirements for xats. A future Herdr adapter can be separate from the mailbox.

The examined current core notes implementation types tagged notes into the
parent terminal with paste and Enter. This is useful terminal automation, but a
textual sender tag alone is not the same boundary as host-native peer attribution.

## Implementation sequence and gates

1. Specify and test additive attempt/receipt semantics and session leases. Preserve
   current APIs; do not silently redefine existing wake-status fields.
2. Prototype native Claude access in isolated sessions before adding a production
   transport. Stop that path if access requires spoofing or policy bypass.
3. Build the ordered outbox dispatcher and scoped connected-adapter wake path;
   prove crash recovery, backpressure, and cursor replay with a fake transport.
4. Integrate one compatible host at a time. Select one owner per message and
   generation; retain compatibility adapters and rollback without duplicate sends.
5. Verify cross-vendor and remote-to-local flows still work with the peer service
   disabled for local-only runs and enabled for actual cross-host runs.
6. Benchmark idle/busy latency and CPU against the current 3-second Claude poll.
   Report p50/p95, queue admission versus model response, duplicates, missed
   messages, held messages, and failure recovery. Publish no speedup claim first.

Required tests include mailbox commit before wake, daemon restart after dispatch,
lost acknowledgements, adapter disconnect, stale/recycled endpoints, duplicate
sends, separate tabs in the same project, ordered delivery, blocked approval UI,
refusal without fallback, held-message expiration, and existing host/peer tests.
Linux/macOS/Windows must remain supported; UDS-only success is not parity.

## Sources

- Static inspection of the installed Claude Code 2.1.295 executable; internal
  behavior observed locally, not a public protocol guarantee.
- [Herdr app](https://herdr.dev/)
- [Herdr core](https://herdr.dev/core/)
- [Herdr TUI agents](https://herdr.dev/tui/docs/agents/)
- [Herdr TUI automation](https://herdr.dev/tui/docs/agent-automation/)
- [Core note delivery implementation](https://github.com/herdrdev/herdr-core/blob/master/crates/herdr-core/src/notes.rs)
