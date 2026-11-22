# Delivery transports

Every harness shares one mailbox authority. What differs is how a session learns
that mail arrived, and only that.

The daemon publishes a wake on every commit. Three client shapes consume it:

| Shape | Used by | Behaviour |
|---|---|---|
| Held stream (SSE) | Pi | One connection, `event: hint` as commits land, claim and ack over the same lease |
| Lease long-poll | Claude Code | One request per 20 s window, returns immediately on a commit |
| Prompt-time injection | Codex, OpenCode without a server | Mail is added as context on the next prompt |
| Timer scan | fallback only | Every 3 s, used when the daemon answers 404/501 for the lease |
| Tmux poke | Antigravity | The daemon types a short notice into a bound pane |

## Invariants

- The mailbox is authoritative. Streams and pokes carry hints, never bodies or
  delivery state.
- A lease fences ownership: one delivery owner per mailbox and generation. A new
  stream for the same generation supersedes the old one.
- Hints carry `message_id`, `event_id`, `attempt_id` and `generation`. A client
  fetches the body through the normal inbox path and acks the same stages.
- A dropped stream cannot lose mail. Reconnecting re-claims by cursor.
- A lost ack repeats the same attempt; nothing resubmits a turn from a hint.

## Why not one shape everywhere

- Claude Code's `$.http.fetch` resolves only after the body is read, so the mod
  cannot hold an SSE response. It uses the lease long-poll, which wakes on the
  same commit and has the same acks. Latency is equivalent; it costs one request
  per 20 seconds instead of one held connection.
- Antigravity exposes no turn API to a plugin, so a hint cannot start a turn.
  Its wake is a tmux keystroke into a bound pane, guarded by a quiet check and a
  draft save/restore.
- Codex and OpenCode without a server deliberately read mail at prompt time
  rather than accepting an injected turn.

## Adding a harness

Take the lease with `/api/register` (session key, `local_delivery: true`), then
either hold `/api/local-delivery/events` or long-poll
`/api/local-delivery/wait`. Fetch hinted events, submit once, and ack
`host-queued`, then `inbox-consumed` when the daemon cursor proves a read. Never
treat a hint as delivery.
