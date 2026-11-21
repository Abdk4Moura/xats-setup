# Local-first live acceptance on a real Claude Code host

Status: run on 2026-11-20 against Claude Code 2.1.295 (Opus, Max account) on this
VPS, in isolated rigs. This is the interactive acceptance PR #10 was waiting for.
It is a real host and a real model; it is not a stub.

## Rig setup

Two rigs, both isolated from the production bus:

- Rig 1: daemon without opt-in, i.e. the default delivery path.
- Rig 2: `XATS_LOCAL_DELIVERY=1` on **both** the daemon and the Claude process.

Each rig had its own `CROSS_AGENT_TEAMS_MCP_HOME`, database, port, project
directory, and tmux session. Claude ran with `--setting-sources ''` plus explicit
`--settings` hooks pointing at `assets/claude/xats-hook.mjs`, `--plugin-dir`
`assets/claude/mod`, `--strict-mcp-config` with a single MCP entry for the rig
daemon, and `XATS_BASE` pinned so the hook could not fall back to `~/.xats/port`.

Evidence kept in this directory: `daemon.log`, `data.db` (rig 1),
`daemon-local-first.log`, `data-local-first.db` (rig 2), `cursor.json`.

## Verified working

1. Registration and model-authored bind both work. The model reported the bind
   in its own words, and `leases` shows one bound session.
2. Identity survives a daemon restart: the same `agent_id` came back, matching
   the retention change merged earlier.
3. **Local-first delivery works end to end** when `auto_poke` is left at its
   default. The send created an outbox row, the plugin claimed it (`claimed`
   fact), attempted the host submit, and the model acted on the message:
   - outbox row reconciled to `inbox-consumed`, generation 1
   - mailbox cursor advanced 0 -> 2
   - the model quoted the sender and the subject it had actually received
4. The host renders the peer message with its own framing line ("This is how
   Claude Code surfaces a prompt a plugin submits between turns - it starts this
   turn in the user's place") rather than faking the person's words.
5. No composer injection. The text that looked like a composer draft in an
   earlier observation is the TUI's suggested-prompt placeholder, not inserted
   message text.

## Gaps found (these keep PR #10 in draft)

1. **A host submit refusal is recorded and then delivery still happens.**
   Facts for one attempt were `claimed` -> `refused` (about 300 ms later) ->
   `inbox-consumed`. `register.js` maps a non-ok `$.prompt.submit` result to
   `refused`, and the message was subsequently read through the inbox path. The
   design says a refusal is terminal and must not be routed around, so either
   the refusal cause needs to be distinguished (busy vs policy) or the fallback
   must not run after a refusal.
2. **`auto_poke:false` skips local-first enqueue entirely.**
   `send-message.ts` enqueues only when `auto_poke !== false`, so those messages
   bypass the local-first owner and arrive later through the polling path. That
   means two delivery owners depending on a send flag, which is exactly what the
   one-owner rule is meant to prevent.
3. **No automatic recovery after a daemon restart.** The host showed
   `MCP server "cross-agent-teams" disconnected · open /mcp to reconnect`; the
   cursor did not advance and pending outbox rows stayed `stored` with no lease
   generation until a manual reconnect. Observed in both rigs.
4. **A reply to an aged-out sender is lost.** Replying to a REST-registered
   sender older than the 180 s reachability window failed with `unreachable` and
   queued nothing. The model reported this honestly; the reply itself was not
   preserved for later delivery.

## Operator notes

- Two restart attempts failed with `daemon already running pid=...` because the
  replacement started while the old process was still shutting down and its pid
  file existed. Waiting for the pid file to disappear, or retrying after the old
  process exits, is required. This is the documented fail-closed behaviour, not
  a new bug.
- Driving the TUI needs `tmux send-keys ... C-m`; a bare `Enter` was swallowed.
- Pointing a rig at the production bus is easy to do by accident: the hook reads
  `XATS_BASE`, not `XATS_PORT`. During setup two throwaway agents registered on
  the production bus and were deregistered immediately; production is back to
  its prior agent count with no residue.

## What would let PR #10 merge

Fix items 1 and 2 (single delivery owner, refusal handling), make item 3 recover
automatically or document the manual reconnect as intended, and decide whether
item 4 should queue instead of failing.

## Fixes landed (branch `feat/local-first-delivery`)

Four changes address the findings above. Verified by CI on `b14286c`
(10/10 jobs) and by focused tests:

1. **Single owner.** `send-message.ts` enqueues a local delivery row only when a
   wake is permitted (`auto_poke !== false`) *and* the recipient holds a live
   local lease. With `auto_poke:false` no owner is activated and the poll path is
   the only one; without a lease the poll path owns it. `test/local-delivery-owner.test.mjs`
   asserts both directions, plus expired-lease and self-send.
2. **Honest submit outcomes.** `classifySubmitResult` separates `busy`
   (journaled as held, unacknowledged, retried with bounded backoff at the next
   turn boundary) from an explicit `refused` (terminal, and a refused journal is
   never converted to inbox-consumed, including across restart and replacement
   generation). Unclassifiable failures are `unknown`, not an invented refusal.
3. **Re-arm after restart.** A failed wait or lease renewal no longer surrenders
   ownership: the owner keeps retrying with bounded backoff, refreshes the lease
   from disk, and never falls back to polling. Covered by the restart test.
4. **Queued unreachable.** A send to a recipient past the 180 s window is stored
   in the mailbox and recorded as `skipped` / `queued_unreachable`, with no
   delivered or queued claim.

### Still open: the live rig re-run

Acceptance criteria 1 and 3 require a real model session (a submit attempt and a
model inbox read). On 2026-11-21 the host CLI reported
`Failed to authenticate: OAuth session expired and could not be refreshed`, so
the rig cannot run until the session is re-authenticated with `claude /login`.
Tasks 3 (rig half) and 5 stay open for that reason; everything that does not need
a model is done and green.

## Status after the audit (corrected)

The earlier revisions of this file overstated two things; both are corrected here.

**What the rigs actually showed.** rig7 and rig8 ran Claude Code **2.1.330** (not
2.1.295). rig7 showed `auto_poke:false` producing no outbox row, a wake-permitted
message producing one row claimed and consumed, and the aged-recipient send stored
with `skipped` / `queued_unreachable`. rig8's restart case is a **failure**, not a
success: the pending row was claimed by the old identity, the submit ended
`unknown`, and the model then re-registered as a second identity
(`claude-...-rig8-568ab16d-2`, cursor at the registration baseline) because the MCP
session binding is lost when the daemon restarts. The original message stayed
unread on the old identity. Reading two agent cursors as one advancing cursor was a
misreading.

**Fixes landed since.** `send-message.ts` now gives a leased recipient exactly one
owner even when `auto_poke:false`, and `register.js` no longer rewrites a journaled
`refused` or `held` outcome as `inbox-consumed`; only `unknown` may reconcile with a
real read. Tests cover both.

**Still open (blocks completion).** Criterion 3: after a daemon restart the
reconnecting session must reclaim its previous identity instead of registering a new
one, so pending rows are delivered to the same mailbox and its cursor advances. That
requires a daemon-side rule for reclaiming an identity whose MCP binding died with
the process, plus a rerun of the rig to prove it.

### rig9: identity reclaim works, delivery still blocked

After the reclaim fix, the same restart scenario produced **one** Claude identity
(`claude-...-rig9-2d79c9a9`, `binding_lost = 1`) instead of the previous `-2`
split, so the identity regression is fixed.

Delivery still did not resume. The post-restart row ended `unknown` (facts
`claimed` -> `unknown`) and the mailbox cursor stayed at 1. The pane explains it:
the model was stopped on a host confirmation prompt ("register as a new agent with
the same name", Enter to confirm), so no turn ran and `prompt.submit` threw.

Root cause: an MCP session's identity binding lives in daemon memory. After a
restart the reconnecting session is unbound, `get_inbox` fails with
`unknown_agent`, and the model's recovery path is a registration/prompt that blocks
the turn. Criterion 3 therefore needs an explicit rebinding design: either the
transport re-binds a session to an existing identity by a durable session key, or
the plugin re-establishes the binding without a model turn. Both change the
identity surface and need a decision before more code.
