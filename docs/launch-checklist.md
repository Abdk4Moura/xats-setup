# Launch checklist

Status before the first public Cross-Agent Teams release. The release name is
**Cross-Agent Teams** (`cross-agent-teams`): this substantially changed release
builds on the earlier xats work and is not the same project/release. The existing
npm installer remains `xats-setup`; legacy daemon/tool identifiers remain where
compatibility requires them.

## Readiness

| Area | State | Evidence / remaining work |
|---|---|---|
| Cross-platform CI | **historical pass; rerun required** | xats-setup PR #1 passed 15/15 GitHub-hosted jobs at head `1abafc59` (run `39884356274`) across Linux, macOS, and Windows. That result predates the current uncommitted Claude binding and launch-copy changes. Run CI on the final commit before merge/release. |
| Owned daemon | **source and build present** | `daemon/src` is maintained in this repo and built with `npm run build:daemon`. Upstream lineage is credited in `daemon/NOTICE` and `daemon/SOURCE.md`; no merge base is claimed. |
| Tests | **full local pass; exact-head CI pending** | The updated full suite passed 101/101 tests after the mailbox-cursor fix; the daemon bundle built and the cursor + REST endpoint checks passed 4/4. This is not a final cross-platform or exact-head CI result. |
| Claude mailbox continuity | **deployed; live checks passed** | The owner-driven Claude restart and a later daemon-only restart both recovered the original session-keyed agent ID on the first `get_inbox`, without `register_agent` or a Claude restart after the latter. `xats-daemon.service` is healthy on `:9100`; the SQLite backup passed `integrity_check`. A pre-deployment MCP connection still needs Claude restart/resume to rerun SessionStart; do not recover by registering the same name/PID. |
| MCP/plugin duplicate notices | **deployed; live daemon/mod checks passed** | The loopback-only read-only `/api/cursor` endpoint and Claude mod filtering suppress notices already consumed through MCP, both during polling and just before submit. The live daemon/mod probe suppressed a consumed event and submitted a fresh unread event; after daemon restart, the Claude agent's first `get_inbox` returned the original agent ID and did not re-announce earlier read mail. Cursor lookup failure still falls back to prior notification behavior. |
| Security disclosure | **corrected in working tree; review required** | `docs/SECURITY.md`, README, and Stage 1 networking docs now distinguish signed HTTP requests and pinned TLS from message-envelope signing/sealing; explain manual-only approval, local revocation, and direct-only networking. Review against code and tests before merge. |
| Approval policy | **manual only** | The runtime requires explicit approval for all new peers. `shared` and `open` can be saved but do not auto-approve; CLI and docs now warn. |
| Product naming | **decided** | Use Cross-Agent Teams / `cross-agent-teams`, explicitly describe substantial changes built on earlier xats work, and keep `xats-setup` as the current npm installer identity. |
| Standalone daemon repo | **visibility change pending audit** | User wants `Abdk4Moura/xats-daemon` public. Audit repository contents, history, workflows, and secret-bearing files before changing visibility. |
| npm release | **not ready** | npm has `xats-setup@0.3.6`; the checkout is `0.3.7`. Do not publish until final changes are committed, exact-head CI passes, the Claude restart check is reported, and release files/version are reviewed. |
| Optional direct peers | **scope claims narrowly** | Automated pairing, pinned HTTPS, federation, and routed-namespace tests exist. A physical cross-host check is not established in this launch evidence. Stage 1 is direct IP only; no relay, general Internet federation, Filament/Tunlion dependency, or signed/sealed message envelopes. |
| OMP | **unverified** | Integration code exists, but loading has not been verified on OMP; describe as experimental or omit from a guaranteed support list. |

## Release gates

1. Finish and review the Claude post-restart first-call test; report whether the
   same `agent_id` survives and `get_inbox` works without manual registration.
2. Audit and correct all launch-facing security and capability claims. Keep
   tests, design proposals, and live observations clearly separated.
3. Audit `Abdk4Moura/xats-daemon` before changing its visibility. Check tracked
   files, complete git history, tags, GitHub Actions/workflows, release assets,
   and repository metadata for secrets or sensitive data. Do not publish until
   the audit is clean.
4. Review the entire changed xats-setup tree, build the daemon, run the complete
   test suite, and verify exact-head GitHub Actions on Linux, macOS, and Windows.
5. Verify `npm pack --dry-run`, package contents, README installation commands,
   package version, and release notes. Keep `xats-setup` as the installer name
   unless a deliberate package migration is approved.
6. Merge PR #1 only after its final head passes CI and the owner approves. Publish
   the npm release only after merge and a final package audit.

## Shipped behavior vs proposals

Current direct peer transport authenticates paired-peer HTTP requests with
Ed25519 signatures and uses pinned HTTPS. Discovery is candidate-only and
pairing is manually approved. Revocation removes local trust but is not a
permanent denylist. The following remain proposals or future work and are not
release claims: signed per-agent message envelopes, handles, recipient-sealed
relays, durable revocation tombstones, `shared`/`open` runtime auto-approval, and
offline/internet federation.
