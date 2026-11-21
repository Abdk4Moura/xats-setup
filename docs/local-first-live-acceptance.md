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

## Re-run after the fixes (rig7)

Isolated rig on Claude Code 2.1.295, tmux, `XATS_LOCAL_DELIVERY=1` on both daemon and
client, `XATS_BASE` pinned to the rig. Authentication used the host's long-lived
`CLAUDE_CODE_OAUTH_TOKEN`.

Observed, in one run:

| Scenario | Evidence |
|---|---|
| `auto_poke:false` (wake suppressed) | No outbox row at all for that message, no attempt facts. The polling path is the only owner. |
| Wake permitted | One outbox row, generation 1, attempt facts `claimed` then `inbox-consumed`. No `refused` fact at any point. |
| Daemon killed and restarted mid-session | Pending row left `stored`, then gained generation 1 and was consumed; mailbox cursor advanced to the newest event with no manual `/mcp`. |
| Reply to a recipient last seen beyond 180 s | Message stored and retrievable; delivery status `skipped` with `queued_unreachable`. |

Aggregate check over the run: `refused`-then-`inbox-consumed` attempts = **0**.
The session stayed live through the restart (band present, no reconnect prompt).

### Restart detail (rig8, focused)

A second focused run killed the daemon mid-session and sent one message after restart:

- outbox row: `unknown`, generation **1** (it left `stored` and was claimed by a lease generation, so the plugin re-armed on its own)
- attempt facts: `claimed` -> `unknown` (the submit outcome was genuinely uncertain, which is recorded rather than guessed)
- mailbox cursor advanced from 1 to **3**, so the message was consumed through the inbox path
- pane text showed no `MCP server disconnected · open /mcp` prompt; recovery needed no manual reconnect
