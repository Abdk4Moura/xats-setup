# Launch checklist

Status of the "ship it" blockers. Keep this current; it is the thing we consult
before any public post.

## Blockers

| # | Blocker | State | Notes |
|---|---|---|---|
| 1 | macOS never verified | **cleared** | GitHub-hosted `macos-latest` in the matrix; suite passes on node 22 and 24. |
| 2 | Windows never verified for the suite | **cleared** | `windows-latest` x node 22/24 green (installer smoke separately). |
| 3 | Vendored daemon | **cleared** | The daemon is ours: `daemon/src` built by `npm run build:daemon`, MIT, upstream credited in `daemon/NOTICE`, lineage stated in `daemon/SOURCE.md` (upstream basis `7c37997`, imported as a snapshot, **no merge base claimed**). The vendored `assets/daemon/cli.js` and the false `PROVENANCE.json` are deleted. |
| 3b | Licence | **cleared** | Root `LICENSE` (MIT) + `NOTICE` crediting upstream; both shipped in the tarball. |
| 4 | Naming | **open** | `xats` vs `cross-agent-teams-mcp` appear side by side in README and error text. Pick one front-facing name. |
| 5 | One-command demo | **cleared** | `npm run demo` starts two agents, delivers a message and reports latency (~13 ms locally); `--private` ignores any running bus, and CI runs it on every platform. | `xats demo`: starts two sessions, exchanges a message, shows both sides. Doubles as smoke test and reviewer-verifiable claim. |
| 6 | Daemon repo public | **open** | Source ships inside the `xats-setup` tarball, so it is readable either way; a standalone public repo is the cleaner launch story. Your call. |
| 7 | Security page | **cleared** | `docs/SECURITY.md`: trust boundaries table, the `manual`/`shared`/`open` decision with the reasoning for an allowlist, revocation, and an explicit prompt-injection section stating what remains after approval. | Threat model, especially prompt-injection via peer messages: approval model, `manual` default, loopback-only daemon, no inbound port, every message visible in the host UI. |

## CI gates

`.github/workflows/ci.yml` runs on every PR and on `main`, 13 jobs:

| Job | Matrix | What it proves |
|---|---|---|
| `test` | ubuntu / macos / windows x node 22, 24 | the suite, 90 tests, daemon-backed ones skipped (no deps on a clean checkout) |
| `install-smoke` | ubuntu / macos / windows | installer in a sandboxed `HOME` **and** `XDG_CONFIG_HOME`; dry run first, then a real install |
| `test-daemon` | ubuntu / **macos-13 (x64)** / **macos-14 (arm64)** / windows | the daemon-backed identity tests actually execute (`npm ci` provides `fastify` + `better-sqlite3` via the devDependency) |

Guards that exist because each one caught a real failure:

- assert the test-file count — CAUGHT: 20 files were never committed, so a "green"
  run covered 47 of 90 tests over half a project.
- assert `# tests 90` and that the daemon-backed identity test **ran** (by name, not
  `# skipped 0`) — one skip is legitimate: the routed-namespace E2E needs Linux
  root + netns, which a hosted runner does not grant.
- preflight prints `platform/arch/os/hostname`, resolves `fastify`, opens
  `better-sqlite3` and runs a statement, and `file`s the native `.node`.
- `macos-13` and `macos-14` are pinned rather than `macos-latest`, because native
  ABI and image drift are exactly what was failing.

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

## Product findings from CI

- **Daemon refuses to start on an unusable hostname.** `resolveLocalDeviceLabel`
  normalises `os.hostname()` and throws `invalid_device_label` when the result is
  empty or over 64 chars — while falling back to `"local"` when the label is
  *absent*. macOS hostnames are commonly dotted or spaced (`Mac's MacBook Pro`),
  so first run can fail for a reason no user could guess. Should normalise, then
  fall back, exactly like the absent case. Found by the macOS runner via the
  daemon's stderr; open, and it belongs with the vendored-daemon decision below.

## Roadmap (not blockers)

- federation: signed envelopes + handle discovery + relay (design agreed, unbuilt)
- tunlion library embed (`L3::dial` / `open_link`) replacing CLI + socket dialing
- LiteLLM-in-CI so repeated Claude Code integration runs do not spend real quota
