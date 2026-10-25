# Security model

What Cross-Agent Teams protects, what it does not, and what a user decides when
pairing a peer. This release builds on the earlier xats work, with substantial
changes to the daemon, agent integrations, identity, and optional direct-peer
transport. The npm installer remains `xats-setup`; older internal names such as
`cross-agent-teams-mcp` remain for compatibility.

## The short version

- The local agent bus is bound to loopback. It is not exposed to the network by
default. Enabling the separate peer service is an explicit network-listening
choice.
- Discovery finds candidates; it does not grant trust. A new peer still needs
explicit approval. The current runtime requires manual approval even if saved
configuration says `shared` or `open`; automatic approval for those modes is not
implemented.
- Paired peers communicate directly over HTTPS. Requests are authenticated
with the peer's Ed25519 key and TLS is pinned to the paired certificate. This
is not a signed per-message envelope or a sealed relay protocol.
- Peer messages are untrusted input, like email or a web page. Pairing says you
recognize the peer, not that its messages are safe.

## Trust boundaries

| Boundary | What the implementation provides |
|---|---|
| Network → local agent bus | The daemon binds to loopback. The separate peer listener is disabled until explicitly enabled. Loopback is not a per-user access-control boundary against other local processes. |
| Network → peer listener | Direct HTTPS, pinned peer TLS certificates, and Ed25519 signatures on paired-peer requests. Request timestamps and nonces are checked to limit replay. |
| Discovery → trust | mDNS and invites identify candidates only. A human approval is required before the peer is added to the local trust store. |
| Paired peer → agents | Only a currently trusted peer can make authenticated federation requests. The message body is still untrusted model input. |
| Relay → messages | No relay service or sealed-relay mode is shipped. Stage 1 connects peers directly. |
| Peer → your files | xats transports messages and rosters; it does not provide file transfer. What an agent does with message content is outside the transport boundary. |

The peer request signature covers the HTTP method, versioned path, timestamp,
nonce, and body hash. TLS protects the direct connection and the peer certificate
is pinned. Messages are not independently signed and encrypted as durable,
recipient-sealed objects; do not describe transport authentication as end-to-end
message-envelope security.

## Pairing and saved approval policy

The supported approval behavior today is **manual**: a candidate request becomes
pending, and a user explicitly approves or denies it. Discovery alone never adds
a trusted peer.

The peer config parser accepts and saves `autoApprove: manual|shared|open`, and a
policy helper exists, but the pairing runtime does not call that helper. Thus
`shared` and `open` do **not** currently auto-approve peers. Leave the setting at
`manual`; do not rely on the other values to change pairing behavior.

Pairing invites are short-lived credentials used to establish a candidate
connection. Keep them private and delete them after use. Possession of an invite
is not itself trust: the inviter still approves the pending request.

## Revocation

Revoking a peer removes its local trust record, stops federation/reconnect state,
and causes subsequent requests from that peer to be rejected by this instance.
Revocation is local, not a permanent global denylist: a peer could be paired
again if a new request is made and a user explicitly approves it. Do not claim
that a revoked key can never be accepted again.

## Prompt injection: the honest position

A peer message can enter an agent's context. If that agent can use tools, a
malicious message may influence actions. The transport cannot make the content
safe:

- Only currently paired peers can send federation traffic.
- Host integrations label incoming notices as peer mail. This attribution helps
  identify the source; it is not a model sandbox or a security policy.
- Integrations avoid disguising peer mail as text typed by the user. Claude's
  mod uses an attributed plugin prompt; other hosts use their own notice/context
  mechanisms. A queued notice does not imply an in-flight task is interrupted.
- Message-size limits bound request size, not the semantic risk of a message.

Treat peer approval as granting a collaborator the ability to place text in an
agent's working context. Review tool permissions and the agent's behavior
accordingly.

## What is out of scope

- A compromised local account or malicious local process. The loopback service is
  not an isolation boundary between users or processes on the same host.
- A malicious approved peer, or prompt injection through a peer's content.
- Denial of service by an approved peer. Request and body limits reduce some
  resource risks but do not prevent all service disruption.
- Peer connectivity when direct IP traffic is blocked by NAT, firewall, or
  routing. Stage 1 does not tunnel around those restrictions.
- Per-message signatures, recipient-sealed relays, offline/internet federation,
  and automatic approval for `shared`/`open`; these are not shipped capabilities.

## Reporting

Report security issues privately through the repository's security advisory
process rather than a public issue. Include the package/build revision, platform,
and the local or peer delivery path involved. The daemon's `/health` version is
currently a static daemon version string; do not use it as proof of the npm
package version.
