# Changelog

## 1.0.0 — first release we own

The predecessor is not a released version of this package: it was a patched
bundle vendored inside `xats-setup` whose provenance claimed upstream 0.7.4
while serving routes upstream never had.

### Added

- `session_key` persisted on register and exposed in `agents.list` and the
  public row, so a client that knows only its own session id can find its agent.
- `name_mode: "prefer" | "exact"` claim semantics: a session keeps the name it
  claimed across a resume, `exact` refuses a live name with `409 name_taken`, and
  `prefer` allocates `-2`, `-3`, …
- `/api/agents/all`: the cross-team roster peer federation advertises.
  **Reconstructed** — it exists in no upstream commit.
- Hostname-safe device labels: a hostname that normalises to nothing, or exceeds
  64 characters, is shortened deterministically (55 chars + 8 hex) instead of
  preventing startup. An explicit `--device` still fails loudly.

### Changed

- A Claude Code peer is never woken by typing into a tmux pane. Without a live
  channel the wake reports `no_transport_available` and the mail waits in the
  inbox for the agent's next turn.
- The device label, `session_key` and claim logic are the only intentional
  behavioural deltas from the vendored bundle.

### Removed — BREAKING

- `/api/events` (Server-Sent Events). No shipped adapter calls it: the pi
  extension was its only consumer and its SSE path is gone. Delivery is the
  explicit-cursor poll of `/api/inbox?since_event_id=N`, which is also what
  survives a daemon restart.
  - Migration: poll `/api/inbox` with your own cursor. Do not rely on a stream.
  - If an external client is found that polls it, add a deprecation stub that
    returns `410 Gone` rather than restoring the second delivery path.

### Notes

- Lineage: contains code derived from `jtianling/cross-agent-teams-mcp` @
  `7c37997`, imported as a snapshot. No merge base is claimed. See `SOURCE.md`
  and `NOTICE`.
