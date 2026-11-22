# rigOO acceptance bundle

One isolated rig run that exercises all four acceptance criteria for local-first
delivery (PR #10). Nothing here touches the production bus: the daemon, database,
port, project directory, tmux session, and `CROSS_AGENT_TEAMS_MCP_HOME` are all
rig-local, and `XATS_BASE` is pinned to the rig.

## Environment

- Host: **Claude Code 2.1.295** (pinned binary), tmux, `--setting-sources ''`,
  explicit `--settings` hooks, `--plugin-dir assets/claude/mod`,
  `--strict-mcp-config` with one MCP entry for the rig daemon.
- `XATS_LOCAL_DELIVERY=1` on both the daemon and the client.
- Inference: `helpers/stub-anthropic.mjs`, a local Anthropic-shaped stub (no
  account, no quota). The host, daemon, plugin, and MCP transport are real.
- `helpers/rig-guard.mjs` is a `UserPromptSubmit` hook used to induce a *real*
  host refusal (exit 2) and to hold a submit in flight.
- `helpers/hold-wait.mjs` occupies the single per-(agent,generation) delivery
  wait slot so the plugin cannot claim, which is how the C3 row is left pending.

## Files

| File | What it is |
|---|---|
| `driver.sh` | The exact rig script that produced this run. |
| `daemon.log` | Daemon log; shows the restart and the lazy rebind. |
| `pane.txt` | Final tmux pane capture. |
| `pane-pending.txt` | The transient band captured while a notice was still pending. |
| `timeline.txt` | C3 outbox transitions after the restart. |
| `outbox.tsv` | `message_id`, `status`, `generation`, `attempt_id`. |
| `attempts.tsv` | One row per attempt. |
| `facts.tsv` | Ordered additive facts per attempt. |
| `cursor.tsv` | Mailbox cursor for the Claude identity. |
| `leases.tsv` | Lease generation and liveness. |
| `helpers/` | Stub model, wait-slot holder, and submit guard. |

## Results against the criteria

### 1. No refused-then-consumed attempt

`080d81f2` was refused by the **real host**: the `UserPromptSubmit` hook exited 2,
so `prompt.submit` resolved `{drop}` and the plugin classified it `refused`.

- outbox: `refused`, generation 1
- facts: `claimed`, `refused`
- after a later real implicit inbox read (triggered by `a28695d4`): still
  `refused`, facts unchanged `claimed, refused`; no `inbox-consumed` fact.

### 2. `auto_poke:false` has exactly one owner

`458e1bae` was sent with `auto_poke:false`.

- send response `poked:false`
- exactly **1** attempt
- facts: `claimed` -> `host-queued` -> `inbox-consumed` (generation 1)
- cursor advanced 3 -> 4
- pane showed `✦ xats · 1 notice pending · 1 needs reply`

`host-queued` is the key line: before the classifier fix every success was
recorded `unknown`, because the real host's `prompt.submit` resolves to
`PromptSubmitResult` (`{text}` / `{drop}`) with no `ok` field.

### 3. Restart resumes without manual `/mcp`

`e21b06e9` was claimed but not acknowledged, then the daemon was killed.

| Moment | Row |
|---|---|
| at kill | `claimed`, generation 1 |
| after restart (released) | `stored`, generation null |
| +2 s | `claimed`, generation 1 |
| +4 s | `inbox-consumed`, generation 1 |

- cursor advanced 4 -> 5
- exactly 1 `mcp lazy rebind` in `daemon.log`
- no `/mcp` in the pane

### 4. Aged recipient stored and retrievable

A send to a recipient last seen 300 s ago returned
`queued_unreachable: true, unreachable_seconds: 300`; the body
`OO-C4-reply-payload` was retrievable from the mailbox afterwards.

## Known limits

- The rig uses a stub model, not a paid inference account. The host, daemon,
  plugin, and MCP transport are real, and the host version is pinned to the
  2.1.295 the criterion names.
- The `held` stage is covered by focused tests and by the same terminal rule
  that covers `refused`; this run induced a `refused`, not a `held`.
