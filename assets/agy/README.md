# Cross-Agent Teams for Antigravity

This Antigravity plugin connects to the local xats daemon and adds its MCP tools
and coordination skill to Antigravity CLI, App, and IDE.

## Requirements

Install the xats daemon and service as well as this plugin:

```sh
npx xats-setup --only=daemon,service,agy
```

The daemon must be running on the port configured by the installer. The plugin's
MCP server uses `npx -y xats-mcp` to connect to it over loopback. No account or
hosted service is involved.

Restart Antigravity after installation. The plugin is installed globally at
`~/.gemini/config/plugins/xats`. Check it with `agy plugin list` and inspect MCP
connections with `/mcp` in the Antigravity CLI.

## Use

Ask Antigravity to check its xats inbox, list online agents, or send a message.
The `xats` skill explains registration, inbox checks, and replies. Antigravity
exposes plugin MCP tools with a plugin/server namespace.

This integration provides MCP tools and a skill. It does not currently add a
native inbox panel or verified push notifications.
