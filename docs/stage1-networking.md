# Stage 1: Direct peer networking for Cross-Agent Teams

## Goal and boundary

Instances discover one another on multicast-reachable LANs, or connect using a short-lived invite when multicast does not cross the network. They pair with explicit approval, then exchange agent rosters and messages over a directly reachable IP path. This is transport-independent (LAN, tailnet, or another private/routed network); Stage 1 does not use Filament/Tunlion and does not promise connectivity through NAT/firewalls that prevent direct IP traffic.

mDNS/DNS-SD discovers candidates only on multicast-reachable segments. It is not a tailnet or Internet directory. Routed peers use an invite endpoint shared out of band. Once paired, peers retain the identity and endpoint and reconnect without repeating pairing.

## User experience

1. Local agent bus continues working as before.
2. User enables xats peer networking; installation alone must not silently open a network listener.
3. On multicast-capable interfaces, xats advertises/browses a minimal service record. Candidate discovery never shares a roster, sends a message, or grants trust.
4. On a LAN, a user selects a candidate and sends a pairing request. On a routed network, a user creates and privately shares an expiring invite carrying the reachable endpoint and one-time pairing secret.
5. The remote instance presents the peer identity and asks for explicit approval. The initiating side also confirms the pairing result. On approval, both sides persist the peer's cryptographic identity, TLS certificate fingerprint, and a user label.
6. Paired peers exchange rosters and relay messages. Status distinguishes candidate, awaiting approval, paired/connected, and unavailable. Users can list peers and revoke trust.

### Operator workflow

Install the `peer` component with the normal installer or `npx xats-setup --only=peer`. Installation only copies the isolated runtime and installs pinned dependencies; it does not open a listener. The local xats daemon must also be installed and running for agent roster/message federation; the default full install includes it. Use `xats-setup peer run` for a foreground session, or explicitly `xats-setup peer enable` to install and start a user service now and at login. `peer status`, `peer candidates`, `peer pending`, `peer peers`, and `peer revoke <device-id>` show the current state and manage trust. Saved `shared` and `open` approval policy values are not enforced: the current runtime requires manual approval for every new peer.

For LAN pairing, run `xats-setup peer pair <candidate-device-id>` on one instance, then inspect and approve the pending request on the other with `xats-setup peer approve <pending-id> --label <name>` (or deny it). For routed direct connectivity, create a short-lived invite with `xats-setup peer invite --endpoint https://<reachable-address>:<port> --out <private-file>` and accept it with `xats-setup peer pair --invite-file <private-file> --endpoint https://<joining-address>:<port>`. The invite file is a secret and should be deleted after use. Both listener addresses must be reachable directly; the service never scans ports or changes daemon binding.

## Identity, TLS, invite, and authentication

- Each instance has a persistent Ed25519 signing key. `deviceId` is the first 128 bits of SHA-256 over its DER SubjectPublicKeyInfo. The private key is stored owner-only in the xats state directory.
- The peer service uses HTTPS with a persistent self-signed TLS certificate. Its SHA-256 certificate fingerprint is bound to the Ed25519 identity in the pairing exchange and pinned in each peer record. Client verification must compare the pinned fingerprint; it must not disable TLS verification globally.
- A version-1 invite contains: invite id (128 random bits), issue/expiry timestamps (expiry no more than 10 minutes), inviter device id/public key, reachable endpoint, and TLS certificate fingerprint. The inviter signs a canonical representation. A separate 256-bit random secret is delivered in the invite payload and is never sent in plaintext over the network or written to logs. The invite is invalidated after approval, denial, or expiry.
- A pair request includes the invite id, a fresh 128-bit nonce, requester device id/public key, requester TLS fingerprint, an Ed25519 signature over canonical request fields, and HMAC-SHA-256 over those fields keyed by the invite secret. For LAN candidate pairing without a pre-shared invite, the candidate may request pairing without the HMAC, but still proves possession of its Ed25519 private key; the remote user must approve.
- A valid request creates only a pending candidate. Approval is the only operation that writes a peer into the trust store. Rejecting/denying consumes the related invite. Duplicate nonces, expired invites, malformed keys, mismatched device ids, and replayed request ids are rejected.
- After pairing, each network request is sent over TLS pinned to the peer certificate and carries a signature by the paired Ed25519 key over method, versioned path, timestamp, nonce/request id, and body hash. Enforce a bounded timestamp window and replay cache. Message IDs are idempotent across retries.
- Each paired peer request is authenticated by its Ed25519 identity; pair-request attempts are rate-limited per source address, and request bodies are size-bounded. There is no shared fleet-wide bearer token. Revocation removes local trust and reconnect state, so subsequent requests from that peer are rejected by this instance. It is not a permanent global denylist; a new pairing can be explicitly approved later.

## Versioned network surface

All network endpoints live under `/xats/peer/v1/` and are served by a new peer service, never by exposing the local daemon:

- `GET /info`: protocol version, device id, public key, and TLS fingerprint; no roster or secrets.
- `POST /pair/request` and `POST /pair/status`: invitation/candidate pairing and approval result. These endpoints cannot relay agent traffic.
- `GET /agents/roster`: paired-peer-authenticated roster query.
- `POST /messages/deliver`: paired-peer-authenticated message relay, with origin/message ids and hop/loop protection.

Malformed/oversized input, unsupported versions, unknown peer keys, stale timestamps, invalid signatures, and repeated nonces fail closed. The service exposes only its chosen HTTPS endpoint—no port scanning and no daemon REST/MCP exposure. A separate local-only control surface supports invite, pending approval, peer list/status, and revoke; it binds to loopback and uses a local owner-only control credential.

## Bind and discovery policy

- The daemon remains bound to `127.0.0.1` (and any existing loopback companion behavior remains local).
- When the user enables peer networking, only the dedicated peer HTTPS service binds to non-loopback interfaces. Default is all local non-loopback IPv4/IPv6 addresses, with an explicit bind override and a persisted selected peer port; no other service is exposed.
- mDNS service type is `_xats-peer._tcp`. Advertise only protocol version, device id, and the actual peer service port; do not include credentials, invite secrets, or rosters. Candidate addresses and TXT fields are untrusted input. Ignore self, malformed/unsupported records, and stale candidates. mDNS outage must not disable invite-based pairing or paired direct connections.
- Invite endpoints may be hostnames or IPs that the user can reach directly. The user picks/share an endpoint; no vendor-specific tailnet API is required.

## Existing implementation mapping

- `daemon/src` is the owned local daemon source and is bundled by `npm run build:daemon`. It remains loopback-bound. Its local-only `GET /api/agents/all` route exposes a sanitized all-team roster to the peer runtime; the daemon's network API is never exposed.
- `assets/bridge/bridge.mjs` remains the separate Filament bridge. Stage 1 does not change its bind address or reuse its plain-HTTP peer endpoints.
- `lib/peer-identity.mjs`, `lib/peer-pairing.mjs`, and `lib/peer-tls.mjs` implement Ed25519 identity, expiring signed invites bound to an HTTPS endpoint/certificate, one-use pairing proofs, explicit approve/deny/revoke state, pinned TLS identities, and owner-only persistence.
- `lib/peer-transport.mjs` is the isolated HTTPS peer listener/client with signed requests, TLS pin verification, replay protection, request limits, and authenticated roster/message handlers.
- `lib/mdns-discovery.mjs` advertises/browses candidate-only records through pinned `bonjour-service`; `lib/peer-runtime.mjs` starts it alongside the peer listener and loopback control API.
- `lib/peer-federation.mjs` synchronizes sanitized rosters, creates namespaced local shadow agents, forwards messages over paired HTTPS, maintains retry cursors and a persistent duplicate-delivery ledger, and stops routing immediately on revocation.
- `lib/peer.mjs` installs the runtime in `~/.xats/peer`; `lib/peer-service.mjs` manages explicit user-service enable/start/stop/disable on systemd, launchd, and Windows Scheduled Tasks. A fresh install never enables the network service.

## Reproducible network-flow checks

Run these commands from a repository checkout after `npm install`; the E2E daemon is launched from the owned build in `daemon/src`, not a separately installed user's daemon. The automated `npm test` suite includes CLI-handler flows invoking `mainPeer` with the same arguments as `xats-setup peer`: `test/peer-discovery-flow.test.mjs` injects candidate-only mDNS records, then pairs and approves over a non-loopback interface using real pinned-HTTPS requests (including fallback from a dead advertised address); `test/peer-federation.test.mjs` creates and accepts a short-lived invite over a non-loopback interface, then verifies roster/message exchange, reconnect, deduplication, and revocation. `test/real-daemon-cli-e2e.test.mjs` additionally launches two real daemon processes from the bundled patched asset using the pinned test-only `cross-agent-teams-mcp@0.7.4` devDependency, drives the invite/approval CLI flow, and verifies delivery between their actual local daemon APIs. On Linux with root network-namespace privileges, `test/routed-peer-namespace-e2e.test.mjs` further places those processes in separate peer namespaces on distinct IP subnets and routes their invite and message traffic through a third forwarding namespace; it skips where namespace privileges are unavailable.

The routed namespace test can also be run directly on Linux as root with `CAP_NET_ADMIN`:

```sh
node test/manual-routed-peer-e2e.mjs
```

It uses isolated network stacks and an explicit L3 router; it is a routing-topology integration test, not a test on two physical computers. It asserts that each peer runs under its own hostname and PID namespace, that no peer endpoint is a loopback address, and that the router's two veth legs each carried bytes during pairing and delivery, so the traffic provably crossed an L3 hop instead of staying inside one stack.

### Two-machine check

When two directly reachable computers are available, the same user-facing commands exercise the routed path across hosts. On host A:

```sh
xats-setup peer run --bind :: --port 9443 --no-mdns   # terminal 1
xats-setup peer invite --endpoint https://<A-address>:9443 --out peer.invite
```

Transfer `peer.invite` to host B over an out-of-band private channel and delete it afterwards; it is short-lived and single-use. On host B:

```sh
xats-setup peer run --bind :: --port 9444 --no-mdns   # terminal 1
xats-setup peer pair --invite-file peer.invite --endpoint https://<B-address>:9444 --label host-a
```

While the join waits, approve the request on host A (explicit approval is mandatory):

```sh
xats-setup peer pending
xats-setup peer approve <PENDING_ID> --label host-b
xats-setup peer peers  # both hosts: expect "connected" and a non-zero agent count
```

Only `<A-address>:9443` needs to be reachable from B for the invite, and `<B-address>:9444` from A for federation. The local daemon APIs stay bound to loopback on both hosts; only the peer listener is exposed. The invite file, device keys, and trust stores must never be shared.

The same check runs as one command per machine, which also starts a bundled daemon, registers a local agent, and verifies message exchange in both directions:

```sh
node test/manual-cross-host-peer-e2e.mjs host --advertise <A-address> --invite-file peer.invite
node test/manual-cross-host-peer-e2e.mjs join --advertise <B-address> --invite-file peer.invite
```

The host prints the pending id and waits; approval is an explicit `xats-setup peer approve <PENDING_ID> --label remote-host`. Each side ends with a JSON result containing the paired device id, the message it received, and `filament: false`.

For a live LAN multicast check using the real `bonjour-service` browser and advertiser, run:

```sh
node test/manual-peer-mdns-e2e.mjs
```

For end-to-end delivery using two actual xats daemon processes and the user-facing invite/approval CLI, run:

```sh
node test/manual-peer-real-daemon-e2e.mjs
```

The script runs the bundled patched daemon asset and its pinned test-only dependencies, so it does not require a separately installed daemon. It binds peer listeners on `::`, connects to a non-loopback interface address, and does not use Filament/Tunlion.

## Build and verification sequence

1. **Complete:** define identity, invite, TLS pinning, request signing, replay controls, trust storage, endpoints, and bind policy.
2. **Complete:** implement the dedicated HTTPS peer service and loopback-only control interface; paired requests require signatures and pinned TLS.
3. **Complete:** install and run candidate-only mDNS, invite create/accept, explicit approval, peer list/status/revoke; malformed and duplicate discovery records are covered by tests.
4. **Complete:** federate sanitized rosters and agent messages over paired transport; test duplicate/replay handling, disconnect/reconnect, and revocation across two peer runtimes and a real local daemon.
5. **Complete:** keep the peer service opt-in; integrate cross-platform service enable/start/stop/disable, update restart, reset, shadow cleanup, and user docs. Automated pairing, pinned-HTTPS federation, real-daemon CLI, and routed-network-namespace tests exercise these flows. Test results are not evidence of a physical two-host or general Internet-federation deployment; use the documented two-machine procedure for that separate live check.

## Stage boundaries

Stage 1 covers direct IP reachability only. It must not depend on Filament/Tunlion. Stage 2 may add Filament/Tunlion for paths where direct connections are unavailable. Signed per-message envelopes, recipient-sealed relays, and durable revocation tombstones are not current Stage 1 guarantees.
