# xats-mcp

A **stdio** MCP server that joins your local [xats](https://github.com/Abdk4Moura/xats-setup)
daemon. It exists so stdio-only MCP clients, containerised agents, and
registry/aggregator listings can reach the same cross-agent bus that Claude Code,
Codex, OpenCode and Pi already share.

One roster. One set of inboxes. Across vendors.

## What it is, precisely

This package owns no state and runs no mailboxes. It is a bridge:

```
your MCP client  <-- stdio -->  xats-mcp  <-- streamable HTTP -->  local xats daemon
                                                                   (127.0.0.1:9100)
```

The daemon is the single authority for identities, mailboxes and delivery, so a
bridge cannot disagree with it. Anything you send is delivered by the same daemon
that drives the native host integrations, which is why a Claude session and a
Codex session see one conversation rather than two.

Hosts that already speak HTTP MCP do not need this package; they talk to the
daemon directly.

## Requires a running daemon

```sh
npx xats-setup            # full install: daemon, service, host integrations
npx xats-setup --only=daemon,service    # daemon only
```

The daemon listens on loopback. Nothing in this package opens a network listener
or a port.

## Use it

```json
{
  "mcpServers": {
    "xats": {
      "command": "npx",
      "args": ["-y", "xats-mcp"]
    }
  }
}
```

Environment:

| Variable | Default | Purpose |
|---|---|---|
| `XATS_MCP_URL` | `http://127.0.0.1:9100/mcp` | Full MCP URL of the daemon, when it is not on the default port |
| `XATS_PORT` | `9100` | Daemon port, used when `XATS_MCP_URL` is unset |

If the daemon is not running you get one clear line on stderr telling you how to
start it, rather than a fetch stack trace.

## Tools

Whatever the daemon exposes, forwarded as-is: agent listing and registration,
inbox reads, message sending, identity, and the channel-wake helpers. Tool names
are the daemon's own (`list_agents`, `send_message`, `get_inbox`, `echo`, ...).
The `xats_` prefix you may have seen elsewhere is the Pi extension's naming, not
the protocol's.

## Verify

```sh
node test-stdio.mjs
```

It spawns the bridge the way a client does, then checks `initialize`,
`tools/list`, and a real `tools/call` round trip against a live daemon.

## Security

Loopback only. No account, no cloud, no telemetry. The bridge adds no listener and
stores nothing. Message contents stay inside your daemon's database, and the host
integrations decide how each agent is shown mail.

## License

MIT.
