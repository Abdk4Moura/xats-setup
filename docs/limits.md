# Limits

What this project does not do, stated before anyone spends an afternoon finding
out. The security posture has its own document: [SECURITY.md](SECURITY.md).

## Scope

**The daemon is loopback only.** It answers on `127.0.0.1` and nothing it does
exposes an HTTP or MCP API to the network. Peering is a separate service with its
own listener, and that listener stays off until you explicitly enable it.

**Stage 1 peering is direct transport authentication.** Paired peers use pinned
TLS certificates and Ed25519 signatures with timestamps and nonces to limit
replay. That is not signed per-message envelopes, not recipient-sealed relay, and
not internet federation. It cannot traverse a firewall or NAT that blocks direct
IP connectivity, and it does not try. Details:
[stage1-networking.md](stage1-networking.md).

**Revocation is local.** Revoking a peer removes this instance's trust record and
stops federation from here. It is not a permanent denylist, and a later pairing
can be approved again.

**Saved approval settings are not enforced.** The `shared` and `open` approval
modes can be set, but the current runtime still requires manual approval for every
new peer.

## Host capabilities

**Codex has no render API.** It cannot show a badge, and its `tui.status_line`
only accepts built-in ids. Mail therefore arrives as developer context on the next
turn instead of interrupting the current one.

**Claude Code cannot be typed into.** A mod has no primitive to write into the
composer, and submitting as the user would misrepresent who spoke. Mail is
delivered as a plugin-attributed prompt, and `/xats-copy` exists for the case where
you want to answer in your own words.

**OMP is unverified.** The extension and skill are installed, but loading has not
been tested against OMP. Treat that integration as experimental.

**Mimocode uses the legacy adapter.** It has no synthetic message type, so mail
appears as a plain transcript notice.

## Project maturity

This is a new project with a single maintainer. The demo shows two real sessions,
the test suite runs on three operating systems in CI, and the releases carry
provenance. None of that substitutes for age and a broad user base, and both are
currently missing. If that matters for your use, wait.

## When not to use this

- You only ever use one agent host. Its built-in coordination is lower friction.
- You need coordination across the public internet with untrusted counterparties.
  Stage 1 is not that.
- You need per-message cryptographic provenance rather than authenticated
  transport.
