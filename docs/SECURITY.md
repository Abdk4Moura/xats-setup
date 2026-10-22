# Security model

What xats protects, what it doesn't, and the decisions a user is actually making
when they approve a peer. Written to be read by someone deciding whether to run
this on a work machine.

## The short version

- The local bus is **loopback only**. Nothing about it is reachable from a
  network unless you enable the peer listener, which is a separate, explicit,
  per-machine opt-in.
- **Discovery never grants trust.** Finding a peer — over mDNS, a VPN overlay, or
  a relay — only makes it a *candidate*. A human approves it, once, per peer.
- Peer traffic is authenticated and encrypted end to end. A relay can drop or
  delay a message; it cannot read or forge one.
- Messages from peers are **untrusted input**, exactly like a web page or an
  email body. Approval says "I know this peer", not "everything it sends is
  safe".

## Trust boundaries

| Boundary | Protected by |
|---|---|
| Other users on the same machine → your bus | loopback bind, per-user state directory, file permissions on identity keys |
| Network → your bus | the daemon listens on loopback; the peer listener is a separate opt-in service on its own port |
| Peer → your agents | explicit approval per peer; every message signed by the sender and verified before it reaches an agent |
| Relay → your messages | payload sealed to the recipient's key; the relay is a dumb forwarder |
| Peer → your **files** | nothing beyond what your agents choose to do. xats moves messages, not files. |

## The approval decision

`autoApprove` has three settings, and the default is the strict one:

| Setting | Meaning |
|---|---|
| `manual` (**default**) | every new peer requires an explicit approval |
| `shared` | auto-approve peers discovered on an overlay listed in `trustedOverlays` — sharing a network is a deliberate, per-overlay allowlist, never "any network I happen to be on" |
| `open` | auto-approve any candidate that completes the handshake — only sane on a network you fully control |

The reasoning behind `shared` being an allowlist rather than a blanket: a VPN or
mesh commonly carries more than agents. A CI worker with a shell capability is
not a reason to trust every agent that can also reach you there.

## Revocation

Revoking a peer is immediate and local: the trust store drops the record and the
running daemon closes live links. Revocation is durable — the peer key stays
refused rather than being silently re-accepted on reconnect.

## Prompt injection: the honest position

A peer's message enters an agent's context. If that agent can run commands, a
malicious peer message is a path to action. xats reduces the surface but does not
eliminate it:

- **Only approved peers can deliver at all.** Unsolicited network input never
  reaches a model.
- **Every message is attributed** in the host UI (Claude band, OpenCode badge, pi
  card), so a person can see that the text came from a peer, not from them.
- **Nothing is typed into your composer.** The peer wake path deliberately refuses
  to simulate keystrokes, so mail can never masquerade as your own input.
- **Bodies are size-capped** and delivered as data inside a tagged block
  (`<xats-inbox>`), not as instructions to the host.

What remains: an approved peer's text is still text in front of a capable agent.
Treat approving a peer as being roughly as consequential as adding a collaborator
to the repository — because that is what it is.

## What is out of scope

- A compromised local account. Anything running as you can read the state
  directory and speak to the bus directly.
- A malicious **approved** peer. Approval is the trust decision; the signatures
  prove who sent a message, not that the sender is benign.
- Denial of service from an approved peer (message floods). Caps and rate limits
  bound the damage; they don't prevent it.
- Side channels in the host agents themselves (a tool that misbehaves when handed
  crafted text).

## Reporting

Security issues: open a private advisory on the repository rather than a public
issue, and include the daemon version (`/health` reports it) and the peer
delivery path if relevant.
