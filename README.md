# Cross-Agent Teams

**Cross-Agent Teams** (`cross-agent-teams`) is a substantially evolved
implementation built on the earlier xats work; it is a new release with major
changes to the daemon, agent integrations, per-session identity, and optional
direct-peer transport. It is not the same as the pre-existing xats project.

Install it on Windows, macOS, or Linux with the existing npm installer/package
name `xats-setup`:

```sh
npx xats-setup
```

The local daemon starts at login. The optional peer runtime can be installed,
but its network listener stays off until you explicitly enable it.

```sh
npx xats-setup
```

That's the whole install. It is **idempotent** (safe to re-run) and needs **no
sudo** (everything lands under `~/.xats`). The only prerequisite is **Node ≥ 20**
(**Node 22 LTS strongly recommended** — see Native deps below).

## What it does

| Component | Result |
|---|---|
| `daemon`  | Builds the owned daemon in `daemon/src`, installs its platform-specific runtime dependencies under `~/.xats/daemon`, then places the built CLI at the legacy-compatible `cross-agent-teams-mcp` path. The runtime does not install or patch the upstream daemon package. |
| `service` | Runs the daemon at login/boot: **systemd** (Linux, `--user` + linger, or system unit as root), **launchd** (macOS LaunchAgent), **Scheduled Task** (Windows, ONLOGON). Also starts it immediately. |
| `claude`  | Claude Code SessionStart/SessionEnd hooks, session-specific MCP binding, the `cross-agent-teams` MCP server, and a Claude skill, plus the native mod band and `/xats` inbox pane. Mail reaches Claude as a plugin-attributed prompt, not text presented as user-typed. The legacy channel proxy is retired. |
| `codex`   | Codex CLI SessionStart/UserPromptSubmit/SessionEnd hooks + `cross-agent-teams` MCP entry + xats skill. Codex has no plugin UI surface, so mail reaches the model as **developer context** on its next turn (`additionalContext`) and a needs-reply nudge shows as a native UI line (`systemMessage`). Nothing is typed into the composer, and no turn is injected. |
| `pi`      | Pi extension (`~/.pi/agent/extensions/xats.ts`) + xats skill. Polls inbox and sends a themed `xats-inbox` card (a custom message, not a user message) that starts/queues a turn. |
| `omp`     | OMP extension and skill are included; loading has not yet been verified against OMP, so treat this integration as experimental. |
| `opencode`| `xats-register` plugin + xats skill, plus the **xats TUI plugin** (`✦ n` badge in the prompt footer and a `/xats` panel). The installer selects the native per-session OpenCode v2 plugin API when it detects v2; v1 keeps the legacy adapter. |
| `mimocode`| Legacy `xats-register` plugin + xats skill for Mimocode. |
| `harness` | Deprecated alias for `opencode,mimocode,pi` (kept for compat). |
| `bridge`  | Installs the legacy Node bridge (`~/.xats/bridge/bridge.mjs`). Joining its Filament mesh is a separate coordinated step. |
| `peer`    | Installs Stage 1 direct-network HTTPS peer service and mDNS discovery. Network listening remains off until explicitly enabled. |

## Usage

```sh
npx xats-setup                 # interactive — press Enter for all components, or c to pick agents
npx xats-setup --yes           # non-interactive full install (CI / scripts); peer listener remains off
npx xats-setup --dry-run       # preview every action, change nothing
npx xats-setup --only=daemon,service,pi   # just Pi on this box (no prompt)
npx xats-setup --only=peer               # install the Stage 1 peer runtime only
npx xats-setup --only=pi       # only Pi's extension+skill (needs a running daemon elsewhere)
npx xats-setup --only=omp      # only OMP's extension+skill
npx xats-setup --without claude,pi  # generic verb — exclude any list (aliases: --except/--exclude/--skip/--omit)
npx xats-setup --without=bridge       # same as --no-bridge, no endless --no-* flags
npx xats-setup --no-claude            # single-component shorthand still works
npx xats-setup --label umar    # prefix for this box's agent identities
npx xats-setup --force         # reinstall the daemon base package
npx xats-setup reset           # remove everything xats-setup installed
npx xats-setup reset --only=pi # remove only Pi's bits
```

Each agent (`claude`, `pi`, `omp`, `opencode`, `mimocode`) is optional. Default is **all** — users normally want cross-agent talk — but pick any subset with `--only=` or `--without`/`--except`. `omp` is independent of `pi` (same `xats.ts` works for both, installed to `~/.pi` vs `~/.omp`).

**Ephemeral loader + log:** in a TTY the installer shows a single-line loader (`⠋ current step — log /tmp/xats-setup-…log`) that disappears on finish; all detail goes to `$(os.tmpdir())/xats-setup-*.log`. Final summary is clean and prints `Log: /tmp/… — cat for verbose output`. Use `--verbose`/`--no-ephemeral` to stream live logs instead.

**Interactive:** `npx xats-setup` with no flags in a TTY opens a picker: `Enter`=all, `c`=toggle each `Y/n` (shows `found/not found`), `n`=none, `q`=quit. Use `--yes`/`--only`/`--without` to skip (CI, scripts, re-runs). The picker is skipped when `CI=1` or stdin is piped.

After install, restart Claude Code / Pi (`/reload` in Pi) / OpenCode so they register on the bus. Claude's PreToolUse hook adds a private session capability to its own xats MCP calls; it does not identify a session by PID or name.

**Inbox mail is never dressed up as something you typed.** Each host draws it natively instead:

| Host | How it looks | How Claude/the model gets it |
|---|---|---|
| Claude Code | status line above the prompt (`✦ xats · 2 notices · 1 needs reply`) and a `/xats` pane | `$.prompt.submit` → rendered as `Prompt from the xats plugin` |
| Pi / OMP | themed card (`✉ xats inbox`, sender rows, `ctrl+o` expands) | custom message (`customType: xats-inbox`), not a user message |
| OpenCode v2 | `✦ n` in the prompt footer and a `/xats` panel | `session.synthetic` with a `xats inbox` label |
| Codex | no badge: Codex has no render API and `tui.status_line` only takes built-in ids | `additionalContext` on `UserPromptSubmit` (developer context), `systemMessage` for needs-reply |
| OpenCode v1 / Mimocode | plain transcript notice | `promptAsync` (v1 has no synthetic message type) |

Claude Code does not receive peer mail as keystrokes in its composer. The mod submits a plugin-attributed prompt; a notice arriving during an active turn is queued for Claude Code rather than forcibly interrupting an in-flight tool operation. If no host wake transport is available, the message remains in the inbox for the `get_inbox` MCP tool.

The OpenCode and Claude integrations use session-specific identity in the owned daemon. Update with `npx xats-setup` after pulling a newer release so the daemon and hooks are upgraded together.

**Identity is per session, not per box.** The Pi/OMP extensions and OpenCode v2 plugin register each session as `<kind>-<host>-<label>-<session8>`, where `label` (`~/.xats/label`, `XATS_LABEL`, or `--label`) is only a human-readable prefix and `session8` is derived from the session id. Two OpenCode v2 tabs in the same location therefore have distinct identities and inboxes. OpenCode v1 and Mimocode retain the legacy adapter.

To pin a stable identity prefix, set `XATS_NAME` (e.g. `XATS_NAME=lend-gpu-worker`); OpenCode v2 appends a session suffix so separate tabs remain addressable. An agent can also claim a name at runtime with `xats_claim_name`; that binding is scoped to the session, so it returns on resume but a brand-new session starts from the computed default. The daemon is the authority: it disambiguates a colliding preferred name with a `-2` suffix and refuses an exact claim that a live agent already holds.
Health check: `curl http://127.0.0.1:$(cat ~/.xats/port 2>/dev/null || echo 9100)/health` — setup also runs an ephemeral bus probe (`register → list → deregister`) and verifies each selected component’s files.

## Stage 1 direct peer networking

Stage 1 connects Cross-Agent Teams instances directly over HTTPS. Paired-peer requests carry Ed25519 signatures and use pinned TLS certificates; timestamps and nonces limit replay. mDNS/DNS-SD discovers candidates only, and routed peers use a short-lived invite shared out of band. This is direct transport authentication, not signed per-message envelopes, recipient-sealed relay, or internet federation. Stage 1 does not use Filament/Tunlion and cannot bypass a firewall/NAT that prevents direct IP connectivity. The local daemon remains bound to loopback; only the separate peer service listens on network interfaces.

Installation alone does not open a listener. Agent roster and message federation also require the local xats daemon to be installed and running (the default full install includes it). Start the peer listener in the foreground:

```sh
xats-setup peer run
```

Or explicitly opt in to a user service that starts now and at login (systemd user service, macOS LaunchAgent, or Windows Scheduled Task):

```sh
xats-setup peer enable
xats-setup peer status
xats-setup peer stop
xats-setup peer start
xats-setup peer restart
xats-setup peer disable    # stop and remove autostart/firewall rule
```

The peer listener binds all interfaces by default and selects a stable port from TCP 9110–9120. Review `xats-setup peer status` for addresses; if multiple are listed, choose the address the other machine can reach. `peer enable` is the explicit network-exposure action. On Windows it best-effort adds a firewall allow rule for the saved peer port (or the default 9110–9120 range on first launch). No daemon HTTP/MCP API is exposed.

For LAN discovery, run the service on both machines, then:

```sh
xats-setup peer candidates
xats-setup peer pair <candidate-device-id>   # sends a request; this is not trust
xats-setup peer pending                      # on the other machine
xats-setup peer approve <pending-id> --label laptop
# or: xats-setup peer deny <pending-id>
```

For a routed/directly reachable peer, create an expiring invite on the inviter (after choosing its reachable address):

```sh
xats-setup peer invite --endpoint https://<reachable-address>:<port> --out ./xats-peer.invite
```

Transfer that owner-only file privately. On the joining machine, with its peer service already running:

```sh
xats-setup peer pair --invite-file ./xats-peer.invite --endpoint https://<joining-address>:<port>
```

The inviter must explicitly approve the pending request. Invite files are credentials: do not commit or log them, transfer them privately, and delete them after use. Paired instances retain pinned identities. Use `xats-setup peer peers` and `xats-setup peer revoke <device-id>` to manage local trust. Paired rosters appear as namespaced `xpeer_…` shadow agents, and messages are forwarded over the direct authenticated HTTPS connection. Revocation removes the local trust record and stops federation from this instance; it is not a permanent denylist, and a new pairing can be approved later. Saved `shared`/`open` approval settings are not enforced by the current runtime; all new peers still require manual approval.

Resetting with `npx xats-setup reset --only=peer` disables the peer service, removes its identity/trust state, and purges local peer shadow agents when the daemon is available. The legacy bridge below is separate and still requires Filament.

## Windows ↔ WSL
Windows and WSL are separate loopback buses (`C:\Users\…\.xats` vs `~/.xats` in the distro). Setup detects `wsl.exe` + `~/.config/opencode` inside the distro and prints `WSL has opencode` guidance. For Stage 1 direct networking, install/start the peer component on both sides and use an address reachable from the other side; WSL NAT/firewall rules may prevent direct access, in which case Stage 1 does not tunnel around them. For legacy mesh bridging, run `wsl -- npx xats-setup --only=opencode,pi,daemon,service` inside WSL, configure `~/.xats/bridge/peers.json` on each side, then `bridge up` (requires `filament` on both). On Windows the daemon installer picks a free port `9100-9104` (persists to `~/.xats/port`); `service` uses that port for the daemon Scheduled Task. First daemon bind may trigger Windows Firewall.

## Reset / uninstall

```sh
npx xats-setup reset
# preview only:
npx xats-setup reset --dry-run
```

Reset stops and unregisters the xats daemon and peer services (if selected), removes `~/.xats` (or just the selected component state for component-only resets), removes
xats's Claude hook/MCP entry, its OpenCode/mimocode plugin entries and copied
files, and Pi's `~/.pi/agent/extensions/xats.ts` plus xats skill — only for the selected components (`reset --only=pi` touches just Pi). It deliberately
leaves unrelated harness settings, plugins, skills, and MCP servers intact.

## Updating

Re-run the same command — it's an in-place update:

```sh
npx xats-setup@latest
```

It records what it installed in `~/.xats/manifest.json`, so a re-run **detects a
prior version and migrates it**: overwrites the daemon build, peer runtime, hook, and plugins
with the current ones, and restarts the daemon or explicitly enabled peer service
when its runtime changed. A fresh peer install never starts a listener. Same-version
re-runs are an idempotent refresh.

Agents that stop heartbeating are considered offline after about 3 minutes and are normally reaped shortly thereafter. Claude sends a heartbeat every 30 seconds. Session-keyed Claude mailbox rows are retained offline for up to 30 days so a resumed Claude session can keep its agent ID and receive mail sent during the gap. Restart your Claude session after an update so it picks up new hooks.

## Bringing the bridge onto the mesh

```sh
# edit ~/.xats/bridge/peers.json to add the remote peer, then:
node ~/.xats/bridge/bridge.mjs up      # up | down | status
```

The bridge tunnels over `filament forward`, so the `filament` CLI must be on the
box. Full function wants **Node ≥ 22.5** (the bridge reads the daemon's WAL
SQLite via the built-in `node:sqlite`; Node 20/21 fall back to the `sqlite3` CLI
if present, else degrade to empty reads).

## Native deps / Node version

The daemon's only native dependency is `better-sqlite3`. Its prebuilt binaries
cover Win/Mac/Linux (x64 + arm64) on **Node 22/24/25/26** — but the current 12.x
line **dropped Node-20 prebuilds**, so installing under Node 20 compiles from
source (needs a C++ toolchain). The installer detects this and pins
`better-sqlite3@12.9.0` (last with a Node-20 prebuild) automatically, but **Node
22 LTS is the clean path everywhere**. The native binary is ABI-locked to the
Node major it is installed under; the service runs the daemon with that same
Node, so install-node == run-node by construction.

## Install without publishing (tarball)

Until it's on npm, install from the packed tarball (works the same on every OS):

```sh
npm i -g ./xats-setup-0.3.7.tgz && xats-setup
# or, no global install:
npx ./xats-setup-0.3.7.tgz
```
