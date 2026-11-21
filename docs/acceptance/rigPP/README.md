# rigPP acceptance bundle

One isolated rig run with the **real model** that exercises all four acceptance
criteria for local-first delivery (PR #10). Nothing here touches the production
bus: the daemon, database, port, project directory, tmux session, and
`CROSS_AGENT_TEAMS_MCP_HOME` are all rig-local, and `XATS_BASE` is pinned to the
rig.

## Environment

- Host: **Claude Code 2.1.295** (pinned binary), the version the criterion names.
- Inference: the **real model** over the host's own OAuth credentials. No stub.
- `XATS_LOCAL_DELIVERY=1` on both the daemon and the client.
- tmux, `--setting-sources ''`, explicit `--settings` hooks, `--plugin-dir`
  `assets/claude/mod`, `--strict-mcp-config` with one MCP entry for the rig
  daemon.
- `helpers/rig-guard.mjs` is a `UserPromptSubmit` hook used to induce a *real*
  host refusal (exit 2) for criterion 1.
- `helpers/hold-wait.mjs` occupies the single per-(agent,generation) delivery
  wait slot so the plugin cannot claim, which is how the criterion-3 row is left
  pending across the restart.

The driver in this bundle takes the token path from `CLAUDE_TOKEN_FILE` so no
credential is committed.

## Files

| File | What it is |
|---|---|
| `driver.sh` | The exact rig script that produced this run. |
| `daemon.log` | Daemon log; shows the restart and the lazy rebind. |
| `pane.txt` | Final tmux pane capture. |
| `timeline.txt` | Criterion-3 outbox transitions after the restart. |
| `outbox.tsv` | `message_id`, `status`, `generation`, `attempt_id`. |
| `attempts.tsv` | One row per attempt. |
| `facts.tsv` | Ordered additive facts per attempt. |
| `cursor.tsv` | Mailbox cursor for the Claude identity. |
| `leases.tsv` | Lease generation and liveness. |
| `messages.tsv` | Mailbox events, in order. |
| `helpers/` | Wait-slot holder and submit guard. |

## Results against the criteria

Event map: 1 = aged-recipient payload, 2 = refused, 3 = trigger read,
4 = single owner, 5-6 = the model's own replies, 7 = pending across restart.

### 1. No refused-then-consumed attempt

`b6df2f29` (event 2) was refused by the **real host**: the `UserPromptSubmit`
hook exited 2, so `prompt.submit` resolved `{drop}` and the plugin classified it
`refused`.

- outbox: `refused`, generation 1
- facts: `claimed`, `refused`
- after a later real implicit inbox read (event 3, which consumed through event
  3): still `refused`, facts unchanged `claimed, refused`, no `inbox-consumed`
  fact.

### 2. `auto_poke:false` has exactly one owner

`a016592a` (event 4) was sent with `auto_poke:false`.

- send response `poked:false`
- exactly **1** attempt for that message
- facts: `claimed` -> `host-queued` -> `inbox-consumed` (generation 1)
- cursor advanced to 7 by the end of the run
- pane showed `✦ xats · 1 notice pending · 1 needs reply` while it was pending

The polling path did not act: it returns early while the local owner is active,
and no poke was sent. One owner, the outbox.

`host-queued` is the line that was missing before: the real host resolves
`prompt.submit` to `PromptSubmitResult` (`{text}` on entry, `{drop}` on refusal)
with no `ok` field, so every successful submit used to be recorded `unknown`.
`f17af7a` reads the real shapes.

### 3. Restart resumes without manual `/mcp`

`3969268a` (event 7) was claimed but not acknowledged, then the daemon was
killed.

| Moment | Row |
|---|---|
| at kill | `claimed`, generation 1 |
| after restart (released) | `stored`, generation null |
| +4 s | `host-queued`, generation 1 |
| +6 s | `inbox-consumed`, generation 1 |

- the row left `stored` and gained lease generation 1 after the restart
- cursor advanced 4 -> 7, to the new message
- exactly one `mcp lazy rebind` in `daemon.log`
- no `/mcp` in the pane

### 4. Aged recipient stored and retrievable

A send to a recipient last seen 300 s ago returned
`queued_unreachable: true, unreachable_seconds: 300`; the body
`PP-C4-reply-payload` was retrievable from the mailbox afterwards.

## Notes

- The criterion-3 row passes from `stored` to `host-queued` inside one 2 s
  sample, so the intermediate `claimed` state is not always visible in
  `timeline.txt`. The facts table records both claims (the pre-kill holder claim
  and the post-restart plugin claim) plus `host-queued`, which is the evidence
  that the restarted plugin re-armed and delivered.
- The `held` stage is covered by focused tests and by the same terminal rule
  that covers `refused`; this run induced a `refused`, not a `held`.
