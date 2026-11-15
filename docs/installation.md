# Installation

Everything the installer does, every flag, and how to undo it.

## Requirements

Node 20 or newer (22 LTS recommended), on Windows, macOS or Linux. No sudo: all
state lands under `~/.xats`. The installer is idempotent, so re-running it is the
upgrade path.

## Flags

```sh
npx xats-setup                 # interactive: Enter for all, c to pick agents
npx xats-setup --yes           # non-interactive full install; peer listener stays off
npx xats-setup --dry-run       # preview every action, change nothing
npx xats-setup --only=daemon,service,pi   # only these components
npx xats-setup --only=peer                # Stage 1 peer runtime only
npx xats-setup --without claude,pi        # exclude, aliases: --except/--exclude/--skip/--omit
npx xats-setup --label umar    # prefix for this box's agent identities
npx xats-setup --force         # reinstall the daemon base package
npx xats-setup reset           # remove everything the installer added
npx xats-setup reset --only=pi # remove only Pi's pieces
```

Every agent is optional and the default is all of them. `omp` is independent of
`pi`: the same extension is installed to `~/.pi` or `~/.omp`.

## Interactive picker

Running `npx xats-setup` with no flags in a TTY opens a picker: `Enter` for all,
`c` to toggle each component (it shows found or not found), `n` for none, `q` to
quit. The picker is skipped when `CI=1` or stdin is piped, and `--yes`, `--only`
or `--without` skip it too.

## Progress and logs

In a TTY the installer shows one line of progress that disappears when it
finishes. Detail goes to `$(os.tmpdir())/xats-setup-*.log`, and the summary
prints the path. Use `--verbose` or `--no-ephemeral` to stream the log live.

## After installing

Restart Claude Code, reload Pi, or restart OpenCode so each host registers on the
bus. The installer also runs a probe (register, list, deregister) and verifies the
files for each selected component.

Health check:

```sh
curl "http://127.0.0.1:$(cat ~/.xats/port 2>/dev/null || echo 9100)/health"
```

## Updating

```sh
npx xats-setup
```

Re-running installs the newer daemon and rewrites the host integrations together,
which is why the two should not be updated separately. The installer picks up a
new version from npm; read the release notes before jumping several versions.

## Reset and uninstall

```sh
npx xats-setup reset            # remove everything
npx xats-setup reset --dry-run  # preview only
npx xats-setup reset --only=pi
```

## Native dependencies

The daemon builds against better-sqlite3 for its message store. On a box without
a C++ toolchain the installer reports the failure rather than leaving a half-built
runtime, and Node 22 LTS has the best prebuilt coverage.

## Install from a tarball

For a machine without npm registry access:

```sh
npm pack                # produces xats-setup-<version>.tgz
npx ./xats-setup-*.tgz
```

## Windows and WSL

Windows and WSL are separate loopback buses: `C:\Users\…\.xats` on the Windows
side and `~/.xats` inside the distro. Setup detects `wsl.exe` and an OpenCode
config inside the distro, then prints guidance.

For Stage 1 peering across the boundary, install and start the peer component on
both sides and use an address the other side can reach. WSL NAT and firewall rules
may block that; Stage 1 does not tunnel around them.

On Windows the daemon takes a free port in 9100 to 9104 and persists it to
`~/.xats/port`. The first daemon bind may trigger a firewall prompt.
