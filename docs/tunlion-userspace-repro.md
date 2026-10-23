# Tunlion userspace L3 repro (Windows, medium integrity, no TUN)

Purpose: capture the `expose` / `addr` failure where tunlion advertises a usable
overlay address but never binds a listener, and prove the userspace (smoltcp)
path binds and carries traffic with no TUN and no elevation.

Runs beside the production instance, never touching it.

## Isolation

| Concern | Setting |
|---|---|
| state (daemon, identity, devices, up.lock, control path) | `TUNLION_CONFIG_DIR=<scratch>\cfg` |
| file drop dir | `--dir <scratch>\drop` |
| display/signaling name | `--name-as dgmfa-repro` |
| privilege | medium integrity, no elevation, no TUN |
| mode | `--userspace` |
| port | **9210** (production peer listener uses 9110) |
| identity | **fresh** — never copy the production key (two daemons on one key) |

Two `tunlion.exe` processes with different `TUNLION_CONFIG_DIR` do not contend for
a control socket or `up.lock`; both are per-config. Only the signaling name is
shared, hence `dgmfa-repro`.

After the run: stop the repro daemon, delete `<scratch>`, and remove the device
from dovm's roster (`tunlion devices forget dgmfa-repro`).

## Phase 1 — failing state (the evidence they need)

1. Stop TUN for the duration (production instance keeps running).
2. Start the repro medium-integrity daemon with the env above.
3. Capture, in the failing state:
   - `tunlion addr --json`
   - `tunlion devices --json`
   - `tunlion expose --list`
   - `tunlion expose 9210 --to 127.0.0.1:9210 --peer dovm` — exit code, stdout, stderr
   - the daemon log for the L3-start attempt, including its `reason`
4. Expected defect: `addr` prints a derived overlay address while
   `l3.state` is `down`/absent, and `expose` exits successfully with
   "configured only" visible only via `--list`.

## Phase 2 — userspace bind

1. `L3::start(cidr, mtu, identity, userspace)` then `bind(9210)`.
2. Capture `addr --json` / `devices --json`: expect `l3.state=ready`,
   `mode=userspace`.
3. `expose 9210 ...` should print success **only after bind**.

## Phase 3 — traffic through the userspace listener

Two directions, both reported even if one fails:

| # | Direction | Expectation |
|---|---|---|
| a | dovm (kernel TUN) plain socket → repro userspace listener on 9210 | works, because the *dialer* has the route |
| b | repro userspace → dovm via `L3::dial` | works with no TUN on the dialer |

Success signal in both cases: `401 peer_auth_required` from dovm's xats peer
listener. Pairing (Phase 3 only): mint one invite on dovm, join from the repro,
confirm `dgmfa-repro` in dovm's roster.

If (a) fails while (b) works, that is still a pass for us and settles the adapter
design: **dial transport-native via `L3::dial`/`open_overlay`, never a plain
socket to `<name>.mesh:port`.**

## Phase 4 — restart

Restart the repro daemon in userspace mode and confirm re-bind, plus stale-socket
cleanup on Windows.

## Design consequence (why this repro matters beyond the bug)

The current xats overlay adapter resolves a mesh name and opens a plain socket.
That works only when the dialing host has a kernel route (TUN). Once the library
lands, the adapter must dial through `L3::dial` / `Link::open_overlay`, and gate on
`l3.state === "ready"` — surfacing `l3.reason` verbatim in `/xats-status` instead
of dialing an address that was merely derived.

---

## Results — artifact 03d93407 (tunlion 0.9.0, x86_64-pc-windows-msvc)

Verified on dgmfa: medium integrity, no elevation, no TUN. Zip sha256
`1d8f0c6f…3859b9` matched on arrival and `SHA256SUMS` matched inside;
`tunlion.exe` = `72c99ab1…47906e`.

### Confirmed fixed

| Claim | Evidence |
|---|---|
| `l3` state in JSON | no daemon → `{"state":"down","mode":"none","reason":"no running tunlion daemon…"}`; running → `{"state":"ready","mode":"userspace","reason":null}` |
| userspace L3, zero privilege | `up --detach --userspace` → daemon up, `l3 ready/userspace`, no TUN, no CAP_NET_ADMIN |
| `expose` binds truthfully | `[bound on the overlay, daemon pid N]`, and `--list` shows `[bound]` |
| `--list` distinguishes states | `[NOT bound: no running daemon]` per entry with a reason |
| original defect gone | with no daemon `addr` still prints the derived address, but now carries `state:down` + reason, and `expose` warns loudly |

### Bugs found (reported; fix assigned upstream)

- **A. `expose` exits 0 when it did not bind.** Loud stderr, exit status 0 — automation reads success.
- **B. `tunlion down --yes` fails on Windows** (`Error: program not found`); no clean stop path (had to kill the pid from `up.pid`).
- **C. Non-interactive `init` under-specified** — needs `--yes --name --recovery-file` *and* `HOME`; without `HOME` it dies on "cannot choose an inbox".
- **D.** Cosmetic `ssh-keygen: program not found` warning during `init` on a bare Windows box.
- **E1. `join` reports failure after succeeding remotely** — "sent enrollment request", then `Error: this invitation has already been used`, while the peer had already certified the device. Exit status contradicts outcome (same class as A).
- **E2. `join` after `reset` leaves an inconsistent config** — `device.id` and `overlay.ed25519` present, `devices.json` missing (only `.bak`), so `up` refuses with "no identity yet, and no paired devices".
- **E3. Key mismatch after that half-join** — local identity address `fdf1:…:9a13:…` vs the address the peer certified `fdf1:…:bf51:…`: two keys for one device name.
- **F.** `up --name-as` did not apply to the mesh identity: `addr` still reports `"name":"device","mesh":"device.mesh"`.

### Consequences for the xats adapter

1. **Dial transport-native.** `--userspace` help states it plainly: *"native tools reach `<peer>.mesh` only via `tunlion forward <peer>:<port> --socks`"*. A plain socket needs a kernel route on the dialer; the adapter must use `L3::dial` / `PeerLink::open_overlay`.
2. **Gate on `l3.state === "ready"`** and surface `l3.reason` verbatim (implemented in `lib/overlay-discovery.mjs` via `isDialablePeer`).
3. **Never trust exit status alone** for `expose`/`join`/`forget` until A/E1 are fixed — verify state (`--list`, `addr --json`, peer roster) instead.
4. **`online` in `devices --json` is stale metadata, not reachability** — use `tunlion reach <device>` (observed: roster said offline while `dgmfa.mesh:9110` answered 401).

### Status

Live-traffic leg (paired userspace peer → 401 through the netstack, then restart
re-bind) is **on hold** pending the join-state fix (E1–E3). Bind/expose/addr are
accepted evidence. Production dgmfa untouched throughout; dovm roster clean.
Scratch config retained at `C:\Users\agboola\tlrepro\cfg`.
