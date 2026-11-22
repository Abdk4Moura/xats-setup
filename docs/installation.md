# Installation

Everything the installer does, every flag, and how to undo it.

## Requirements

Node 20 or newer (22 LTS recommended), on Windows, macOS or Linux. Install as
the account that runs your agents; sudo is not required for a normal user install.
Managed integration files live under `~/.xats` and the individual hosts' config
directories. The mailbox database normally lives at
`~/.cross-agent-teams-mcp/data.db`; a configured `CROSS_AGENT_TEAMS_MCP_HOME`
is retained. Re-running the installer is the upgrade path.

## Flags

```sh
npx xats-setup                 # interactive: Enter for all, c to pick agents
npx xats-setup --yes           # non-interactive full install; peer listener stays off
npx xats-setup --dry-run       # preview without changing config or services
npx xats-setup --only=daemon,service,agy  # daemon, service, and Antigravity
npx xats-setup --only=peer                # Stage 1 peer runtime only
npx xats-setup --without claude,pi        # exclude, aliases: --except/--exclude/--skip/--omit
npx xats-setup --label umar    # prefix for this box's agent identities
npx xats-setup --force         # reinstall the daemon base package
npx xats-setup --allow-downgrade # explicitly allow an older tracked installer
npx xats-setup reset           # remove managed files; read the reset notes first
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

Restart Claude Code, reload Pi, restart OpenCode, or restart Antigravity so each
host loads its integration. The Antigravity plugin is installed at
`~/.gemini/config/plugins/xats`; inspect it with `agy plugin list`. The installer
also runs a probe (register, list, deregister) and verifies selected component files.

Health check:

```sh
curl "http://127.0.0.1:$(cat ~/.xats/port 2>/dev/null || echo 9100)/health"
```

## Claude message delivery

Starting with 0.3.15, supported interactive Claude sessions use connected
local-first delivery by default. Messages are stored durably, then the plugin
receives arrival hints without waiting for the old three-second polling tick.
Upgrade the daemon and Claude integration together and restart Claude. No
feature flag or daemon-service environment change is needed.

Use `/xats-status` to check the active delivery path. To select compatibility
polling for a fresh session, launch `XATS_LOCAL_DELIVERY=0 claude` (PowerShell:
`$env:XATS_LOCAL_DELIVERY = '0'`, then `claude`). Unset that variable to restore
the default. Opting out cannot bypass an earlier refusal or held message and
does not replay existing locally owned delivery requests. Other hosts are
unchanged. See [delivery details](local-first-implementation.md).

## Updating

```sh
npx xats-setup
```

Read the release notes before jumping several versions. The safety behavior
below applies to versions containing the installer-hardening changes, not to
previously published installers such as `0.3.14`.

- Existing selected agent configurations and supervisor definitions are checked
  before installation files or the saved port are changed. Malformed settings
  stop setup rather than being replaced with an empty configuration.
- An occupied saved port is retained only when setup can verify that the process
  is the expected daemon. An unrelated or unverified listener stops setup; it
  does not silently redirect every integration to a different port.
- Schema initialization does not consume existing unread mail or advance a zero
  inbox cursor. Legacy history with no recorded read position can replay rather
  than being silently marked read.
- Unchanged daemon builds do not require a restart. Changed builds have a single
  restart owner, and failed dependency installation remains eligible for repair
  on the next run.
- Changed configuration and managed integration files have exact-byte sibling
  backups named `*.xats-backup-*`. Unchanged reruns do not accumulate backups.
  JSONC comments may be normalized away in the active file, but remain in its
  raw backup. User-added files in managed plugin directories are retained.
- Custom supervisor definitions are not overwritten. Reconcile them manually
  if setup reports an unknown definition. Some legacy Windows daemons need to
  be stopped with their existing supervisor before their action can be migrated
  to explicitly scoped database and PID-file arguments.
- Existing Codex MCP authentication and options are not discarded to change a
  URL. If setup reports `manual-update-required`, update only the named server's
  URL and retry.
- Tracked downgrades are refused unless `--allow-downgrade` is explicit.

Backups are recovery aids, not a full transactional snapshot of native npm
installation. Keep your own backup before major upgrades. Changing Node's major
version can also require rebuilding native dependencies.

Native process-ownership probes fail closed. macOS daemon paths containing
spaces or quoting, and Linux executable paths requiring unsupported systemd
quoting, are rejected before service installation rather than being launched
without verifiable ownership. A missing native inspection tool or insufficient
permissions can require manual supervisor reconciliation.

## Reset and uninstall

```sh
npx xats-setup reset            # destructive removal of managed components
npx xats-setup reset --dry-run  # preview only
npx xats-setup reset --only=pi
```

Resetting the peer component removes its private identity, pairings, and
configuration. Resetting bridge removes its peer list. The separate mailbox
database is retained. Codex MCP configuration is deliberately retained to avoid
silently discarding authentication or custom options; remove the named server
manually if you no longer need it.

Dry runs do not change installation files, processes, or services. They still
write a diagnostic log in the system temporary directory.

## Native dependencies

The daemon uses better-sqlite3 for its message store. Failed npm installation is
reported and marked for retry; setup does not restart the daemon after that
failure. Node 22 LTS has broad prebuilt coverage. If you change Node versions and
encounter a native ABI mismatch, rebuild better-sqlite3 with the same Node used
by the service before restarting it.

## What CI verifies

Every CI runs the complete suite once on Linux, macOS, and Windows with Node 22
and 24, including native dependencies. Exact OS/architecture/Node/lockfile caches
save repeated dependency setup; native SQLite is opened before testing to catch
an incompatible cache. Builds always use current source. File manifests and
named critical tests guard against silently reduced or skipped coverage.

Clean packed-executable installs run separately on all three OSes, including
dry-run, repeat installation, preserved user settings, and recoverable JSONC
comments. One Linux job runs pinned real Claude and Antigravity validators and
Claude's mod-test kit, without accounts or model calls. These checks run on
every PR and main push, not only selected paths.

The target is about one minute with warm caches, excluding GitHub runner queues.
Cold dependency/CLI downloads can take longer. Full suites are not duplicated in
endpoint and dependency job groups. CI uses three isolated file workers;
`npm test` defaults to one worker locally, configurable with
`XATS_TEST_CONCURRENCY` from 1 to 8.

Version-selection and host-API unit tests still use controlled fixtures. These
checks do not prove live agent rendering, model attention, or successful
notifications in every real host version; those remain release acceptance tests.

## Install from a tarball

To test or transfer the exact package artifact:

```sh
npm pack                # produces xats-setup-<version>.tgz
npx ./xats-setup-*.tgz
```

Runtime dependencies still require registry access or a sufficiently primed npm
cache. A package tarball alone is not a fully offline dependency bundle.

## Windows and WSL

Windows and WSL are separate loopback buses: `C:\Users\…\.xats` on the Windows
side and `~/.xats` inside the distro. Setup detects `wsl.exe` and an OpenCode
config inside the distro, then prints guidance.

For Stage 1 peering across the boundary, install and start the peer component on
both sides and use an address the other side can reach. WSL NAT and firewall rules
may block that; Stage 1 does not tunnel around them.

On Windows the daemon takes a free port in 9100 to 9104 and persists it to
`~/.xats/port`. The first daemon bind may trigger a firewall prompt.
