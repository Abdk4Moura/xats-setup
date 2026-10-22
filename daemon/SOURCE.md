# Lineage

`xats-daemon` is a daemon we maintain, not a fork that tracks anything.

- **Ancestry:** contains code derived from
  [`jtianling/cross-agent-teams-mcp`](https://github.com/jtianling/cross-agent-teams-mcp)
  (MIT). Copyright in that work remains with its authors; see `NOTICE`.
- **No upstream claim.** This is not "stock 0.7.4" and not "0.7.4 plus patches".
  There is no upstream commit whose contents equal this tree, and none is
  implied. The version here is ours.
- **Why it is ours:** the published package and the vendored copy we used to run
  disagreed about which REST endpoints exist (3 vs 8), the published source map
  matched neither, and the features we depend on live in neither
  (`session_key`, honest peer wake, hostname-safe labels). Reconciling that
  against a moving upstream costs more than owning four files.

## What differs from the published package

Functional changes, all covered by tests in the consuming repo:

| Area | Change |
|---|---|
| identity | `session_key` persisted on register, exposed in `agents.list` and the public row, so a client that knows only its own session id can find its agent |
| wake | a Claude Code peer is never woken by typing into a tmux pane; without a live channel the wake reports `no_transport_available` and the mail waits in the inbox |
| device label | a hostname that normalises to nothing, or exceeds 64 chars, no longer prevents startup — it is shortened deterministically (55 chars + 8 hex) or falls back to `local`; an explicit `--device` still fails loudly |
| SSE | `/api/events` is not implemented. Wake latency comes from the client's 3 s poll; the endpoint existed to shave that to ~0 and was not worth a second delivery path to maintain |

## Build

```bash
npm ci && npm run build   # esbuild -> dist/cli.js, deps external
```

The build is a single bundled ESM entry with dependencies external, matching the
consumer's install layout (`~/.xats/daemon/node_modules/xats-daemon`).
