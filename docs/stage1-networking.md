# Stage 1: Secure xats peer networking

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

## Identity, TLS, invite, and authentication

- Each instance has a persistent Ed25519 signing key. `deviceId` is the first 128 bits of SHA-256 over its DER SubjectPublicKeyInfo. The private key is stored owner-only in the xats state directory.
- The peer service uses HTTPS with a persistent self-signed TLS certificate. Its SHA-256 certificate fingerprint is bound to the Ed25519 identity in the pairing exchange and pinned in each peer record. Client verification must compare the pinned fingerprint; it must not disable TLS verification globally.
- A version-1 invite contains: invite id (128 random bits), issue/expiry timestamps (expiry no more than 10 minutes), inviter device id/public key, reachable endpoint, and TLS certificate fingerprint. The inviter signs a canonical representation. A separate 256-bit random secret is delivered in the invite payload and is never sent in plaintext over the network or written to logs. The invite is invalidated after approval, denial, expiry, or explicit cancellation.
- A pair request includes the invite id, a fresh 128-bit nonce, requester device id/public key, requester TLS fingerprint, an Ed25519 signature over canonical request fields, and HMAC-SHA-256 over those fields keyed by the invite secret. For LAN candidate pairing without a pre-shared invite, the candidate may request pairing without the HMAC, but still proves possession of its Ed25519 private key; the remote user must approve.
- A valid request creates only a pending candidate. Approval is the only operation that writes a peer into the trust store. Rejecting/denying consumes the related invite. Duplicate nonces, expired invites, malformed keys, mismatched device ids, and replayed request ids are rejected.
- After pairing, each network request is sent over TLS pinned to the peer certificate and carries a signature by the paired Ed25519 key over method, versioned path, timestamp, nonce/request id, and body hash. Enforce a bounded timestamp window and replay cache. Message IDs are idempotent across retries.
- Each peer has per-peer authorization and rate/size limits. No shared fleet-wide bearer token. Revocation immediately removes that peer's authorization and reconnect state.

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

- `assets/daemon/cli.js` owns the local bus and defaults to loopback; preserve this boundary.
- `assets/bridge/bridge.mjs` relays rosters/messages but its HTTP peer listener is loopback-only and is designed for the Filament bridge. Do not simply change its bind address or reuse its HTTP endpoints as a public Stage 1 API. Reuse/port only the relay semantics behind the new authenticated peer service.
- `lib/peer-identity.mjs`, `lib/peer-pairing.mjs`, and `lib/peer-tls.mjs` implement Ed25519 identity, expiring signed invites bound to an HTTPS endpoint/certificate, one-use pairing proofs, inviter-side pending/approve/deny/revoke state, pinned TLS identities, and owner-only persistence.
- `lib/peer-transport.mjs` implements a standalone HTTPS peer listener/client, identity-signed requests, TLS pin verification, replay protection, candidate info verification, request limits, and handler hooks. It has security-focused loopback tests but is not wired to the installer or daemon relay yet.
- `lib/mdns-discovery.mjs` currently advertises/browses candidate-only records via `bonjour-service`; it is a tested helper but is not installed, started, or wired into the peer listener.
- The installer/service/reset lifecycle does not yet manage a Stage 1 peer process. Network peer networking must be explicitly enabled and have update/reset behavior.

## Build and verification sequence

1. Define and version identity, invite, TLS pinning, request signing, replay controls, trust storage, endpoints, and bind policy. No listener before this design is implemented.
2. Implement a dedicated HTTPS peer service and local-only admin/control interface. Verify unknown peers cannot retrieve rosters or relay messages; verify paired requests require valid signatures and pinned TLS.
3. Wire discovery and pairing UX: install `bonjour-service`, advertise/browse, candidate request, short-lived invite share/accept, explicit approval, list/status/revoke. Test stale/duplicate records and multicast unavailable behavior.
4. Connect paired transport to local daemon/relay semantics; test roster and message exchange between two independent xats instances, duplicate delivery, disconnect/reconnect, and revocation.
5. Integrate opt-in enablement, cross-platform lifecycle, update/reset, docs, and end-to-end checks on Linux/macOS/Windows.

## Stage boundaries

Stage 1 covers direct IP reachability only. It must not depend on Filament/Tunlion. Stage 2 may add Filament/Tunlion for paths where direct connections are unavailable, without weakening Stage 1 identity, approval, encryption, or revocation guarantees.
