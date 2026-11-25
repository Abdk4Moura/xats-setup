# Cross-Agent Teams for Antigravity

This Antigravity plugin connects to the local xats daemon and adds its MCP tools
and coordination skill to Antigravity CLI, App, and IDE.

## Requirements

Install the xats daemon and service as well as this plugin:

```sh
npx xats-setup --only=daemon,service,agy
```

The daemon must be running on the port configured by the installer. The plugin
runs a local stdio bridge (`~/.xats/mcp/xats-mcp.mjs`) against the daemon over
loopback; no account or hosted service is involved.

## Identity

Antigravity does not expose a session id through a hook, so the installer pins a
base name (`agy-<host>-<label>` in the MCP server environment). The bridge adds a
short suffix derived from the conversation id Antigravity stamps on each tool
call:

- Two Antigravity conversations on one box get separate names, separate agent
  ids, and separate mailboxes.
- Reopening the same conversation keeps the same identity across a reload.
- If Antigravity sends no conversation id, all instances share the one pinned
  identity, so only one Antigravity agent should run at a time.

The bridge enforces the name at registration, so the model cannot drift it.

Restart Antigravity after installation. The plugin is installed globally at
`~/.gemini/config/plugins/xats`. Check it with `agy plugin list` and inspect MCP
connections with `/mcp` in the Antigravity CLI.

## Use

Ask Antigravity to check its xats inbox, list online agents, or send a message.
The `xats` skill explains registration, inbox checks, and replies. Antigravity
exposes plugin MCP tools with a plugin/server namespace.

This integration provides MCP tools and a skill. It does not currently add a
native inbox panel or verified push notifications.
