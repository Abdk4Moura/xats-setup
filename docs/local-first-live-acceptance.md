# Local-first live acceptance on a real Claude Code host

Status: run on 2026-11-20 and 2026-11-21 on this VPS in isolated rigs, with a real
host and a real model (not a stub). The installed CLI is **Claude Code 2.1.330**;
an earlier revision of this file wrongly said 2.1.295. Where a result depended on a
specific head, the head is named next to it.

## Rig setup

Two rigs, both isolated from the production bus:

- Rig 1: daemon without opt-in, i.e. the default delivery path.
- Rig 2: `XATS_LOCAL_DELIVERY=1` on **both** the daemon and the Claude process.

Each rig had its own `CROSS_AGENT_TEAMS_MCP_HOME`, database, port, project
directory, and tmux session. Claude ran with `--setting-sources ''` plus explicit
`--settings` hooks pointing at `assets/claude/xats-hook.mjs`, `--plugin-dir`
`assets/claude/mod`, `--strict-mcp-config` with a single MCP entry for the rig
daemon, and `XATS_BASE` pinned so the hook could not fall back to `~/.xats/port`.

Raw rig artifacts are not committed. They stay under
`/root/.cache/xats-tasks/rigL`, `rigO`, `rigN` and the earlier rig directories on
the machine that ran them: `daemon.log`, `state/data.db`, `pane.log` and
`result.json` per rig. The numbers quoted below are read from those files, and the
reproducible proof of criterion 3 is the committed test
`test/local-delivery-restart.test.mjs`, which starts a real daemon, kills it, and
restarts it against the same database.

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

### Superseded: the live rig re-run

This note described the period when the host session had expired
(`OAuth session expired`). It was later re-authenticated and the rig was re-run;
see the resolution and final-run sections below. Nothing here is still open.

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

**Resolved since that note.** Identity reclaim plus a call-time binding rule fixed
the restart case; see the resolution section below.

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

## Resolution (rigH)

Two changes fixed the restart case, and one wrong guess was removed:

- The daemon marks every identity that had an MCP binding as `binding_lost` when it
  starts, and a reconnecting session reclaims that same row by name instead of being
  suffixed into `-2`.
- The binding is established **at tool-call time, on the session that is actually
  calling**, and only when exactly one identity lost its binding. Binding a
  background session from a REST call was the earlier bug: the client replaced that
  session and the binding landed on a dead one.

rigH, one run, head `0a5e2bf` (the only later commit changed tests):

| Check | Result |
|---|---|
| `auto_poke:false` | outbox row exists, `inbox-consumed`, generation 1. The leased owner acts; polling does not also deliver. |
| normal send | `inbox-consumed`, generation 1 |
| daemon killed and restarted mid-session | same identity (`binding_lost` 0, no `-2`), one `mcp lazy rebind` log line, pending row `inbox-consumed` with generation 1, cursor advanced to the new event (5) |
| aged recipient (>180 s) | stored, status `skipped` / `queued_unreachable` |
| refused-then-consumed attempts | 0 |

Honest limits of that run: the host still rejects the plugin's own submit after a
restart (the attempt journal shows `unknown`), so the pending mail reached the model
through a normal inbox read in a user turn, not through the plugin's submit. No
`/mcp` reconnect was needed, and the row reconciled to `inbox-consumed` once the
message was genuinely read. This is a real resume of delivery to the same mailbox,
but it is not evidence of working post-restart prompt submission.

## Final verification (rigI)

Run on head `bdedda3` with `XATS_LOCAL_DELIVERY=1` on both daemon and client,
`XATS_BASE` pinned to the rig, Claude Code in tmux.

| Criterion | Evidence from this run |
|---|---|
| 1. No refused-then-consumed attempt | aggregate query returned **0**; the plugin may only reconcile `unknown` with a real read, and a focused test reproduces the old bypass and now fails to reproduce it |
| 2. `auto_poke:false` has exactly one owner | outbox row `inbox-consumed`, generation 1, facts `claimed` -> `inbox-consumed`; polling returns early while the local owner is active |
| 3. Restart resumes without `/mcp` | cursor 1 before restart; pending row `inbox-consumed`, generation 1 afterwards; one `mcp lazy rebind` log line; single identity, `binding_lost` 0; no `/mcp` prompt |
| 4. Aged recipient stored | message row present, status `skipped` / `queued_unreachable` |

Focused tests added or updated for each behaviour: `test/local-delivery-owner.test.mjs`
(ownership, queued-unreachable), `test/claude-mod-local-delivery.test.mjs` (busy vs
refused, refusal never rewritten, re-arm), `test/agent-identity-durability.test.mjs`
(reclaim after a lost binding), `test/binding-recovery.test.mjs` (fail-closed rebind
rule), `test/local-delivery-api.test.mjs` (single owner, broadcast isolation).

Two limits are stated rather than hidden. The host still rejects the plugin's own
prompt submission after a restart, so the pending mail reached the model through a
real inbox read in a user turn; the attempt journal records that submit as `unknown`
and is reconciled to `inbox-consumed` only after the read. And no live host refusal
was induced in this rig, because the local-first path cannot force one; the
invariant is proven by the focused test rather than by a live refusal.

### Final run on the shipped head (rigJ, `85f42e1`)

| Criterion | Measured |
|---|---|
| 1 | refused-then-consumed attempts: **0**; a new test proves a refusal survives an advanced cursor plus a replacement generation (the auditor's exact reproduction) |
| 2 | `auto_poke:false`: one outbox row, `inbox-consumed`, generation 1; polling returns early while the local owner is active |
| 3 | cursor 1 before the restart, event 3 after; pending row `inbox-consumed` with generation 1; one `mcp lazy rebind`; single identity; `binding_lost` 0; no `/mcp` |
| 4 | aged recipient: message stored, status `skipped` / `queued_unreachable` |

## Rig-by-rig evidence on the shipped code (head `9bea393`, unchanged since)

All rigs ran with `XATS_LOCAL_DELIVERY=1` on daemon and client, `XATS_BASE` pinned
to the rig, and Claude Code in tmux. The only commits after `9bea393` are tests and
this document.

| Criterion | Live evidence | Deterministic proof |
|---|---|---|
| 1. no refused-then-consumed | rigL/rigO injected a real refusal through the daemon's own ack path (`stage=refused`): outbox and attempt stayed `refused`, facts `claimed, refused`, and a later real inbox read did not change it. Aggregate `refused_then_consumed = 0`. | `local-delivery-store.test.mjs`: "a refused delivery is never reconciled as consumed by a later read", "a held delivery is never reconciled as consumed"; `claude-mod-local-delivery.test.mjs`: "a refused event stays refused when the cursor advanced and a new generation reclaims it" |
| 2. one owner for `auto_poke:false` | rigN: quiet send produced exactly one outbox row, `inbox-consumed`, generation 1, exactly 1 attempt, cursor advanced; polling returns early while the local owner is active. | `local-delivery-owner.test.mjs`, `local-delivery-api.test.mjs` "explicit auto_poke false still has exactly one delivery owner" |
| 3. restart resumes without `/mcp` | rigM: row `claimed`/generation 1 before the kill, `inbox-consumed`/generation 1 after the restart, one `mcp lazy rebind`, single identity, `binding_lost` 0, no `/mcp`. rigL separately captured a row `stored`/generation null at the moment of the kill. | `local-delivery-restart.test.mjs`: real daemon, `SIGKILL`, restart, then assert `stored`+null generation at kill, claim with a generation, ack `host-queued`, real inbox read, `inbox-consumed`, cursor advanced |
| 4. aged recipient stored | rigL/rigO/rigN: message row stored, status `skipped`/`queued_unreachable`, body retrievable | `local-delivery-owner.test.mjs` "a recipient past the reachability window is stored, not refused" |

Limitation stated plainly: no single live run captured a row that was `stored` at
the kill *and* then claimed with a generation, because the plugin claims within
about a second and my process-pause attempts did not reliably stop it. rigL caught
the `stored` moment with an expired lease; rigM/rigO caught claimed → generation →
consumed. The two halves are each observed live, and `local-delivery-restart.test.mjs`
covers the combined case deterministically against a real daemon process.

## Pane text (the model side)

The rigs captured the Claude pane to `pane.log`. After stripping terminal escapes,
the delivery lines read:

```text
✦ xats · 1 notice pending · 1 needs reply
›Prompt from the xats plugin
```

That is the plugin submitting the notice as a plugin-attributed prompt, not text in
the person's composer, and the band showing the outstanding notice. In the restart
rigs the same band reappears after recovery without any `/mcp` prompt:

```text
✦ xats · claude-vps3584156-rigM-b7d45ab4
```

Where the model could not submit (the host rejects `prompt.submit` after a restart on
this build), the pane shows the model reading the inbox itself, and the row is
reconciled to `inbox-consumed` only after that read.

## The two restart shapes (rigS, pinned Claude Code 2.1.295)

The rig ran on the exact version named by the acceptance criterion, because the
installed CLI had since auto-updated to 2.1.330. Two distinct cases matter:

1. **Row `stored` when the daemon dies** (the case the criterion describes). rigR
   captured `stored` / generation null at the kill; after the restart the row was
   still there and the session's real inbox read consumed it with the cursor moving
   3 -> 5. `test/local-delivery-restart.test.mjs` proves the full chain
   deterministically: `stored` + null generation at kill, claim with a lease
   generation after restart, ack `host-queued`, real read, `inbox-consumed`, cursor
   advanced.

2. **Row already `claimed` when the daemon dies** (in flight). rigS sent and killed
   within the claim window: status `claimed` at the kill, then `unknown` after the
   restart, and the plugin did not re-claim it for that same lease generation. That
   is deliberate: `claimed` means a hint may already have been handed to a host, and
   the store refuses to re-deliver an uncertain attempt under an unchanged
   generation. It is resolved by a later real read (through `consumeThrough`), not by
   a blind retry. This is a documented limit, not the criterion's scenario.
