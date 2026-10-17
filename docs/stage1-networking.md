# Stage 1: Secure xats peer discovery

## Goal

xats instances discover one another and make their local agents reachable over networks where direct IP connectivity exists. This is transport-independent: LAN, a tailnet, or another routed/private network can all carry the peer connection. Stage 1 does not use Filament/Tunlion.

## User experience

- Local xats bus works as before; the daemon stays loopback-bound.
- xats advertises a minimal service record on multicast-capable LANs. Browsing finds *candidates*, never trusted peers.
- For routed networks where multicast discovery does not cross the network boundary, a user creates a short-lived invite and shares it out of band. The invite carries a reachable endpoint and one-time pairing material; it is not a permanent access token.
- The recipient sees the inviting instance identity and explicitly approves. Pairing establishes a persistent peer identity/key. Both sides can inspect and revoke paired peers.
- Paired peers communicate directly over an encrypted, authenticated peer channel. Only the peer API is reachable on the network; local daemon REST/MCP APIs remain loopback-only.
- Status distinguishes discovered, awaiting approval, paired/connected, and unavailable.

## Security invariants

1. Discovery data is untrusted and contains no credentials or agent roster.
2. A discovered endpoint cannot relay messages or read rosters before pairing.
3. Pairing material is high-entropy, short-lived, single-use, and never logged; persisted keys/config use owner-only permissions where supported.
4. Peer traffic is encrypted and authenticated against the paired identity. Reject unknown keys, replayed pairing attempts, malformed/oversized input, and unexpected peer identities.
5. Revoke removes the peer authorization locally; do not silently recreate trust from mDNS or a stale invite.
6. Do not port-scan. Advertise the peer service's chosen endpoint only. Do not expose the daemon listener to the network.

## Discovery boundary

mDNS/DNS-SD discovers services only within multicast-reachable network segments; it cannot be treated as universal discovery across routed networks. Stage 1 therefore combines mDNS candidate discovery where available with explicit invitation for routed networks. Once paired, store the authenticated peer identity and reconnect to its configured/recently observed reachable endpoint. No vendor-specific tailnet API is required.

## Existing implementation mapping

- `assets/daemon/cli.js` owns the local bus and defaults to loopback; preserve that boundary.
- `assets/bridge/bridge.mjs` already relays agent rosters/messages but is explicitly a Filament-oriented bridge. Its peer HTTP listener is loopback-only and its HTTP peer protocol is not suitable for direct untrusted network exposure. Reuse relay semantics only after moving peer traffic behind a new authenticated/encrypted transport; do not simply change the bind address.
- `lib/bridge.mjs` and installer lifecycle currently install the bridge without starting it. Pairing/discovery must have explicit lifecycle/config and must not open a listener as an incidental install side effect.

## Build sequence

1. Specify/version the peer protocol and persistent identity/trust model; add tests for invite expiry, one-use behavior, key binding, and revocation.
2. Implement an authenticated encrypted peer listener/client and a local-only adapter to the existing daemon/bridge relay logic.
3. Add mDNS advertisement/browsing for candidate endpoints; test parsing and stale/duplicate candidates. Discovery is off/limited predictably when multicast is unavailable.
4. Add invite/approve/list/revoke user commands and a clear status view. Keep static peers as an advanced fallback.
5. Integrate cross-platform install/service/reset/update behavior and test on Linux, macOS, and Windows.

## Stage boundaries

Stage 1 provides direct peer connections only when IP routing/firewall policy permits them. Stage 2 may add Filament/Tunlion for reachability where direct connections are unavailable; it must not weaken Stage 1 identity, approval, or encryption guarantees.
