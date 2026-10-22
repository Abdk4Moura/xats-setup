# Launch checklist

Status of the "ship it" blockers. Keep this current; it is the thing we consult
before any public post.

## Blockers

| # | Blocker | State | Notes |
|---|---|---|---|
| 1 | macOS never verified | **cleared** | GitHub-hosted `macos-latest` in the matrix; suite passes on node 22 and 24. |
| 2 | Windows never verified for the suite | **cleared** | `windows-latest` x node 22/24 green (installer smoke separately). |
| 3 | Vendored daemon | **open** | `assets/daemon/cli.js` is a patched overlay of `cross-agent-teams-mcp@0.7.4`. For public distribution either upstream the patches or publish the delta. Shipping a silently patched third-party build is a trust problem. |
| 4 | Naming | **open** | `xats` vs `cross-agent-teams-mcp` appear side by side in README and error text. Pick one front-facing name. |
| 5 | One-command demo | **open** | `xats demo`: starts two sessions, exchanges a message, shows both sides. Doubles as smoke test and reviewer-verifiable claim. |
| 6 | Security page | **open** | Threat model, especially prompt-injection via peer messages: approval model, `manual` default, loopback-only daemon, no inbound port, every message visible in the host UI. |

## CI gates

`.github/workflows/ci.yml` runs on every PR and on `main`:

- `test`: ubuntu / macos / windows x node 22 and 24, `npm ci && npm test`
- `install-smoke`: dry run then a real install into a sandboxed `HOME` on all three
  OSes, asserting the pi extension, pi skill and opencode plugin land where expected

Three traps this CI exists to prevent:

1. **Uncommitted source.** The first green-looking CI run executed **47 of 90**
   tests because 5 test files (and the Claude mod, Codex component, overlay
   discovery, peer config and OpenCode TUI plugin) had never been committed. CI
   tested an older subset of the project and passed. The guard step now asserts
   the test-file count, so an incomplete checkout fails instead of going green.
2. **Glob-dependent test discovery.** Shell globbing breaks on Windows `cmd`, and
   a glob that matches fewer files still exits 0. `scripts/run-tests.mjs`
   enumerates `test/*.test.mjs` and passes explicit paths to `node --test`.
3. **Installer skipping an absent agent.** `install.mjs` correctly skips an agent
   whose config dir does not exist, so a smoke test must create
   `.config/opencode` first — otherwise the assertion fails for the right reason.

## Cross-cutting lesson: exit 0 lies

Three separate defects in one day all shared a shape — a *status* that disagreed
with *state*:

| Where | Status said | State was |
|---|---|---|
| `tunlion expose` (pre-fix) | exit 0 | saved but **not bound** |
| `tunlion join` | error / exit != 0 | peer had **already certified** the device |
| CI test job | success, 47 tests | suite is **90 tests** |

Rule for anything user-facing or automated: **verify state, not status.**
Concretely, before trusting a step, read back the thing it claims to have made
(`--list`, `addr --json`, file presence, test counts) rather than the exit code.

## Roadmap (not blockers)

- federation: signed envelopes + handle discovery + relay (design agreed, unbuilt)
- tunlion library embed (`L3::dial` / `open_link`) replacing CLI + socket dialing
- LiteLLM-in-CI so repeated Claude Code integration runs do not spend real quota
