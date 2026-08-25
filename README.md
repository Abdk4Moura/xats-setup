# xats-setup

One command, any OS. Stands up an identical **xats cross-agent bus** peer on
Windows, macOS, or Linux — daemon, autostart service, Claude Code hooks,
Pi extension, opencode/mimocode plugins, and the cross-machine bridge.

```sh
npx xats-setup
```

That's the whole install. It is **idempotent** (safe to re-run) and needs **no
sudo** (everything lands under `~/.xats`). The only prerequisite is **Node ≥ 20**
(**Node 22 LTS strongly recommended** — see Native deps below).

## What it does

| Component | Result |
|---|---|
| `daemon`  | Installs the patched `cross-agent-teams-mcp` into `~/.xats/daemon` (stock npm base for native prebuilds, then overlays the OS-agnostic patched `cli.js`). |
| `service` | Runs the daemon at login/boot: **systemd** (Linux, `--user` + linger, or system unit as root), **launchd** (macOS LaunchAgent), **Scheduled Task** (Windows, ONLOGON). Also starts it immediately. |
| `claude`  | Claude Code hook + `cross-agent-teams` MCP entry + xats skill (pure-Node, no bash/jq/curl). |
| `pi`      | Pi extension (`~/.pi/agent/extensions/xats.ts`) + xats skill. Polls inbox and injects an `<xats-inbox>` user message that starts/queues a turn. |
| `opencode`| `xats-register` + `notify-unified` plugins + xats skill for opencode. |
| `mimocode`| Same plugins + skill for mimocode. |
| `harness` | Deprecated alias for `opencode,mimocode,pi` (kept for compat). |
| `bridge`  | Installs the Node bridge (`~/.xats/bridge/bridge.mjs`, zero deps). Joining the mesh is a separate coordinated step. |

## Usage

```sh
npx xats-setup                 # interactive — press Enter for full peer (recommended), or c to pick agents
npx xats-setup --yes           # non-interactive full peer (CI / scripts)
npx xats-setup --dry-run       # preview every action, change nothing
npx xats-setup --only=daemon,service,pi   # just Pi on this box (no prompt)
npx xats-setup --only=pi       # only Pi's extension+skill (needs a running daemon elsewhere)
npx xats-setup --without claude,pi  # generic verb — exclude any list (aliases: --except/--exclude/--skip/--omit)
npx xats-setup --without=bridge       # same as --no-bridge, no endless --no-* flags
npx xats-setup --no-claude            # single-component shorthand still works
npx xats-setup --label umar    # identity label for this box's agents
npx xats-setup --force         # reinstall the daemon base package
npx xats-setup reset           # remove everything xats-setup installed
npx xats-setup reset --only=pi # remove only Pi's bits
```

Each agent (`claude`, `pi`, `opencode`, `mimocode`) is optional. Default is **all** — users normally want cross-agent talk — but pick any subset with `--only=` or `--without`/`--except`.

**Ephemeral loader + log:** in a TTY the installer shows a single-line loader (`⠋ current step — log /tmp/xats-setup-…log`) that disappears on finish; all detail goes to `$(os.tmpdir())/xats-setup-*.log`. Final summary is clean and prints `Log: /tmp/… — cat for verbose output`. Use `--verbose`/`--no-ephemeral` to stream live logs instead.

**Interactive:** `npx xats-setup` with no flags in a TTY opens a picker: `Enter`=all, `c`=toggle each `Y/n` (shows `found/not found`), `n`=none, `q`=quit. Use `--yes`/`--only`/`--without` to skip (CI, scripts, re-runs). The picker is skipped when `CI=1` or stdin is piped.

After install, restart Claude Code / Pi (`/reload` in Pi) / opencode so they register on the bus. Pi stores its stable label in `~/.xats/label` (and `setx XATS_LABEL` on Windows) so `pi-<host>-<label>` is stable across restarts; override with `--label <name>` or `XATS_LABEL` env.
Health check: `curl http://127.0.0.1:$(cat ~/.xats/port 2>/dev/null || echo 9100)/health` — setup also runs an ephemeral bus probe (`register → list → deregister`) and verifies each selected component’s files.

## Windows ↔ WSL
Windows and WSL are separate loopback buses (`C:\Users\…\.xats` vs `~/.xats` in the distro). Setup detects `wsl.exe` + `~/.config/opencode` inside the distro and prints `WSL has opencode` guidance. To talk across, `wsl -- npx xats-setup --only=opencode,pi,daemon,service` inside WSL, then bridge both ends (`~/.xats/bridge/peers.json` on each, `bridge up` — needs `filament` on both). On Windows the installer picks a free port `9100-9104` (persists to `~/.xats/port`); `service` uses that port for `schtasks` + `Startup\xats-daemon.vbs`. First bind may trigger Windows Firewall — allow private networks.

## Reset / uninstall

```sh
npx xats-setup reset
# preview only:
npx xats-setup reset --dry-run
```

Reset stops and unregisters the xats daemon service (if selected), removes `~/.xats` (or just `~/.xats/bridge` for bridge-only resets), removes
xats's Claude hook/MCP entry, its OpenCode/mimocode plugin entries and copied
files, and Pi's `~/.pi/agent/extensions/xats.ts` plus xats skill — only for the selected components (`reset --only=pi` touches just Pi). It deliberately
leaves unrelated harness settings, plugins, skills, and MCP servers intact.

## Updating

Re-run the same command — it's an in-place update:

```sh
npx xats-setup@latest
```

It records what it installed in `~/.xats/manifest.json`, so a re-run **detects a
prior version and migrates it**: overwrites the daemon build, hook, and plugins
with the current ones, and — if the daemon build actually changed — restarts the
daemon so the update takes effect. Same-version re-runs are a no-op refresh.

Agents that stop heartbeating are reaped within ~a minute, so the Claude hook
keeps an interactive session alive by **re-registering every 30s** (a plain
heartbeat on a reaped id would fail; re-register self-heals). Restart your Claude
session after an update so it picks up the new hook.

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
npm i -g ./xats-setup-0.3.5.tgz && xats-setup
# or, no global install:
npx ./xats-setup-0.3.5.tgz
```
