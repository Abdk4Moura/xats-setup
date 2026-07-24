# xats-setup

One command, any OS. Stands up an identical **xats cross-agent bus** peer on
Windows, macOS, or Linux — daemon, autostart service, Claude Code hooks,
opencode/mimocode plugins, and the cross-machine bridge.

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
| `claude`  | Installs a pure-Node SessionStart/SessionEnd hook (no bash/jq/curl/setsid) and adds the `cross-agent-teams` MCP entry — merged into existing config without clobbering. |
| `harness` | Copies the `xats-register` + `notify-unified` plugins and the xats skill into opencode/mimocode (copies, not symlinks — Windows-safe). |
| `bridge`  | Installs the Node bridge (`~/.xats/bridge/bridge.mjs`, zero deps). Joining the mesh is a separate coordinated step. |

## Usage

```sh
npx xats-setup                 # full peer (all components)
npx xats-setup --dry-run       # preview every action, change nothing
npx xats-setup --only=daemon,service
npx xats-setup --no-bridge     # skip a component
npx xats-setup --label umar    # identity label for this box's agents
npx xats-setup --force         # reinstall the daemon base package
```

After install, restart Claude Code / opencode so they register on the bus.
Health check: `curl http://127.0.0.1:9100/health`.

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
npm i -g ./xats-setup-0.1.0.tgz && xats-setup
# or, no global install:
npx ./xats-setup-0.1.0.tgz
```
