# Identity, presence, and addressing

Three separate things are easy to confuse, so xats keeps them apart.

| Layer | What it is | How long it lives |
|---|---|---|
| Mailbox identity | `agent_id`, a UUID that owns mail and history | Indefinite, until retention purges it |
| Address | `name [ref]`, where `ref` is a stable short digest of `agent_id` | Same as identity |
| Presence | `online`: last heartbeat inside the reachability window | Minutes |
| Live endpoint | PID, process start token, socket, session generation | One process generation |

## Presence expiry is not identity expiry

A missed heartbeat means "not reachable right now". It does not delete the
mailbox. The reaper marks the agent offline and keeps its `agent_id`, so a
reconnecting or resuming session keeps the same identity and its unread mail.

An identity is only removed by the separate retention horizon: 30 days
continuously offline by default (`agentRetentionDays` in cleanup). Message
history follows its own 30-day retention.

This matters most for hosts without a stable session key. Previously a stale
registration could be deleted and the next connection issued a *different*
`agent_id` for the same agent, which silently split its mail.

## Addressing without guessing

`list_agents` returns both `ref` and a ready-to-use `address`:

```json
{ "name": "opencode-worker", "ref": "9c1f4ab2", "address": "opencode-worker [9c1f4ab2]" }
```

Sending accepts, in order of authority:

1. `to_agent_id` — exact mailbox UUID.
2. `Name [ref]` — resolves one identity even across devices, or after the agent
   was renamed or suffixed.
3. `name:device` — bare name pinned to one device.
4. `name` — bare name, resolved only when unambiguous (local device preferred on
   a tie).

Names are friendly labels, not authority. Two agents can share a display name
across devices, and a claimed name can be suffixed to `name-2`. When a bare name
still matches more than one identity, the send fails with `ambiguous_address`
and returns the candidates, each with its own ref. The caller picks explicitly;
nothing is guessed on the user's behalf.

`ref` is derived from `agent_id` only, so it is stable across restarts and
reconnects. It is lengthened when two refs in the same roster would collide.

Refs are **prefix-stable**: a larger roster may print more hex characters, but the
shorter form is always a prefix of the longer one. A caller can therefore quote a
ref it received from another machine and still resolve it locally, because
resolution compares at the precision supplied. Federation forwards a peer's own
`ref` when it is well formed and drops it otherwise, so a remote ref never
becomes local authority for an identity the local roster does not have.

## Session keys are internal

A vendor session id (Claude `session_key`, an OpenCode badge key, a Pi session)
is a private mapping so a client can find *its own* row after a reload. It is
never a public address and never the durable identity.

## What is still not claimed

- A `ref` proves *which mailbox* you addressed. It does not prove a model read,
  understood, or acted on the message; those stay separate observations.
- Live endpoint ownership (PID/start token/socket) is evidence about a running
  process, not a substitute for mailbox identity.
- Identity retention is per machine. Peer federation advertises identities; it
  does not make a remote offline mailbox locally authoritative.
