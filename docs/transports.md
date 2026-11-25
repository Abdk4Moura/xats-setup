# Delivery transports

Every harness shares one mailbox authority. What differs is how a session learns
that mail arrived, and only that.

The daemon publishes a wake on every commit. The lease long-poll returns the
moment that happens, so there is no fixed delivery delay.

| Shape | Used by | Behaviour |
|---|---|---|
| Lease long-poll | Claude Code, Pi | One request per 20 s idle window, returns immediately on a commit |
| Prompt-time injection | Codex, OpenCode without a server | Mail is added as context on the next prompt |
| Timer scan | fallback only | Every 3 s, used when the daemon answers 404/501 for the lease |
| Tmux poke | Antigravity | The daemon types a short notice into a bound pane |

## Invariants

- The mailbox is authoritative. Wakes and pokes carry no bodies and no delivery
  state.
- A lease fences ownership: one delivery owner per mailbox and generation. The
  same attempt is replayed until it is acknowledged, so a lost response cannot
  become a second turn.
- A client fetches hinted events through the normal inbox path and acks
  `host-queued`, then `inbox-consumed` when the daemon cursor proves a read.
- A held message blocks later mail for that mailbox until it is decided. That is
  a policy answer, not a transport limit.

## Why each harness differs

- Claude Code's `$.http.fetch` resolves only after the body is read, so the mod
  cannot hold a streaming response. It uses the lease long-poll, which wakes on
  the same commit.
- Antigravity exposes no turn API to a plugin, so a wake is a tmux keystroke into
  a bound pane, guarded by a quiet check and a single-line draft save/restore.
- Codex and OpenCode without a server read mail at prompt time rather than
  accepting an injected turn.

## Adding a harness

Register with a session key and `local_delivery: true`, then long-poll
`/api/local-delivery/wait`. Fetch the hinted event, submit once, and ack
`host-queued`, then `inbox-consumed` when the cursor shows a read. Never treat a
wake as delivery.
